import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {seekDecodedFrame,previewOutputTime} from '../pro/playback.mjs';
import {playlistPlan} from '../pro/director.mjs';

function manualVideo(time=0){
  const events=new Map(),callbacks=new Map(),seeks=[];let next=1;
  const v={duration:40,readyState:2,seeks,callbacks,paused:true,playCalls:0,pause(){this.paused=true;},play(){this.playCalls++;this.paused=false;return Promise.resolve();},
    get currentTime(){return time;},set currentTime(t){time=t;seeks.push(t);},
    addEventListener(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},
    removeEventListener(name,fn){events.get(name)?.delete(fn);},
    requestVideoFrameCallback(fn){const id=next++;callbacks.set(id,fn);return id;},
    cancelVideoFrameCallback(id){callbacks.delete(id);},
    emitSeek(){for(const fn of [...events.get('seeked')||[]])fn();},
    emitFrame(t){for(const [id,fn] of [...callbacks]){callbacks.delete(id);fn(0,{mediaTime:t});}},
    takeCallback(){const entry=[...callbacks][0];if(!entry)return null;callbacks.delete(entry[0]);return entry[1];},
    listenerCount(){return [...events.values()].reduce((a,b)=>a+b.size,0);}};
  return v;
}

test('nearby old frame before seek completion cannot replace the actual new frozen frame',async()=>{
  const v=manualVideo(32.75),pending=seekDecodedFrame(v,32.5,{timeoutMs:100});
  v.emitFrame(32.75); // Old compositor frame delivered while the target seek is still pending.
  v.emitSeek();
  v.emitFrame(32.48); // Actual frame for the completed target seek.
  const result=await pending;
  console.log('nearby stale freeze:',{requested:32.5,old:32.75,actualNew:32.48,returned:result.time});
  assert.equal(result.time,32.48);
});

test('no-op seek prime frame cannot become the frozen target frame',async()=>{
  const v=manualVideo(32.5),controller=new AbortController(),pending=seekDecodedFrame(v,32.5,{timeoutMs:100,signal:controller.signal});
  pending.catch(()=>{});
  try {
    assert.deepEqual(v.seeks,[32.58],'The target must wait until the priming seek has completed.');
    v.emitFrame(32.58);v.emitSeek();
    assert.deepEqual(v.seeks,[32.58,32.5]);
    v.emitFrame(32.58); // Prime frame delivered while the final seek is still pending.
    v.emitSeek();v.emitFrame(32.48);
    const result=await pending;
    console.log('prime stale freeze:',{prime:32.58,target:32.5,actualNew:32.48,returned:result.time});
    assert.equal(result.time,32.48);
  } finally {controller.abort();await pending.catch(()=>{});}
});

test('a queued old callback cannot become fresh merely by arriving after target seeked',async()=>{
  const v=manualVideo(32.75),pending=seekDecodedFrame(v,32.5,{timeoutMs:100});
  v.emitSeek();
  const oldCallback=v.takeCallback(); // Browser work already queued in the previous callback generation.
  v.emitSeek();
  oldCallback?.(0,{mediaTime:32.75}); // Cancellation of its registration need not erase a queued closure.
  v.emitFrame(32.48);
  assert.equal((await pending).time,32.48);
});

test('zero is accepted after a fully staged prime and target seek',async()=>{
  const v=manualVideo(),controller=new AbortController(),pending=seekDecodedFrame(v,0,{timeoutMs:100,signal:controller.signal});
  pending.catch(()=>{});
  try {
    assert.deepEqual(v.seeks,[.08]);
    v.emitSeek();assert.deepEqual(v.seeks,[.08,0]);
    v.emitSeek();v.emitFrame(0);
    const result=await pending;
    assert.equal(result.time,0);assert.equal(result.frameAccurate,true);
    assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);
  } finally {controller.abort();await pending.catch(()=>{});}
});

test('explicit abort during pending seek releases listeners and decoded callbacks',async()=>{
  const v=manualVideo(),controller=new AbortController();
  const pending=seekDecodedFrame(v,0,{timeoutMs:100,signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);
  v.emitSeek();v.emitFrame(0);
});

test('abort while waiting for prime completion never starts the target seek',async()=>{
  const v=manualVideo(10),controller=new AbortController();
  const pending=seekDecodedFrame(v,10,{timeoutMs:100,signal:controller.signal});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});
  v.emitSeek();v.emitFrame(10.08);
  assert.deepEqual(v.seeks,[10.08]);assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);
});

