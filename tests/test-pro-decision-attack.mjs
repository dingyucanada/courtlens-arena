import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {seekDecodedFrame} from '../pro/playback.mjs';

function video(time=0,{decoded=true}={}){
  const events=new Map(),callbacks=new Map();let handle=0;
  const v={duration:2,readyState:2,paused:true,seeks:[],
    get currentTime(){return time;},set currentTime(t){time=t;v.seeks.push(t);},
    pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},
    addEventListener(name,fn){if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},
    removeEventListener(name,fn){events.get(name)?.delete(fn);},
    emitSeek(){for(const fn of [...events.get('seeked')||[]])fn();},
    emitFrame(t){time=t;for(const [id,fn] of [...callbacks]){callbacks.delete(id);fn(0,{mediaTime:t});}},
    listenerCount(){return [...events.values()].reduce((sum,set)=>sum+set.size,0);},callbacks};
  if(decoded){v.requestVideoFrameCallback=fn=>{const id=++handle;callbacks.set(id,fn);return id;};v.cancelVideoFrameCallback=id=>callbacks.delete(id);}
  return v;
}

for(const late of [1,1.05]){
  test(`a fresh decoded frame ${late} must fail closed at before=1 despite being within target .8 +/-1`,async()=>{
    const v=video(),pending=seekDecodedFrame(v,.8,{before:1,timeoutMs:100});
    const rejected=assert.rejects(pending,/之前|边界|截止|before|越|超|晚|定位/i);
    v.emitSeek();v.emitFrame(late);await rejected;
    assert.equal(v.paused,true);assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);
  });
}

test('a safe frame below the exclusive cutoff retains its actual decoded clock',async()=>{
  const v=video(),pending=seekDecodedFrame(v,.8,{before:1,timeoutMs:100});
  v.emitSeek();v.emitFrame(.96);const result=await pending;
  assert.equal(result.time,.96);assert.equal(result.frameAccurate,true);
  assert.equal(v.paused,true);assert.equal(v.callbacks.size,0);assert.equal(v.listenerCount(),0);
});

test('the approximate player-clock fallback must also respect the exclusive cutoff',async()=>{
  const v=video(0,{decoded:false}),pending=seekDecodedFrame(v,.8,{before:1,timeoutMs:100});
  const rejected=assert.rejects(pending,/之前|边界|截止|before|越|超|晚|定位/i);
  v.currentTime=1.05;v.emitSeek();await rejected;
  assert.equal(v.paused,true);assert.equal(v.listenerCount(),0);
});

const app=readFileSync(new URL('../pro/app.mjs',import.meta.url),'utf8');
const start=app.indexOf('async function decisionDialog(){'),end=app.indexOf('function syncDialog()',start);
assert.ok(start>=0&&end>start);
const decisionCode=app.slice(start,end);
const invisible=stage=>stage.hidden||stage.style.visibility==='hidden'||stage.style.display==='none'||stage.style.opacity==='0';

