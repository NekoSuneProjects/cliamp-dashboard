import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitText,svgBackground,retainArtwork} from '../radio-layout.js';

test('long song titles stay within safe text width',()=>{
 const fit=fitText('Foul with ICECOLDBISHOP (RAIZHELL Remix)',{width:575,maxLines:2,maxSize:34,minSize:22});
 assert.ok(fit.lines.length<=2);
 assert.equal(fit.lines.join(' ').replace(/…/g,''),'Foul with ICECOLDBISHOP (RAIZHELL Remix)');
 const svg=svgBackground({name:'Monstercat Music',tagline:'LIVE RADIO'},{
  title:'Foul with ICECOLDBISHOP (RAIZHELL Remix)',artist:'G-Rex & STUCA'}).toString();
 assert.match(svg,/RAIZHELL/);
 assert.match(svg,/textLength="/);
 assert.ok(!svg.includes('<text x="540" y="390"'));
});

test('very long titles and artist strings never exceed 2 lines and escape HTML',()=>{
 const fitted=fitText('EXTREMELYLONGUNBROKENSONGTITLE'.repeat(15),{width:575,maxLines:2,maxSize:34,minSize:22});
 assert.ok(fitted.lines.length<=2);
 assert.ok(fitted.lines[fitted.lines.length-1].endsWith('…'));
 const svg=svgBackground({name:'Radio <Music>'},{title:'A <script> "&" very long song title',artist:'Artist & Friends'}).toString();
 assert.ok(svg.includes('&lt;script&gt;'));
 assert.ok(svg.includes('Artist &amp; Friends'));
 assert.ok(!svg.includes('<script>'));
});

test('cover artwork remains stable across empty or failed fetch responses',()=>{
 const art=Buffer.from([1,2,3]);
 assert.strictEqual(retainArtwork(null,art),art);
 assert.strictEqual(retainArtwork(art,null),art);
 assert.strictEqual(retainArtwork(art,Buffer.alloc(0)),art);
 const newArt=Buffer.from([4,5,6]);
 assert.strictEqual(retainArtwork(art,newArt),newArt);
});