test('a paused seek with no post-seeked submission briefly plays for a fresh actual frame then pauses',async()=>{
  const v=manualVideo(30);
  v.play=function(){this.playCalls++;this.paused=false;queueMicrotask(()=>{if(!this.paused)this.emitFrame(32.52);});return Promise.resolve();};
  const pending=seekDecodedFrame(v,32.5,{timeoutMs:100});
  v.emitFrame(32.48); // Seek frame was already submitted before seeked; no later frame while paused.
  v.emitSeek();
  const result=await pending;
  assert.equal(result.time,32.52);assert.equal(result.frameAccurate,true);
  assert.equal(v.playCalls,1);assert.equal(v.paused,true);assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);
});

test('fresh frame playback rejection fails explicitly and releases all pending handles',async()=>{
  const v=manualVideo(30);v.play=()=>Promise.reject(new Error('NotAllowedError'));
  const pending=seekDecodedFrame(v,32.5,{timeoutMs:100});v.emitSeek();
  await assert.rejects(pending,/新帧|播放/);
  assert.equal(v.paused,true);assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);
});

const source=await readFile(new URL('../pro/app.mjs',import.meta.url),'utf8');
const begin=source.indexOf('async function previewClip('),end=source.indexOf('async function exportVideo()',begin);
assert.ok(begin>=0&&end>begin);
const previewSource=source.slice(begin,end);
const cancelSource=source.match(/^function cancelPreview\(\).*$/m)?.[0]||'function cancelPreview(){state.preview=null;}';
const renderBegin=source.indexOf('function render(){')+'function render(){'.length;
const renderEnd=source.indexOf("$('#navigation')",renderBegin);
assert.ok(renderBegin>0&&renderEnd>renderBegin);
const renderPrefix=source.slice(renderBegin,renderEnd);
function ui({realSeek=false}={}){
  const state={project:{id:'fixture-project',revision:1,plays:[{id:'p1',start:10,end:20}],playlist:[{playId:'p1',start:12,end:14},{playId:'p1',start:17,end:19}]},narrations:{},preview:null,time:10,playId:'p1'};
  let current=null,resolveFrame;
  const played=[],videos=[],requests=[],location={hash:'#/director'};
  const cancelPreview=new Function('state',cancelSource+'\nreturn cancelPreview;')(state);
  const renderLifecycle=new Function('state','stopPlayback','frameObservers','location','cancelPreview',renderPrefix);
  const render=()=>{renderLifecycle(state,()=>{},[],location,cancelPreview);if(current){current.detached=true;current.isConnected=false;}current={...(realSeek?manualVideo(state.time):{}),id:videos.length,detached:false,isConnected:true};videos.push(current);};
  const seek=(video,target,options)=>{requests.push({video,target,options});if(realSeek)return seekDecodedFrame(video,target,{...options,timeoutMs:100});return new Promise((resolve,reject)=>{resolveFrame=resolve;options?.signal?.addEventListener('abort',()=>reject(Object.assign(new Error('Cancelled'),{name:'AbortError'})),{once:true});});};
  const factory=new Function('state','render','$','CSS','seekDecodedFrame','playVideo','stopPlayback','playlistPlan','toast','cancelPreview',previewSource+'\nreturn {previewClip,previewFilm};');
  const functions=factory(state,render,()=>current,{escape:s=>s},seek,async video=>played.push(video),()=>{},playlistPlan,()=>{},cancelPreview);
  return {state,render,played,videos,requests,location,cancelPreview,...functions,finish(time){resolveFrame({time,clock:'decoded-media-time',frameAccurate:true});}};
}

test('revision change and re-render while preview is locating must not start detached source',async()=>{
  const env=ui(),pending=env.previewFilm();
  // The real data-reviewed change handler saves (revision increments) then calls render.
  env.state.project.revision=2;env.render();
  env.finish(12);
  await pending;
  console.log('revision during preview:',{planRevision:1,currentRevision:2,played:env.played.map(v=>({id:v.id,detached:v.detached})),previewStillActive:!!env.state.preview});
  assert.equal(env.played.length,0,'The reviewed/save render detached the element whose old seek promise then played it.');
});

test('preview cancellation before frame completion does not start the old video',async()=>{
  const env=ui(),pending=env.previewFilm();
  env.state.preview=null;env.render();env.finish(12);await pending;
  assert.equal(env.played.length,0);
});

