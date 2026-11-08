import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import sharp from 'sharp';
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
async function artwork(baseURL,stationId,signal){
 const u=new URL('/'+stationId+'/art.png',baseURL);
 const response=await fetch(u,{signal,redirect:'error'});
 if(response.status===404)return null;
 if(!response.ok)throw Error('Artwork HTTP '+response.status);
 if(!String(response.headers.get('content-type')||'').includes('image/'))throw Error('Artwork is not an image');
 const len=Number(response.headers.get('content-length')||0);
 if(len>maxArt)throw Error('Artwork too large');
 let size=0;const parts=[];
 for await(const chunk of response.body){
  size+=chunk.length;
  if(size>maxArt){await response.body.cancel().catch(()=>{});throw Error('Artwork too large');}
  parts.push(chunk);
 }
 return Buffer.concat(parts);
}
function svgBackground(s,track){
 const title=safe(clip(track.title||'Live Radio',72));
 const artist=safe(clip(track.artist||s.name,72));
 const station=safe(clip(s.name,65));
 const subtitle=safe(clip(s.tagline||'LIVE RADIO',60));
 return Buffer.from('<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#273469"/></linearGradient></defs><rect width="1280" height="720" fill="url(#bg)"/><rect x="64" y="68" width="1152" height="584" rx="32" fill="#0f172acc"/><text x="540" y="180" font-family="DejaVu Sans,sans-serif" font-size="35" fill="#70e7c4">'+station+'</text><text x="540" y="258" font-family="DejaVu Sans,sans-serif" font-size="22" fill="#b8c5da">'+subtitle+'</text><text x="540" y="390" font-family="DejaVu Sans,sans-serif" font-size="33" fill="#ffffff">'+title+'</text><text x="540" y="445" font-family="DejaVu Sans,sans-serif" font-size="26" fill="#b8c5da">'+artist+'</text><circle cx="1110" cy="170" r="12" fill="#ff5266"/><text x="1136" y="180" font-family="DejaVu Sans,sans-serif" font-size="24" fill="white">LIVE</text></svg>');
}
async function render(s,track,artBuffer){
 const base=sharp(svgBackground(s,track)).png();
 const overlays=[];
 if(artBuffer){
  try{
   const cover=await sharp(artBuffer,{limitInputPixels:12_000_000}).resize(390,390,{fit:'contain',background:'#182337'}).png().toBuffer();
   overlays.push({input:cover,left:100,top:170});
  }catch{} // Bad or missing artwork must not interrupt the radio.
 }
 return base.composite(overlays).jpeg({quality:83,mozjpeg:false}).toBuffer();
}
export class RadioWorker {
 constructor(station,baseURL,onUpdate){
  this.station=station;this.baseURL=baseURL;this.onUpdate=onUpdate;
  this.running=false;this.ff=null;this.abort=null;this.loop=null;
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
  if(!destinations.length)throw Error('No enabled RTMP destinations');
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
  let frame=await render(s,{},null),lastKey='',lastArtFetch=0;
  const update=async()=>{
   if(!this.running)return;
   try {
    const data=await fetchJSON(new URL('/api/v1/radios/'+s.sourceId,this.baseURL),AbortSignal.timeout(5000));
    const track=data.now_playing||{};
    const key=[track.title,track.artist].join('|');
    const now=Date.now();
    if(key!==lastKey || now-lastArtFetch>30000){
     lastKey=key;lastArtFetch=now;
     const art=await artwork(this.baseURL,s.sourceId,AbortSignal.timeout(5000)).catch(()=>null);
     frame=await render(s,track,art);
     this.publish({track:{title:track.title||'',artist:track.artist||''},updatedAt:new Date().toISOString()});
    }
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
     await sleep(Math.round(1000/fps),undefined,{signal:this.abort.signal}).catch(()=>{});
     if(this.abort.signal.aborted)break;
    }
   })().catch(()=>{});
   const out=await exit;
   this.ff=null;
   ff.stdin.destroy();
   await Promise.race([frameLoop,sleep(100)]);
   if(this.running)throw Error('FFmpeg exited '+(out.code??out.signal)+' '+lines.slice(-550));
  }finally{
   if(this.ff===ff)this.ff=null;
   if(ff.exitCode===null)ff.kill('SIGTERM');
  }
 }
}
