import {test} from 'node:test';
import assert from 'node:assert/strict';
import {outputProtocol,validatePublishingUrl,teeOutput,redactPublishingURLs} from '../stream-destinations.js';

test('SRT requires a receiver UDP port and caller mode',()=>{
 const p=validatePublishingUrl('srt://relay.example:9000?latency=200000','srt');
 assert.equal(p.protocol,'srt');
 assert.equal(new URL(p.url).searchParams.get('mode'),'caller');
 assert.throws(()=>validatePublishingUrl('srt://relay.example?mode=caller','srt'),/UDP port/);
 assert.throws(()=>validatePublishingUrl('srt://relay.example:9000?mode=listener','srt'),/mode=caller/);
 assert.throws(()=>validatePublishingUrl('rtmp://relay.example/live','srt'),/does not match/);
});

test('mixed RTMP, RTMPS and SRT outputs select appropriate muxers',()=>{
 const targets=[
  {url:'rtmp://rtmp.example/live/key',protocol:'rtmp',enabled:true},
  {url:'rtmps://secure.example/live/key',protocol:'rtmps',enabled:true},
  {url:'srt://relay.example:9000?mode=caller&latency=200000',protocol:'srt',enabled:true},
  {url:'srt://disabled.example:9000',protocol:'srt',enabled:false}
 ];
 const result=teeOutput(targets);
 assert.match(result,/^\[f=flv:onfail=ignore:use_fifo=1\]rtmp:\/\//);
 assert.match(result,/\|\[f=flv:onfail=ignore:use_fifo=1\]rtmps:\/\//);
 assert.match(result,/\|\[f=mpegts:onfail=ignore:use_fifo=1\]srt:\/\//);
 assert.doesNotMatch(result,/disabled\.example/);
 assert.equal(outputProtocol({url:'srt://relay.example:9000'}),'srt');
 assert.throws(()=>teeOutput([]),/No enabled/);
});

test('validates SRT encryption and redacts publishing URLs from logs',()=>{
 assert.throws(()=>validatePublishingUrl('srt://relay.example:9000?passphrase=short','srt'),/passphrase/);
 const secret='srt://relay.example:9000?passphrase=correct-horse-1234';
 const result=redactPublishingURLs('ffmpeg opening '+secret);
 assert.doesNotMatch(result,/correct-horse/);
 assert.match(result,/redacted/);
});