test('repeated possession clips preserve independent trims and output time',async()=>{
  const env=ui();let pending=env.previewFilm();env.finish(12);await pending;
  const token=env.state.preview;pending=env.previewClip(1,token);env.finish(17.04);await pending;
  assert.deepEqual(env.requests.map(r=>r.target),[12,17]);assert.equal(env.played.length,2);
  assert.ok(Math.abs(previewOutputTime(token.plan,1,17.04)-2.04)<1e-9);
});

test('clicking pause during playlist preview must pause rather than restart ordinary source playback',async()=>{
  const clickBegin=source.indexOf("document.addEventListener('click'");
  const clickEnd=source.indexOf("document.addEventListener('submit'",clickBegin);
  assert.ok(clickBegin>=0&&clickEnd>clickBegin);
  const state={preview:{},project:{revision:1}},p={id:'p1',start:10,end:20};let handler,plays=0;
  const video={paused:false,currentTime:12,play(){plays++;this.paused=false;},pause(){this.paused=true;}};
  const document={addEventListener(name,fn){assert.equal(name,'click');handler=fn;}};
  const factory=new Function('document','state','play','stopPlayback','$','CSS','playVideo','toast','cancelPreview',source.slice(clickBegin,clickEnd));
  factory(document,state,()=>p,()=>video.pause(),()=>video,{escape:s=>s},async v=>v.play(),message=>{throw new Error(message);},()=>{state.preview=null;});
  await handler({target:{closest(){return {disabled:false,dataset:{action:'play'}};}}});
  console.log('pause during preview:',{paused:video.paused,restartedPlays:plays,previewStillActive:!!state.preview});
  assert.equal(video.paused,true);assert.equal(plays,0);
});

test('input cancellation releases actual prime/target seek listeners and decoded callback handles',async()=>{
  for(const phase of ['prime','frame']){
    const env=ui({realSeek:true}),pending=env.previewFilm(),v=env.videos[0],controller=env.state.preview.frameController;
    if(phase==='frame'){v.emitSeek();v.emitSeek();assert.equal(v.callbacks.size,1);}
    const begin=source.indexOf("document.addEventListener('input'"),end=source.indexOf("document.addEventListener('change'",begin);let handler;
    const factory=new Function('document','state','cancelPreview','stopPlayback',source.slice(begin,end));
    factory({addEventListener(_,fn){handler=fn;}},env.state,env.cancelPreview,()=>v.pause());
    handler({target:{matches(selector){return selector==='input,textarea,select';}}});
    await pending;
    assert.equal(controller.signal.aborted,true);assert.equal(env.state.preview,null);
    assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);assert.equal(env.played.length,0);
  }
});

test('changing route releases an in-flight preview seek and does not play a detached video',async()=>{
  const env=ui({realSeek:true}),pending=env.previewFilm(),v=env.videos[0],controller=env.state.preview.frameController;
  v.emitSeek();v.emitSeek();assert.equal(v.callbacks.size,1);
  env.location.hash='#/watch';env.render();await pending;
  assert.equal(controller.signal.aborted,true);assert.equal(env.state.preview,null);
  assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);assert.equal(env.played.length,0);
});

test('keyboard frame-step must cancel an in-flight preview rather than let it restart playback',async()=>{
  const env=ui({realSeek:true}),pending=env.previewFilm(),v=env.videos[0],controller=env.state.preview.frameController;
  const begin=source.indexOf("document.addEventListener('keydown'"),end=source.indexOf("window.addEventListener('hashchange'",begin);let handler;
  const factory=new Function('document','state','$','stopPlayback','setTime','cancelPreview',source.slice(begin,end));
  factory({addEventListener(_,fn){handler=fn;}},env.state,()=>({open:false}),()=>v.pause(),t=>{env.state.time=t;},env.cancelPreview);
  try{
    handler({key:'ArrowRight',preventDefault(){},target:{closest(){return null;}}});
    v.emitSeek();v.emitSeek();v.emitFrame(12);await pending;
    console.log('frame-step during preview locate:',{aborted:controller.signal.aborted,restartedPlays:env.played.length,previewStillActive:!!env.state.preview});
    assert.equal(controller.signal.aborted,true);assert.equal(env.state.preview,null);
    assert.equal(env.played.length,0);assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);
  }finally{env.cancelPreview();await pending;}
});
