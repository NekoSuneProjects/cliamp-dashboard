import http from 'node:http';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {RadioWorker,discover} from './radio-worker.js';
import {sourceIdFor,readMetadata} from './station-metadata.js';
import {validatePublishingUrl,outputProtocol} from './stream-destinations.js';

const PORT=Number(process.env.PORT||8096),DIR=process.env.DATA_DIR||'./data';
const STORE=join(DIR,'stations.json'),BASE=process.env.CLIAMP_BASE_URL||'';
const USER=process.env.DASHBOARD_USER||'',PASS=process.env.DASHBOARD_PASSWORD||'';
if(!USER||!PASS){console.error('Configure DASHBOARD_USER and DASHBOARD_PASSWORD');process.exit(1);}
const workers=new Map(),statuses=new Map(),metadata=new Map();
let metadataRefreshBusy=false;
let config=[];
function auth(req){
 const expected=Buffer.from('Basic '+Buffer.from(USER+':'+PASS).toString('base64'));
 const given=Buffer.from(req.headers.authorization||'');
 return expected.length===given.length&&timingSafeEqual(expected,given);
}
function reply(res,code,obj){
 res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
 res.end(JSON.stringify(obj));
}
function publicStation(s){
 const state=statuses.get(s.id)||{status:'stopped'};
 const live=metadata.get(s.id);
 const currentTrack=live?.track?.title||live?.track?.artist?live.track:state.track;
 return {id:s.id,sourceId:s.sourceId||'',name:s.name,tagline:s.tagline||'',audioUrl:s.audioUrl,
 fps:s.fps,bitrate:s.bitrate,autoStart:!!s.autoStart,
 destinations:s.destinations.map(d=>({id:d.id,name:d.name,protocol:d.protocol||outputProtocol(d),enabled:d.enabled,configured:!!d.url})),...state,
 track:currentTrack||null,metadataStatus:live?.status||'checking',metadataError:live?.error||null,metadataUpdatedAt:live?.updatedAt||null};
}
function checkURL(value,protocols){
 const u=new URL(String(value||''));
 if(!protocols.includes(u.protocol)||u.username||u.password)throw Error('Invalid stream URL');
 return u.href;
}
function validate(x,old){
 if(!x||typeof x!=='object')throw Error('Invalid station');
 const name=String(x.name||'').trim(),tagline=String(x.tagline||'').trim();
 if(!name||name.length>90||tagline.length>80)throw Error('Invalid station name or tagline');
 const sourceId=String(x.sourceId||'').trim();
 if(sourceId&&!/^[a-z0-9-]{1,64}$/.test(sourceId))throw Error('Invalid CLIAMP station ID');
 const audioUrl=checkURL(x.audioUrl,['http:','https:']);
 const fps=Number(x.fps??1),bitrate=Number(x.bitrate??1500);
 if(![1,2,5,10,15,20,25,30].includes(fps)||!Number.isInteger(bitrate)||bitrate<300||bitrate>6000)throw Error('Invalid FPS or bitrate');
 if(!Array.isArray(x.destinations)||x.destinations.length>12)throw Error('Maximum 12 destinations');
 const destinations=x.destinations.map(d=>{
  const previous=old?.destinations.find(p=>p.id===d.id);
  const url=String(d.url||'').trim()||previous?.url||'';
  const name=String(d.name||'').trim();
  if(!name||name.length>90)throw Error('Destination name required');
  // Retain the protocol of saved destinations when the secret URL field is blank.
  const requestedProtocol=String(d.protocol||previous?.protocol||'').toLowerCase();
  const validated=url?validatePublishingUrl(url,requestedProtocol):null;
  const protocol=validated?.protocol||requestedProtocol||'rtmp';
  if(!['rtmp','rtmps','srt','rtsp','rtspt'].includes(protocol))throw Error('Invalid destination protocol');
  return {id:previous?.id||randomUUID(),name,url:validated?.url||'',protocol,enabled:d.enabled!==false};
 });
 return {id:old?.id||randomUUID(),name,tagline,sourceId,audioUrl,fps,bitrate,autoStart:x.autoStart===true,destinations};
}
async function persist(){
 await mkdir(DIR,{recursive:true});
 const tmp=STORE+'.tmp';await writeFile(tmp,JSON.stringify(config,null,2),{mode:0o600});
 await rename(tmp,STORE);
}
async function body(req){
 let data='',bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>100_000)throw Error('Body too large');data+=chunk;}
 return JSON.parse(data||'{}');
}
async function stop(id){
 const w=workers.get(id);if(!w)return;
 workers.delete(id);await w.stop();statuses.set(id,{status:'stopped'});
}
async function start(s){
 if(workers.has(s.id))throw Error('Station already running');
 const w=new RadioWorker(s,BASE,(id,state)=>{if(workers.get(id)===w)statuses.set(id,state)});
 workers.set(s.id,w);
 try{await w.start()}catch(e){workers.delete(s.id);throw e}
}
// Poll CLIAMP independently of FFmpeg; music may play while an RTMP worker is stopped.
async function refreshMetadata(){
 if(metadataRefreshBusy||!BASE)return;
 metadataRefreshBusy=true;
 try{
  await Promise.all(config.map(async s=>{
   const sourceId=sourceIdFor(s,BASE);
   if(!sourceId){
    metadata.set(s.id,{status:'unconfigured',error:'Set a CLIAMP station ID or use an audio URL from the configured CLIAMP server.'});
    return;
   }
   try{
    const info=await readMetadata(BASE,sourceId,AbortSignal.timeout(6000));
    metadata.set(s.id,{status:info.title||info.artist?'connected':'no-track',
      track:{title:info.title,artist:info.artist,album:info.album},
      online:info.online,error:null,updatedAt:new Date().toISOString()});
   }catch(error){
    const old=metadata.get(s.id)||{};
    metadata.set(s.id,{...old,status:'unavailable',error:String(error.message||'Metadata unavailable').slice(0,160)});
   }
  }));
 }finally{metadataRefreshBusy=false;}
}
async function importRadios(){
 if(!BASE)throw Error('CLIAMP_BASE_URL is not configured');
 const found=await discover(BASE,AbortSignal.timeout(8000));
 let added=0;
 for(const item of found){
  if(config.some(s=>s.sourceId===item.id))continue;
  const s=validate({name:item.name,sourceId:item.id,audioUrl:item.audioUrl,tagline:'LIVE RADIO',fps:1,bitrate:1500,destinations:[]});
  config.push(s);added++;
 }
 if(added){await persist();void refreshMetadata();}
 return {added,total:found.length,radios:found};
}
async function handler(req,res){
 if(!auth(req)){res.writeHead(401,{'www-authenticate':'Basic realm="CLIAMP RTMP Dashboard"','cache-control':'no-store'});res.end('Authentication required');return;}
 try{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/'){
   const html=await readFile(new URL('./public/index.html',import.meta.url));
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
   res.end(html);return;
  }
  if(req.method==='GET'&&url.pathname==='/api/stations'){reply(res,200,config.map(publicStation));return;}
  if(req.method==='GET'&&url.pathname==='/api/discover'){
   if(!BASE)throw Error('CLIAMP_BASE_URL is not configured');
   reply(res,200,{radios:await discover(BASE,AbortSignal.timeout(8000))});return;
  }
  if(req.method==='POST'&&url.pathname==='/api/import'){reply(res,200,await importRadios());return;}
  if(req.method==='POST'&&url.pathname==='/api/stations'){
   const s=validate(await body(req));config.push(s);await persist();void refreshMetadata();reply(res,201,publicStation(s));return;
  }
  const match=/^\/api\/stations\/([a-f0-9-]+)(?:\/(start|stop))?$/.exec(url.pathname);
  if(match){
   const s=config.find(s=>s.id===match[1]);
   if(!s){reply(res,404,{error:'Not found'});return;}
   if(req.method==='PUT'&&!match[2]){
    const next=validate(await body(req),s);
    await stop(s.id);config=config.map(x=>x.id===s.id?next:x);metadata.delete(s.id);await persist();void refreshMetadata();reply(res,200,publicStation(next));return;
   }
   if(req.method==='DELETE'&&!match[2]){
    await stop(s.id);config=config.filter(x=>x.id!==s.id);metadata.delete(s.id);await persist();reply(res,200,{ok:true});return;
   }
   if(req.method==='POST'&&match[2]==='start'){await start(s);reply(res,200,publicStation(s));return;}
   if(req.method==='POST'&&match[2]==='stop'){await stop(s.id);reply(res,200,publicStation(s));return;}
  }
  reply(res,404,{error:'Not found'});
 }catch(e){reply(res,400,{error:e.message});}
}
try{config=JSON.parse(await readFile(STORE,'utf8'));if(!Array.isArray(config))throw Error('Invalid station file');}
catch(e){if(e.code!=='ENOENT'){console.error('Failed loading data',e);process.exit(1);}}
const server=http.createServer((req,res)=>{handler(req,res).catch(e=>reply(res,500,{error:e.message}));});
server.listen(PORT,'0.0.0.0',()=>{
 console.log('CLIAMP RTMP worker on port '+PORT);
 void refreshMetadata();
 const timer=setInterval(()=>void refreshMetadata(),10000);
 timer.unref();
 for(const s of config.filter(s=>s.autoStart))start(s).catch(e=>console.error('Autostart',s.name,e.message));
});
async function shutdown(){server.close();await Promise.all([...workers.keys()].map(stop));process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