function decisionHarness({faultySeek=false,playOverrides={}}={}){
  const p={id:'p01',start:0,end:2,shotTime:1,resultTime:1.04,outcome:'made',player:'H1',tracks:[],screenTracks:[{t:.8,players:[]}],metrics:{},...playOverrides};
  const state={url:'fixture.mp4',project:{video:{width:1280,height:720}},layers:{},decision:null};
  const v=video(),stage={hidden:false,style:{}},canvas={width:1280,height:720,parentElement:stage,getContext:()=>({})};
  const nodes={'#decision-video':v,'#decision-overlay':canvas,'#decision-stage':stage,'.calibration-stage':stage,'#main':{style:{}},'#dialog':{open:true},'#decision-clock':{textContent:''},'#decision-facts':{textContent:''}};
  const choices=[],requests=[],analyses=[],overlays=[],dialogs=[],notices=[];let resolveFrame;
  const showDialog=(title,html,footer)=>{
    dialogs.push({title,html,footer});
    const tag=html.match(/<div\b[^>]*(?:class="[^"]*calibration-stage[^"]*"|id="decision-stage")[^>]*>/)?.[0];
    // A scientifically unavailable decision may show only an explanation, without video or choices.
    if(!tag){stage.hidden=true;return;}
    stage.hidden=/\shidden(?:\s|=|>)/.test(tag);
    stage.style={};
    const style=tag.match(/style="([^"]*)"/)?.[1]||'';
    for(const declaration of style.split(';')){const [key,value]=declaration.split(':');if(key&&value)stage.style[key.trim()]=value.trim();}
    choices.push(...[...html.matchAll(/<button\b[^>]*data-action="decision-choice"[^>]*>/g)].map(match=>({disabled:/\sdisabled(?:\s|=|>)/.test(match[0])})));
  };
  const seek=(element,target,options)=>{
    requests.push({target,options});
    return faultySeek?new Promise(resolve=>{resolveFrame=resolve;}):seekDecodedFrame(element,target,{...options,timeoutMs:100});
  };
  const context=vm.createContext({state,play:()=>p,stopPlayback:()=>{},showDialog,toast:message=>notices.push(message),h:s=>String(s),AbortController,
    $:selector=>nodes[selector],$$:()=>choices,seekDecodedFrame:seek,
    analyzePossession:(play,options)=>{analyses.push(options.asOf);return {temporal:{samples:[]},coverage:{metrics:{available:0,total:0}}};},
    sec:t=>`${t.toFixed(2)} s`,format:(n,d)=>n.toFixed(d),viewPlay:play=>play,
    renderOverlay:(_,play,t)=>overlays.push(t)});
  vm.runInContext(decisionCode,context);
  return {state,v,stage,choices,requests,analyses,overlays,nodes,dialogs,notices,start:()=>context.decisionDialog(),complete:t=>resolveFrame({time:t,clock:'decoded-media-time',frameAccurate:true}),text:()=>[...dialogs.flatMap(d=>[d.title,d.html,d.footer]),...notices,nodes['#decision-facts'].textContent].join(' ')};
}

test('decision locating keeps the original video stage invisible and all choices disabled',async()=>{
  const env=decisionHarness(),pending=env.start();
  try{
    assert.equal(env.requests[0].target,.8);assert.equal(env.requests[0].options.before,1);
    assert.equal(env.choices.length,3);
    assert.equal(invisible(env.stage),true,'A displayed prime/fresh frame can already reveal the shot or its result before validation.');
    assert.ok(env.choices.every(choice=>choice.disabled));assert.equal(env.state.decision.time,null);
  }finally{env.state.decision.frameController.abort();await pending;}
});

test('late real decoding 1.05 for target .8 never exposes the decision stage or enables recording a choice',async()=>{
  const env=decisionHarness(),pending=env.start();env.v.emitSeek();env.v.emitFrame(1.05);await pending;
  console.log('late decision frame:',{target:.8,shot:1,result:1.04,time:env.state.decision.time,invisible:invisible(env.stage),choicesDisabled:env.choices.every(choice=>choice.disabled),analyses:env.analyses});
  assert.equal(invisible(env.stage),true);assert.ok(env.choices.every(choice=>choice.disabled));
  assert.equal(env.state.decision.time,null);assert.deepEqual(env.analyses,[]);assert.deepEqual(env.overlays,[]);
  assert.equal(env.v.paused,true);assert.equal(env.v.callbacks.size,0);assert.equal(env.v.listenerCount(),0);
});

test('decision UI independently rejects a late frame even if the media helper returned it',async()=>{
  const env=decisionHarness({faultySeek:true}),pending=env.start();env.complete(1.05);await pending;
  assert.equal(invisible(env.stage),true);assert.ok(env.choices.every(choice=>choice.disabled));
  assert.equal(env.state.decision.time,null);assert.deepEqual(env.analyses,[]);assert.deepEqual(env.overlays,[]);
});

test('only an actual frame strictly before shot and result reveals the decision stage and choices',async()=>{
  const env=decisionHarness(),pending=env.start();env.v.emitSeek();env.v.emitFrame(.96);await pending;
  assert.equal(invisible(env.stage),false);assert.equal(env.choices.length,3);assert.ok(env.choices.every(choice=>!choice.disabled));
  assert.equal(env.state.decision.time,.96);assert.deepEqual(env.analyses,[.96]);assert.deepEqual(env.overlays,[.96]);
});

