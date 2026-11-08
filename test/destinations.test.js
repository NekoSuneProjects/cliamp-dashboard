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
 assert.match(result,/^\[f=flv:onfail=ignore\]rtmp:\/\//);
 assert.match(result,/\|\[f=flv:onfail=ignore\]rtmps:\/\//);
 assert.match(result,/\|\[f=mpegts:onfail=ignore\]srt:\/\//);
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

test('publishes RTSP/UDP and VRChat RTSP-over-TCP using FFmpeg RTSP URLs',()=>{
 const targets=[
  {url:'rtsp://media.example:8554/quest',protocol:'rtsp',enabled:true},
  {url:'rtspt://media.example:8554/pc',protocol:'rtspt',enabled:true},
  {url:'rtmps://secure.example/live/secret',protocol:'rtmps',enabled:true}
 ];
 const result=teeOutput(targets);
 assert.match(result,/\[f=rtsp:onfail=ignore:rtsp_transport=udp\]rtsp:\/\/media\.example:8554\/quest/);
 assert.match(result,/\[f=rtsp:onfail=ignore:rtsp_transport=tcp\]rtsp:\/\/media\.example:8554\/pc/);
 assert.doesNotMatch(result,/rtspt:\/\//);
 assert.match(result,/\[f=flv:onfail=ignore\]rtmps:\/\/secure\.example/);
 assert.throws(()=>validatePublishingUrl('rtsp://media.example:8554','rtsp'),/stream path/);
 assert.equal(validatePublishingUrl('rtspt://media.example:8554/live','rtspt').protocol,'rtspt');
});
test('rejects malformed protocol options before launching FFmpeg',()=>{
 assert.throws(()=>validatePublishingUrl('ftp://media.example/test','rtsp'),/Use rtmp/);
 assert.throws(()=>validatePublishingUrl('srt://media.example:9000?mode=listener','srt'),/mode=caller/);
 assert.doesNotMatch(redactPublishingURLs('srt://media.example:9000?passphrase=secret-encryption'),/secret-encryption/);
 assert.doesNotMatch(redactPublishingURLs('rtspt://media.example:8554/secret-path'),/secret-path/);
});
