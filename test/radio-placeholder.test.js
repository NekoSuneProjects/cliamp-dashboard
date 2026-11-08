import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {cdCasePlaceholder} from '../radio-placeholder.js';

test('fallback draws a 390x390 CD jewel case with a visible disc and hub',async()=>{
 const image=cdCasePlaceholder();
 assert.ok(Buffer.isBuffer(image));
 const markup=image.toString('utf8');
 assert.match(markup,/<svg width="390" height="390"/);
 assert.match(markup,/id="disc"/);
 assert.match(markup,/id="plastic"/);
 assert.match(markup,/circle cx="208" cy="180" r="125"/);
 assert.match(markup,/circle cx="208" cy="204" r="12"/);
 assert.match(markup,/LIVE RADIO/);
 const raster=sharp(image);
 const meta=await raster.metadata();
 assert.equal(meta.width,390);
 assert.equal(meta.height,390);
 const png=await raster.png().toBuffer();
 assert.ok(png.length>5000);
});
