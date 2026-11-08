import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {sourceIdFor,readMetadata} from '../station-metadata.js';

test('source ID resolves from real CLIAMP audio and HLS URLs',()=>{
 const base='https://radio.example';
 assert.equal(sourceIdFor({sourceId:'neffex',audioUrl:'https://other.test/audio'},base),'neffex');
 assert.equal(sourceIdFor({audioUrl:'https://radio.example/neffex/stream'},base),'neffex');
 assert.equal(sourceIdFor({audioUrl:'https://radio.example/neffex/vrchat/index.m3u8'},base),'neffex');
 assert.equal(sourceIdFor({audioUrl:'https://other.test/neffex/stream'},base),'');
 assert.equal(sourceIdFor({audioUrl:'https://radio.example/x/../../other'},base),'');
});
test('metadata API returns current song without an RTMP worker',async()=>{
 const server=http.createServer((req,res)=>{
  if(req.url!=='/api/v1/radios/neffex'){res.writeHead(404).end();return;}
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({online:true,now_playing:{title:'Playing now',artist:'Artist A',album:'Album B'}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base='http://127.0.0.1:'+server.address().port;
  assert.deepEqual(await readMetadata(base,'neffex',AbortSignal.timeout(2000)),{
   title:'Playing now',artist:'Artist A',album:'Album B',online:true
  });
 }finally{server.close();}
});
