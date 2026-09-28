import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {seekDecodedFrame,displayTime,previewOutputTime} from '../pro/playback.mjs';
import {playlistPlan} from '../pro/director.mjs';
import {recordStory} from '../pro/export-video.mjs';

const app=readFileSync(new URL('../pro/app.mjs',import.meta.url),'utf8');
const previewBegin=app.indexOf('async function previewClip('),previewEnd=app.indexOf('async function exportVideo()',previewBegin);
const loopBegin=app.indexOf('function loop(){'),loopEnd=app.indexOf('function updateFrames()',loopBegin);
const cancelCode=app.match(/^function cancelPreview\(\).*$/m)?.[0];
assert.ok(previewBegin>=0&&previewEnd>previewBegin&&loopBegin>=0&&loopEnd>loopBegin&&cancelCode);

function previewHarness(){
  const p={id:'p01',start:0,end:2},state={project:{id:'project',revision:1,plays:[p],playlist:[{playId:p.id,start:.8,end:.81}]},narrations:{},time:0,route:'director',exporting:false,preview:null};
  const notices=[],videos=[],frames=[];let current,context,plays=0;
  function createVideo(time){
    const events=new Map(),callbacks=new Map();let id=0;
    const v={readyState:2,duration:2,paused:true,isConnected:true,
      get currentTime(){return time;},set currentTime(t){time=t;},
      addEventListener(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},
      removeEventListener(name,fn){events.get(name)?.delete(fn);},
      requestVideoFrameCallback(fn){const next=++id;callbacks.set(next,fn);return next;},cancelVideoFrameCallback(handle){callbacks.delete(handle);},
      pause(){v.paused=true;},play(){v.paused=false;for(const fn of [...events.get('play')||[]])fn();return Promise.resolve();},
      emitSeek(){for(const fn of [...events.get('seeked')||[]])fn();},
      emitFrame(t){time=t;frames.push(t);for(const [handle,fn] of [...callbacks]){callbacks.delete(handle);fn(0,{mediaTime:t});}},
      listenerCount(){return [...events.values()].reduce((sum,set)=>sum+set.size,0);},callbacks};
    v.addEventListener('play',()=>context.loop());return v;
  }
  const render=()=>{if(current){current.isConnected=false;current.pause();}current=createVideo(state.time);videos.push(current);};
  const seek=(v,target,options)=>seekDecodedFrame(v,target,{...options,timeoutMs:100});
  context=vm.createContext({state,render,$:selector=>selector==='#preview-status'?{textContent:''}:current,
    CSS:{escape:s=>s},seekDecodedFrame:seek,playVideo:async v=>{plays++;await v.play();},
    stopPlayback:()=>current?.pause(),playlistPlan,toast:text=>notices.push(text),AbortController,
    play:()=>p,cancelAnimationFrame:()=>{},requestAnimationFrame:()=>1,displayTime,decodedTimes:new WeakMap(),
    format:(n,d)=>n.toFixed(d),previewOutputTime,updateFrames:()=>{}});
  vm.runInContext(cancelCode+'\n'+app.slice(previewBegin,previewEnd)+'\n'+app.slice(loopBegin,loopEnd),context);
  return {state,notices,videos,frames,get current(){return current;},get plays(){return plays;},start:()=>context.previewFilm()};
}

test('a ten-millisecond preview cannot claim completion while its initial decoded frame is still pending',async()=>{
  const env=previewHarness(),pending=env.start(),v=env.current;
  pending.catch(()=>{});
  v.emitSeek();v.emitSeek(); // Final seek starts fresh-frame playback and emits the real play/loop edge.
  const noticesBeforeFrame=[...env.notices];
  v.emitFrame(.84);
  const outcome=await pending.then(()=>({status:'resolved'}),error=>({status:'rejected',message:error.message}));
  console.log('ten-millisecond preview:',{start:.8,end:.81,fresh:.84,noticesBeforeFrame,notices:env.notices,regularPlays:env.plays,outcome});
  assert.ok(!noticesBeforeFrame.some(text=>text.includes('预览完成')),'The recorder probe play event is not successful playback of the requested clip.');
  assert.ok(!env.notices.some(text=>text.includes('预览完成')));
  assert.equal(outcome.status,'rejected');assert.match(outcome.message,/片段|时段|裁剪|帧/);
  assert.equal(env.plays,0);assert.equal(env.state.preview,null);assert.equal(v.paused,true);
  // One play listener belongs to the mounted source. All locating resources must have gone.
  assert.equal(v.listenerCount(),1);assert.equal(v.callbacks.size,0);
});

test('a short preview containing one fresh frame may complete after that frame was validated',async()=>{
  const env=previewHarness(),pending=env.start(),v=env.current;
  pending.catch(()=>{});
  try{
    v.emitSeek();v.emitSeek();
    assert.ok(!env.notices.some(text=>text.includes('预览完成')));
    v.emitFrame(.805);await pending;
    assert.equal(env.plays,1);assert.ok(env.frames.some(t=>t>=.8&&t<.81));
    assert.equal(v.paused,true);assert.equal(v.callbacks.size,0);
  }finally{env.state.preview?.frameController?.abort();await pending.catch(()=>{});}
});

// Reuse only existing browser edges; the tiny edit range and success/failure assertions are new.
const exportTest=readFileSync(new URL('./test-pro-export.mjs',import.meta.url),'utf8');
const fixtureBegin=exportTest.indexOf('function fixture('),fixtureEnd=exportTest.indexOf("test('edit plan supports",fixtureBegin);
const {browser,fixture}=new Function('assert',exportTest.slice(fixtureBegin,fixtureEnd)+'\nreturn {browser,fixture};')(assert);

test('a tiny export with no decoded frame inside its trim fails before creating capture or encoding resources',async()=>{
  await browser({},async env=>{
    await assert.rejects(recordStory({...fixture([[.8,.81]]),video:env.video,renderOverlay:env.renderOverlay}),{code:'NO_CLIP_FRAME'});
    console.log('ten-millisecond export:',{encoders:env.recorders.length,streams:env.streams.length,renderedFrames:env.rendered.length,sourcePaused:env.video.paused});
    assert.equal(env.recorders.length,0);assert.equal(env.streams.length,0);assert.equal(env.rendered.length,0);
    assert.equal(env.video.paused,true);assert.equal(env.video.frameIds.size,0);assert.equal(env.video.listenerCount,0);
  });
});
