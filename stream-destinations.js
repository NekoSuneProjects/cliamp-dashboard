// One encoder fans out H.264/AAC into format-specific outputs.
// RTSP ANNOUNCE publishes to a compatible RTSP server (e.g. MediaMTX).
// rtspt:// is a VRChat playback convention, not an FFmpeg publishing protocol.
// We translate its URL to rtsp:// and use RTSP over TCP.
export const PROTOCOLS=Object.freeze(['rtmp','rtmps','srt','rtsp','rtspt']);

export function outputProtocol(destination){
 const selected=String(destination?.protocol||'').toLowerCase().trim();
 if(selected&&!PROTOCOLS.includes(selected))throw Error('Unsupported publishing protocol');
 const raw=String(destination?.url||'').trim();
 if(!raw)return selected||'rtmp';
 let url;try{url=new URL(raw)}catch{throw Error('Invalid publishing URL')}
 const scheme=url.protocol.slice(0,-1).toLowerCase();
 if(!PROTOCOLS.includes(scheme))throw Error('Use rtmp://, rtmps://, srt://, rtsp:// or rtspt://');
 if(selected&&selected!==scheme&&!(selected==='rtspt'&&scheme==='rtsp')&&!(selected==='rtsp'&&scheme==='rtspt'))throw Error('Destination protocol does not match its URL');
 if(!url.hostname||url.username||url.password)throw Error('Publishing URL must have a host without user-info credentials');
 if(scheme==='srt'){
  if(!url.port)throw Error('SRT requires an explicit UDP port');
  if(url.searchParams.has('mode')&&url.searchParams.get('mode')!=='caller')throw Error('SRT publishing requires mode=caller');
  const secret=url.searchParams.get('passphrase');
  if(secret&&(secret.length<10||secret.length>79))throw Error('SRT passphrase must be 10–79 characters');
 }
 if((scheme==='rtsp'||scheme==='rtspt')&&(!url.pathname||url.pathname==='/'))throw Error('RTSP publishing requires a stream path (for example /radio)');
 return selected||scheme;
}

export function validatePublishingUrl(url,selected){
 const protocol=outputProtocol({url,protocol:selected});
 const parsed=new URL(url);
 if(protocol==='srt'&&!parsed.searchParams.has('mode'))parsed.searchParams.set('mode','caller');
 // Leave friendly rtspt:// form in stored configuration; FFmpeg gets rtsp:// later.
 return {protocol,url:parsed.href};
}
function escapeTee(value){
 return String(value).replaceAll('\\','\\\\').replaceAll('|','\\|').replaceAll('[','\\[').replaceAll(']','\\]');
}
export function teeOutput(destinations){
 const active=destinations.filter(d=>d.enabled!==false&&d.url);
 if(!active.length)throw Error('No enabled publishing destinations');
 return active.map(d=>{
  const {protocol,url}=validatePublishingUrl(d.url,d.protocol);
  let format,extra='',target=url;
  if(protocol==='rtsp'||protocol==='rtspt'){
   format='rtsp';
   // FFmpeg does not accept rtspt://. RTSP muxer supports TCP interleaved or UDP.
   target=url.replace(/^rtspt:/i,'rtsp:');
   extra=':rtsp_transport='+ (protocol==='rtspt'?'tcp':'udp');
  }else format=protocol==='srt'?'mpegts':'flv';
  // Do not put the colon-escaped RTMP URL or obsolete fifo_options in the
  // option bracket: malformed tee options caused the earlier FFmpeg -22 error.
  return '[f='+format+':onfail=ignore'+extra+']'+escapeTee(target);
 }).join('|');
}
export function redactPublishingURLs(value){
 return String(value).replace(/(?:rtmps?|srt|rtspt?):\/\/[^\s"']+/gi,'[publishing destination redacted]');
}
