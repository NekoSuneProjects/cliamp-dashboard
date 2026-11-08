import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveCover,findSongArtwork,fetchImage} from '../radio-artwork.js';
function response(body,{status=200,type='application/json'}={}) {
 return new Response(body,{status,headers:{'content-type':type}});
}
test('prefers CLIAMP art.png when available',async()=>{
 const image=Buffer.from('mock-image');
 const fake=async url=>String(url).endsWith('/neffex/art.png')?response(image,{type:'image/png'}):response('{}');
 const cover=await resolveCover({baseURL:'https://radio.example',sourceId:'neffex',artist:'NEFFEX',title:'Just Breathing',fetchImpl:fake});
 assert.equal(cover.source,'cliamp');
 assert.deepEqual(cover.buffer,image);
});
test('falls back to an exact artist/title match when CLIAMP cover is missing',async()=>{
 const image=Buffer.from('cover');
 const fake=async url=>{
  const href=String(url);
  if(href.endsWith('/neffex/art.png'))return response('not found',{status:404});
  if(href.startsWith('https://itunes.apple.com/search'))return response(JSON.stringify({results:[
   {trackName:'Just Breathing',artistName:'Other Artist',artworkUrl100:'https://is1-ssl.mzstatic.com/a/100x100bb.jpg'},
   {trackName:'Just Breathing',artistName:'NEFFEX',artworkUrl100:'https://is1-ssl.mzstatic.com/a/100x100bb.jpg'}
  ]}));
  if(href.startsWith('https://is1-ssl.mzstatic.com/'))return response(image,{type:'image/jpeg'});
  throw Error('Unexpected URL '+href);
 };
 const cover=await resolveCover({baseURL:'https://radio.example',sourceId:'neffex',artist:'NEFFEX',title:'Just Breathing',fetchImpl:fake});
 assert.equal(cover.source,'itunes');
 assert.deepEqual(cover.buffer,image);
});
test('retains cached image when primary and fallback are unavailable',async()=>{
 const old=Buffer.from('old album');
 const fake=async url=>String(url).includes('itunes.apple.com')?response('{"results":[]}'):response('not found',{status:404});
 const cover=await resolveCover({baseURL:'https://radio.example',sourceId:'neffex',artist:'NEFFEX',title:'Unknown',previous:old,fetchImpl:fake});
 assert.equal(cover.source,'cached');
 assert.strictEqual(cover.buffer,old);
});
test('rejects nonimages and oversized response content',async()=>{
 await assert.rejects(fetchImage('https://test.example/a.png',undefined,async()=>response('<html>oops</html>',{type:'text/html'})),/not an image/);
 assert.equal(await findSongArtwork('','Just Breathing'),null);
});
