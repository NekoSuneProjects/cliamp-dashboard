import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import sharp from 'sharp';
import {svgBackground,retainArtwork} from './radio-layout.js';
import {resolveCover} from './radio-artwork.js';
import {cdCasePlaceholder} from './radio-placeholder.js';
import {teeOutput,redactPublishingURLs} from './stream-destinations.js';

const safe = value => String(value ?? '').replace(/[<>&"']/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const clip=(s,n)=>Array.from(String(s||'')).slice(0,n).join('');
const validId=s=>/^[a-z0-9-]{1,64}$/.test(s);
const logSafe=redactPublishingURLs;
const maxArt=4*1024*1024;

async function fetchJSON(url,signal) {
 const response=await fetch(url,{signal,headers:{accept:'application/json'},redirect:'error'});
 if(!response.ok)throw Error('CLIAMP API status '+response.status);
 const body=await response.text();
 if(body.length>1_000_000)throw Error('CLIAMP API response too large');
 return JSON.parse(body);
}
export async function discover(baseURL,signal) {
 const base=new URL(baseURL);
 if(!['http:','https:'].includes(base.protocol))throw Error('CLIAMP_BASE_URL must be HTTP(S)');
 const result=await fetchJSON(new URL('/api/v1/radios',base),signal);
 if(!Array.isArray(result.radios))throw Error('CLIAMP API returned no radios array');
 return result.radios.filter(s=>validId(s.id)).map(s=>({
  id:s.id,name:s.name||s.id,online:s.online===true,
  audioUrl:new URL('/'+s.id+'/stream',base).href,
  artUrl:new URL('/'+s.id+'/art.png',base).href,
  nowPlaying:s.now_playing||{},listeners:s.listeners||0
 }));
}
async function render(s,track,artBuffer){
 const base=sharp(svgBackground(s,track)).png();
 const overlays=[];
 const fallbackCover=cdCasePlaceholder();
 if(!artBuffer){
  overlays.push({input:fallbackCover,left:100,top:170});
 }
 if(artBuffer){
  try{
   const cover=await sharp(artBuffer,{limitInputPixels:12_000_000}).resize(390,390,{fit:'contain',background:'#182337'}).png().toBuffer();
   overlays.push({input:cover,left:100,top:170});
  }catch{overlays.push({input:fallbackCover,left:100,top:170});} // Malformed cover bytes must not leave an empty area.
 }
 return base.composite(overlays).jpeg({quality:83,mozjpeg:false}).toBuffer();
}
export class RadioWorker {
 constructor(station,baseURL,onUpdate){
  this.station=station;this.baseURL=baseURL;this.onUpdate=onUpdate;
  this.running=false;this.ff=null;this.abort=null;this.loop=null;
  this.lastTrack=null;this.lastArt=null;this.lastArtFetch=0;
  this.state={status:'stopped',error:null,restarts:0,updatedAt:null};
 }
 publish(state){this.state={...this.state,...state};this.onUpdate(this.station.id,this.state);}
 async start(){
  if(this.running)throw Error('Already running');
  if(!this.station.destinations.some(d=>d.enabled&&d.url))throw Error('No enabled RTMP/SRT destinations');
  this.running=true;this.abort=new AbortController();
  this.loop=this.supervise().catch(e=>this.publish({status:'error',error:e.message}));
  return this.state;
 }
 async stop(){
  this.running=false;this.abort?.abort();
  if(this.ff){this.ff.kill('SIGTERM');}
  await Promise.race([this.loop||Promise.resolve(),sleep(2000)]);
  if(this.ff){this.ff.kill('SIGKILL');}
  this.publish({status:'stopped',error:null});
 }
 async supervise(){
  let retries=0;
  while(this.running){
   try {
    await this.encode();
    if(this.running)throw Error('FFmpeg unexpectedly exited');
   }catch(e){
    if(!this.running)break;
    this.publish({status:'reconnecting',error:logSafe(e.message),restarts:++retries});
    await sleep(Math.min(30000,1000*2**Math.min(retries,5)),undefined,{signal:this.abort.signal}).catch(()=>{});
   }
  }
 }
 async encode(){
  const s=this.station, destinations=s.destinations.filter(d=>d.enabled&&d.url);
  if(!destinations.length)throw Error('No enabled publishing destinations');
  const fps=Number(s.fps)||1, bitrate=Number(s.bitrate)||1500;
  const args=['-hide_banner','-nostdin','-loglevel','warning',
   '-thread_queue_size','16','-f','image2pipe','-framerate',String(fps),'-c:v','mjpeg','-i','pipe:0',
   '-thread_queue_size','512','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5','-i',s.audioUrl,
   '-map','0:v:0','-map','1:a:0',
   '-c:v','libx264','-preset','ultrafast','-tune','stillimage','-pix_fmt','yuv420p','-r',String(fps),
   '-g',String(Math.max(2,fps*2)),'-b:v',bitrate+'k','-maxrate',bitrate+'k','-bufsize',(bitrate*2)+'k',
   '-c:a','aac','-b:a','128k','-ar','44100','-ac','2',
   '-f','tee',teeOutput(destinations)];
  const ff=spawn('ffmpeg',args,{stdio:['pipe','ignore','pipe']});
  this.ff=ff;this.publish({status:'starting',error:null});
  let lines='';
  ff.stderr.on('data',data=>{lines=logSafe((lines+String(data)).slice(-3000));});
  ff.stdin.on('error',()=>{}); // Broken pipe during worker shutdown or reconnect.
  const exit=new Promise((resolve,reject)=>{
   ff.once('error',reject);
   ff.once('exit',(code,signal)=>resolve({code,signal}));
  });
  let frame=await render(s,this.lastTrack||{},this.lastArt);
  const update=async()=>{
   if(!this.running)return;
   try {
    const sourceId=s.sourceId||new URL(s.audioUrl).pathname.split('/')[1];
    const data=await fetchJSON(new URL('/api/v1/radios/'+sourceId,this.baseURL),AbortSignal.timeout(5000));
    const reported=data.now_playing||{};
    const title=typeof reported.title==='string'?reported.title.trim():'';
    const artist=typeof reported.artist==='string'?reported.artist.trim():'';
    // A momentarily empty metadata response must not clear the displayed title.
    const track=(title||artist)?{title,artist}:this.lastTrack||{};
    const old=this.lastTrack||{};
    const trackChanged=track.title!==old.title||track.artist!==old.artist;
    const now=Date.now();
    const due=trackChanged||now-this.lastArtFetch>=30000;
    let artChanged=false;
    if(due){
     // Record the attempt so temporary errors retry later without clearing art.
     this.lastArtFetch=now;
     const resolved=await resolveCover({
      baseURL:this.baseURL,sourceId,artist:track.artist,title:track.title,
      previous:this.lastArt,signal:AbortSignal.timeout(8000)
     });
     if(resolved.buffer && (resolved.buffer!==this.lastArt || !this.lastTrack)){
      this.lastArt=retainArtwork(this.lastArt,resolved.buffer);
      artChanged=true;
     }
     this.publish({artworkSource:resolved.source,artworkError:resolved.source==='placeholder'?'No song cover available yet':null});
    }
    if(trackChanged||artChanged){
     // Keep the last successfully rendered frame until the new one is ready.
     const nextFrame=await render(s,track,this.lastArt);
     frame=nextFrame;
     this.lastTrack=track;
    }
    if(trackChanged||artChanged)this.publish({track:{title:track.title||'',artist:track.artist||''},updatedAt:new Date().toISOString()});
   }catch(e){this.publish({metadataError:e.message});}
  };
  await update();
  try{
   // Timestamp cadence lives in the worker; cached JPEG is only recomputed on metadata/art changes.
   const frameLoop=(async()=>{
    let count=0;
    while(this.running && this.ff===ff && !ff.stdin.destroyed){
     if(count++ % Math.max(1,fps*5)===0 && !this.metadataPending){this.metadataPending=true;void update().finally(()=>{this.metadataPending=false;});}
     if(!ff.stdin.write(frame))await Promise.race([new Promise(resolve=>{ff.stdin.once('drain',resolve);ff.stdin.once('close',resolve);ff.stdin.once('error',resolve);}),sleep(1500)]);
     if(count===1)this.publish({status:'running',error:null});
     await sleep(Math.round(1000/fps),undefined,{signal:this.abort.signal}).catch(()=>{});
     if(this.abort.signal.aborted)break;
    }
   })().catch(()=>{});
   const out=await exit;
   this.ff=null;
   ff.stdin.destroy();
   await Promise.race([frameLoop,sleep(100)]);
   if(this.running){
    const hint=/All tee outputs failed|Invalid argument|Error muxing a packet/i.test(lines)
      ?'No publishing destination accepted the stream. Check RTMP/RTMPS ingest keys, RTSP ANNOUNCE server support, SRT listening port, and FFmpeg protocol settings. '
      :'';
    throw Error(hint+'FFmpeg exited '+(out.code??out.signal)+' '+lines.slice(-1500));
   }
  }finally{
   if(this.ff===ff)this.ff=null;
   if(ff.exitCode===null)ff.kill('SIGTERM');
  }
 }
}
