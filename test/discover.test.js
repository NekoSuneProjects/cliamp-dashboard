import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {discover} from '../radio-worker.js';

test('discovers CLIAMP station audio and cover URLs safely', async()=>{
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({radios:[
   {id:'neffex',name:'NEFFEX',online:true,now_playing:{title:'Song',artist:'Artist'}},
   {id:'../invalid',name:'Bad',online:true}
  ]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const port=server.address().port;
  const list=await discover('http://127.0.0.1:'+port);
  assert.equal(list.length,1);
  assert.equal(list[0].name,'NEFFEX');
  assert.equal(list[0].audioUrl,'http://127.0.0.1:'+port+'/neffex/stream');
  assert.equal(list[0].artUrl,'http://127.0.0.1:'+port+'/neffex/art.png');
 }finally{server.close();}
});
