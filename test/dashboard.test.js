import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';

test('dashboard loads with core controls and valid browser JavaScript',async()=>{
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 for(const id of ['stations','import','add','editor','form','destinations','addDest','cancel','total-count','live-count','dest-count']){
  assert.match(html,new RegExp('id="'+id+'"'),id+' missing');
 }
 assert.match(html,/class="shell"/);
 assert.match(html,/class="sidebar"/);
 const match=html.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(match,'dashboard script missing');
 assert.doesNotThrow(()=>new Script(match[1],{filename:'dashboard-inline.js'}));
});
