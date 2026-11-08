// VPS-side artwork fallback. CLIAMP may have no art.png when the Pi's
// optional VRChat HLS visuals have no matching cover. No API key is required.
const MAX_BYTES = 4 * 1024 * 1024;
const ITUNES_HOST = 'itunes.apple.com';
const ART_HOST = 'mzstatic.com';
const sanitize = str => String(str || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const primaryArtist = artist => String(artist || '').split(/\s+(?:feat\.?|ft\.?|featuring|with|x|&|and)\s+|,/i,1)[0].trim();
const matching = (record, artist, title) =>
  sanitize(record.trackName) === sanitize(title) &&
  (sanitize(record.artistName) === sanitize(primaryArtist(artist)) ||
   sanitize(record.artistName).startsWith(sanitize(primaryArtist(artist))+' '));

export async function fetchImage(url, signal, fetchImpl=fetch) {
 const parsed=new URL(url);
 if(parsed.protocol!=='https:'&&parsed.protocol!=='http:')throw Error('Artwork URL must be HTTP(S)');
 const response=await fetchImpl(parsed,{signal,headers:{accept:'image/*'}});
 if(response.status===404||response.status===204)return null;
 if(!response.ok)throw Error('Artwork HTTP '+response.status);
 const contentType=String(response.headers.get('content-type')||'').toLowerCase();
 if(!contentType.startsWith('image/'))throw Error('Artwork response was not an image');
 const length=Number(response.headers.get('content-length')||0);
 if(length>MAX_BYTES)throw Error('Artwork too large');
 const chunks=[];let size=0;
 for await(const chunk of response.body){
  size+=chunk.length;
  if(size>MAX_BYTES)throw Error('Artwork too large');
  chunks.push(chunk);
 }
 const result=Buffer.concat(chunks);
 return result.length?result:null;
}
export async function findSongArtwork(artist,title,{signal,fetchImpl=fetch}={}) {
 if(!sanitize(artist)||!sanitize(title))return null;
 const request=new URL('https://'+ITUNES_HOST+'/search');
 request.searchParams.set('term',primaryArtist(artist)+' '+title);
 request.searchParams.set('entity','song');
 request.searchParams.set('limit','25');
 const response=await fetchImpl(request,{signal,headers:{accept:'application/json'}});
 if(!response.ok)throw Error('Cover lookup HTTP '+response.status);
 const body=await response.text();
 if(body.length>128*1024)throw Error('Cover lookup response too large');
 const results=JSON.parse(body).results;
 if(!Array.isArray(results))return null;
 const matched=results.find(item=>matching(item,artist,title));
 if(!matched?.artworkUrl100)return null;
 const cover=new URL(matched.artworkUrl100);
 if(cover.protocol!=='https:' || !(cover.hostname===ART_HOST || cover.hostname.endsWith('.'+ART_HOST)))return null;
 cover.pathname=cover.pathname.replace('100x100bb','600x600bb');
 return await fetchImage(cover.href,signal,fetchImpl);
}

// Persistent last-good cover is a feature; do not clear it on transient errors.
export async function resolveCover({baseURL,sourceId,artist,title,previous,fetchImpl=fetch,signal}) {
 let primary=null,via='none';
 if(baseURL && sourceId && /^[a-z0-9-]{1,64}$/.test(sourceId)){
  try {
   const url=new URL('/'+sourceId+'/art.png',baseURL);
   primary=await fetchImage(url.href,signal,fetchImpl);
   if(primary)via='cliamp';
  }catch{}
 }
 if(primary)return {buffer:primary,source:via};
 if(artist && title){
  try {
   const found=await findSongArtwork(artist,title,{signal,fetchImpl});
   if(found)return {buffer:found,source:'itunes'};
  }catch{}
 }
 return {buffer:previous||null,source:previous?'cached':'placeholder'};
}