const unavailableAnchors=[
  ['both event anchors are null',{shotTime:null,resultTime:null}],
  ['only a result anchor exists',{shotTime:null,resultTime:1.04}],
  ['shot anchor is NaN',{shotTime:NaN,resultTime:null}],
  ['shot anchor is positive infinity',{shotTime:Infinity,resultTime:null}],
  ['shot anchor is negative infinity',{shotTime:-Infinity,resultTime:null}],
  ['shot anchor precedes the possession',{shotTime:-.1,resultTime:null}],
  ['shot anchor equals possession start and has no prior frame',{shotTime:0,resultTime:null}],
  ['shot anchor follows the possession',{shotTime:2.1,resultTime:null}],
  ['provided result anchor is NaN',{shotTime:1,resultTime:NaN}],
  ['provided result anchor is positive infinity',{shotTime:1,resultTime:Infinity}],
  ['provided result anchor is negative infinity',{shotTime:1,resultTime:-Infinity}],
  ['provided result anchor precedes the possession',{shotTime:1,resultTime:-.1}],
  ['provided result anchor follows the possession',{shotTime:1,resultTime:2.1}],
  ['provided result anchor precedes the shot',{shotTime:1,resultTime:.9}],
];

for(const [label,playOverrides] of unavailableAnchors){
  test(`production decision refuses to locate or enable choices when ${label}`,async()=>{
    const env=decisionHarness({playOverrides}),pending=env.start();
    // This would make the old end-.2 fallback succeed; the unavailable production function must not request it.
    env.v.emitSeek();env.v.emitFrame(.96);await pending;
    assert.equal(env.requests.length,0,'No source-video probe is justified without the advertised before-shot boundary.');
    assert.ok(env.state.decision?.time==null);assert.deepEqual(env.analyses,[]);assert.deepEqual(env.overlays,[]);
    assert.ok(env.choices.every(choice=>choice.disabled));assert.ok(env.dialogs.length||env.notices.length,'Explain why this decision mode is unavailable.');
    assert.equal(env.v.callbacks.size,0);assert.equal(env.v.listenerCount(),0);
  });
}

test('a missing result anchor remains usable when a finite in-range shot anchor exists',async()=>{
  const env=decisionHarness({playOverrides:{shotTime:1,resultTime:null,screenTracks:[]}}),pending=env.start();
  env.v.emitSeek();env.v.emitFrame(.96);await pending;
  assert.equal(env.requests[0].options.before,1);assert.equal(env.state.decision.time,.96);
  assert.equal(env.choices.length,3);assert.ok(env.choices.every(choice=>!choice.disabled));assert.equal(invisible(env.stage),false);
});

test('an explicit shot event at the possession end is usable and is not an invented end fallback',async()=>{
  const env=decisionHarness({playOverrides:{shotTime:2,resultTime:null,screenTracks:[]}}),pending=env.start();
  env.v.emitSeek();env.v.emitFrame(1.96);await pending;
  assert.equal(env.requests[0].options.before,2);assert.equal(env.state.decision.time,1.96);
  assert.equal(env.choices.length,3);assert.ok(env.choices.every(choice=>!choice.disabled));assert.equal(invisible(env.stage),false);
});

test('result-only copy explains the missing shot time without offering a ball-still-in-hand decision',async()=>{
  const env=decisionHarness({playOverrides:{shotTime:null,resultTime:1.04,screenTracks:[]}}),pending=env.start();
  env.v.emitSeek();env.v.emitFrame(1.02);await pending;
  assert.equal(env.requests.length,0);assert.equal(env.choices.length,0);
  assert.match(env.text(),/出手(?:时间|时刻|锚点)/);
  assert.match(env.text(),/缺少|缺失|未提供|未知|没有|未(?:记录|标记|核对)/);
  console.log('result-only decision unavailable:',{requests:env.requests.length,choices:env.choices.length,dialogs:env.dialogs.map(d=>({title:d.title,html:d.html}))});
});
