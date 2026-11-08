import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 8096);
const DATA_DIR = process.env.DATA_DIR || './data';
const STORE = join(DATA_DIR, 'stations.json');
const USER = process.env.DASHBOARD_USER || '';
const PASS = process.env.DASHBOARD_PASSWORD || '';
if (!USER || !PASS) { console.error('Set DASHBOARD_USER and DASHBOARD_PASSWORD'); process.exit(1); }
const processes = new Map();
const records = new Map();
let config = [];
const b64 = s => Buffer.from(s).toString('base64');
function authorized(req) {
  const expected = Buffer.from('Basic ' + b64(USER + ':' + PASS));
  const supplied = Buffer.from(req.headers.authorization || '');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
function send(res, code, data) {
  res.writeHead(code, { 'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff' });
  res.end(JSON.stringify(data));
}
function publicStation(s) {
  const state = records.get(s.id) || {};
  return { id:s.id, name:s.name, audioUrl:s.audioUrl, imagePath:s.imagePath || '',
    fps:s.fps, bitrate:s.bitrate, destinations:s.destinations.map(d=>({id:d.id,name:d.name,enabled:d.enabled,configured:!!d.url})),
    status:state.status || 'stopped', pid:processes.get(s.id)?.pid || null, error:state.error || null };
}
function validate(input, old=null) {
  if (!input || typeof input !== 'object') throw Error('Invalid station');
  const name=String(input.name || '').trim();
  const audioUrl=String(input.audioUrl || '').trim();
  if (!name || name.length>90) throw Error('Name must be 1–90 characters');
  const url=new URL(audioUrl);
  if (!['http:','https:'].includes(url.protocol)) throw Error('Audio URL must be HTTP(S) HLS or another FFmpeg-supported HTTP(S) audio stream');
  const imagePath=String(input.imagePath || '').trim();
  if (imagePath && (!imagePath.startsWith('/') || /[\r\n]/.test(imagePath))) throw Error('Image must be an absolute local path on the worker');
  const fps=Number(input.fps || 15);
  const bitrate=Number(input.bitrate || 1500);
  if (![10,15,20,25,30].includes(fps) || bitrate<400 || bitrate>6000 || !Number.isInteger(bitrate)) throw Error('Invalid FPS or bitrate');
  if (!Array.isArray(input.destinations) || input.destinations.length>12) throw Error('Maximum 12 destinations');
  const destinations=input.destinations.map(d=>{
    const previous=old?.destinations.find(x=>x.id===d.id);
    const value=String(d.url || '').trim();
    const destUrl=value || previous?.url || '';
    if(destUrl && !/^rtmps?:\/\//i.test(destUrl)) throw Error('Destination must begin with rtmp:// or rtmps://');
    const destName=String(d.name || '').trim();
    if(!destName || destName.length>90) throw Error('Destination name required');
    return {id:previous?.id || randomUUID(),name:destName,url:destUrl,enabled:d.enabled!==false};
  });
  if (new Set(destinations.map(d=>d.id)).size !== destinations.length) throw Error('Duplicate destination IDs');
  return {id:old?.id || randomUUID(),name,audioUrl,imagePath,fps,bitrate,destinations};
}
async function persist(){
  await mkdir(DATA_DIR,{recursive:true});
  const tmp=STORE+'.tmp';
  await writeFile(tmp,JSON.stringify(config,null,2),{mode:0o600});
  await rename(tmp,STORE);
}
function teeEscape(s) {
  // FFmpeg tee slave escaping. URLs never enter a shell.
  return s.replaceAll('\\','\\\\').replaceAll('|','\\|').replaceAll('[','\\[').replaceAll(']','\\]').replaceAll(':','\\:');
}
function stop(id) {
  const proc=processes.get(id);
  if (proc) { processes.delete(id); proc.kill('SIGTERM'); }
  records.set(id,{status:'stopped',error:null});
}
function start(s) {
  if (processes.has(s.id)) throw Error('Station already running');
  const destinations=s.destinations.filter(d=>d.enabled && d.url);
  if (!destinations.length) throw Error('Add and enable at least one RTMP destination');
  const args=['-hide_banner','-nostdin','-loglevel','warning','-thread_queue_size','512','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5','-i',s.audioUrl];
  if(s.imagePath) {
    args.push('-loop','1','-framerate',String(s.fps),'-i',s.imagePath);
  } else {
    args.push('-f','lavfi','-i',`color=c=0x151822:s=1280x720:r=${s.fps}`);
  }
  args.push('-map','1:v:0','-map','0:a:0','-vf','scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-r',String(s.fps),'-c:v','libx264','-preset','ultrafast','-tune','stillimage','-g',String(s.fps*2),'-b:v',s.bitrate+'k',
    '-maxrate',s.bitrate+'k','-bufsize',s.bitrate*2+'k','-c:a','aac','-b:a','128k','-ar','44100',
    '-f','tee', destinations.map(d=>`[f=flv:onfail=ignore:use_fifo=1:fifo_options=attempt_recovery\\=1\\:recover_any_error\\=1]${teeEscape(d.url)}`).join('|'));
  const child=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});
  processes.set(s.id,child);
  records.set(s.id,{status:'starting',error:null});
  let errors='';
  child.stderr.on('data',chunk=>{
    errors=(errors+chunk.toString()).slice(-1800);
    if(processes.get(s.id)===child && child.exitCode===null) records.set(s.id,{status:'running',error:null});
  });
  child.on('error',err=>{
    if(processes.get(s.id)===child) { processes.delete(s.id); records.set(s.id,{status:'error',error:err.message}); }
  });
  child.on('exit',(code,signal)=>{
    if(processes.get(s.id)===child){processes.delete(s.id);records.set(s.id,{status:'error',error:`FFmpeg exited (${code??signal}); check worker logs. ${errors.replace(/rtmps?:\/\/[^\s|]+/gi,'[RTMP URL hidden]').slice(-350)}`});}
  });
}
async function parseBody(req) {
  let data='';
  for await(const chunk of req) {
    data += chunk;
    if(data.length>100_000) throw Error('Request too large');
  }
  return JSON.parse(data || '{}');
}
async function handler(req,res){
  if(!authorized(req)){res.writeHead(401,{'www-authenticate':'Basic realm="CLIAMP RTMP Dashboard"','cache-control':'no-store'});res.end('Authentication required');return;}
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET' && url.pathname==='/'){
      const html=await readFile(resolve('public/index.html'));
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'"});
      res.end(html);return;
    }
    if(req.method==='GET' && url.pathname==='/api/stations'){send(res,200,config.map(publicStation));return;}
    if(req.method==='POST' && url.pathname==='/api/stations'){
      const s=validate(await parseBody(req));config.push(s);await persist();send(res,201,publicStation(s));return;
    }
    const match=/^\/api\/stations\/([a-f0-9-]+)(?:\/(start|stop))?$/.exec(url.pathname);
    if(match){
      const s=config.find(x=>x.id===match[1]);
      if(!s){send(res,404,{error:'Station not found'});return;}
      if(req.method==='PUT' && !match[2]){
        const next=validate(await parseBody(req),s);
        if(processes.has(s.id)) stop(s.id);
        config=config.map(x=>x.id===s.id?next:x);await persist();
        send(res,200,publicStation(next));return;
      }
      if(req.method==='DELETE' && !match[2]){stop(s.id);config=config.filter(x=>x.id!==s.id);await persist();send(res,200,{ok:true});return;}
      if(req.method==='POST' && match[2]==='start'){start(s);send(res,200,publicStation(s));return;}
      if(req.method==='POST' && match[2]==='stop'){stop(s.id);send(res,200,publicStation(s));return;}
    }
    send(res,404,{error:'Not found'});
  }catch(err){send(res,400,{error:err.message});}
}
try { config=JSON.parse(await readFile(STORE,'utf8'));if(!Array.isArray(config))throw Error('Invalid persisted configuration');}
catch(err){if(err.code!=='ENOENT'){console.error('Failed to load stations:',err);process.exit(1);} }
const server=http.createServer((req,res)=>{handler(req,res).catch(e=>send(res,500,{error:e.message}));});
server.listen(PORT,'0.0.0.0',()=>console.log(`CLIAMP RTMP dashboard listening on :${PORT}`));
function shutdown(){for(const s of config)stop(s.id);server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
