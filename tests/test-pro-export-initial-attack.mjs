import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {recordStory} from '../pro/export-video.mjs';

// Reuse only the existing browser shim; the adversarial callback ordering is new.
const source=await readFile(new URL('./test-pro-export.mjs',import.meta.url),'utf8');
const begin=source.indexOf('function fixture('),end=source.indexOf("test('edit plan supports",begin);
assert.ok(begin>=0&&end>begin);
const {browser,fixture}=new Function('assert',source.slice(begin,end)+'\nreturn {browser,fixture};')(assert);

test('initial export frame must not use old nearby metadata received before target seeked',async()=>{
  await browser({},async env=>{
    env.video._currentTime=.9;env.video.decodedTime=.9;
    const request=env.video.requestVideoFrameCallback.bind(env.video),freshSubmitted=[];let first=true;
    env.video.requestVideoFrameCallback=callback=>{
      if(!first||env.video.currentTime!==.9)return request((now,metadata)=>{freshSubmitted.push(metadata.mediaTime);callback(now,metadata);});
      first=false;queueMicrotask(()=>callback(0,{mediaTime:.9,presentedFrames:1}));
      return 999999; // Old frame was already submitted when the target seek began.
    };
    const film=await recordStory({...fixture([[.8,1.2]]),video:env.video,renderOverlay:env.renderOverlay});
    console.log('initial export stale frame:',{requested:.8,firstFrame:film.clips[0].firstFrameTime,firstDraw:env.rendered[0]});
    assert.equal(film.clips[0].firstFrameTime,freshSubmitted[0],'The film must begin with the actual fresh submission, even if briefly playing advanced its source time.');
    assert.notEqual(film.clips[0].firstFrameTime,.9,'The old pre-seek frame must never certify the first export frame.');
    assert.ok(env.rendered.every(frame=>frame.t===frame.pixelTime),'Overlay clock must agree with the currently drawn source frame.');
  });
});
