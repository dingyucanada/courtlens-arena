import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {playAt,storyFrameAt} from '../pro/camera-view.mjs';
import {renderOverlay} from '../pro/render.mjs';

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} ≠ ${expected}`);
const dynamic=()=>structuredClone(JSON.parse(readFileSync(new URL('./fixtures/dynamic-camera.json',import.meta.url),'utf8')).play);
function canvas() {
  const ctx={canvas:{width:1200,height:675},measureText:text=>({width:String(text).length*7})};
  for (const name of ['save','restore','beginPath','closePath','moveTo','lineTo','arc','ellipse','rect','roundRect','fill','stroke','fillText','clip','setLineDash'])ctx[name]=()=>{};
  return ctx;
}
function fixed() {
  const play={id:'fixed',start:0,end:2,player:'A',team:'HOU',tracking:{coordinateSystem:'court',units:'ft',maxGap:1,court:{width:50,length:47}},
    tracks:[{t:0,segmentId:'a',players:[{id:'A',team:'HOU',x:20,y:20}]},{t:1,segmentId:'a',players:[{id:'A',team:'HOU',x:20,y:20}]}],
    cameraSegments:[{id:'a',start:0,end:2,calibrated:false}],screenTracks:[],sourceRecord:{camera:'original'},annotations:[]};
  const calibration={id:'local-a',playId:'fixed',start:0,end:2,segmentId:'a',stationary:true,reviewed:true,source:'manual',
    matrix:[.01,0,.1,0,.01,.2,0,0,1],court:{units:'ft'}};
  return {schema:'courtlens-arena/1',id:'test',plays:[play],calibrations:[calibration]};
}

test('project-level stationary calibration is shared by preview and native rendering without rewriting source geometry',()=>{
  const project=fixed(),play=project.plays[0],before=structuredClone(project);
  assert.equal(renderOverlay(canvas(),play,.5).playerCount,0);
  const preview=playAt(project,play,.5),native=storyFrameAt(project,play,.5,{arrows:[],layers:{players:true}}).play;
  const a=renderOverlay(canvas(),preview,.5),b=renderOverlay(canvas(),native,.5);
  assert.equal(a.playerCount,1);assert.deepEqual(a.players,b.players);
  close(a.players[0].point.x,.3);close(a.players[0].point.y,.4);
  assert.equal(preview.cameraSegments[0].calibrated,true);
  assert.equal(preview.tracks,play.tracks);assert.equal(preview.screenTracks,play.screenTracks);assert.equal(preview.sourceRecord,play.sourceRecord);
  assert.deepEqual(project,before);
});

test('legacy unknown-motion calibration, ambiguous project rows and a wrong scene fail closed',()=>{
  for (const mutate of [
    project=>{delete project.calibrations[0].stationary;},
    project=>{project.calibrations.push({...project.calibrations[0],id:'overlap'});},
    project=>{project.calibrations[0].segmentId='wrong-scene';},
    project=>{project.calibrations[0].reviewed=false;}
  ]) {
    const project=fixed();mutate(project);const play=project.plays[0],before=structuredClone(project);
    assert.equal(renderOverlay(canvas(),playAt(project,play,.5),.5).playerCount,0);
    assert.equal(playAt(project,play,.5).cameraSegments[0].calibrated,false);
    assert.deepEqual(project,before);
  }
});

test('one stationary matrix cannot silently span a source camera cut',()=>{
  const project=fixed(),play=project.plays[0];
  play.cameraSegments=[{id:'a',start:0,end:1,calibrated:false},{id:'b',start:1,end:2,calibrated:false}];
  delete project.calibrations[0].segmentId;
  const view=playAt(project,play,.5);
  assert.equal(view.cameraSegments[0].calibrated,false);
  assert.equal(renderOverlay(canvas(),view,.5).playerCount,0);
  assert.ok(view.calibration.source.includes('切镜'));
});

test('moving camera view projects known coordinates but never changes official track or camera IDs',()=>{
  const play=dynamic(),project={plays:[play],calibrations:[]};
  play.cameraSegments=play.calibration.segments.map(s=>({id:s.id,start:s.start,end:s.end,calibrated:false}));
  const before=structuredClone(project),view=playAt(project,play,.25);
  assert.equal(view.cameraSegments[0].calibrated,true);assert.equal(view.cameraSegments[1].calibrated,false);
  const first=renderOverlay(canvas(),view,.25);assert.equal(first.playerCount,2);
  close(first.players.find(p=>p.id==='A').point.x,.2825);close(first.players.find(p=>p.id==='A').point.y,.39875);
  const cut=renderOverlay(canvas(),playAt(project,play,2),2);assert.equal(cut.playerCount,2);
  close(cut.players.find(p=>p.id==='A').point.x,.34);close(cut.players.find(p=>p.id==='A').point.y,.48);
  assert.deepEqual(project,before);assert.equal(view.tracks,play.tracks);
  play.cameraSegments[0].id='provider-different-id';
  const mismatch=playAt(project,play,.25);assert.equal(mismatch.cameraSegments[0].calibrated,false);
  assert.equal(renderOverlay(canvas(),mismatch,.25).playerCount,0);
});

test('dynamic view cannot mark a wider moving shot reliable when source camera cuts earlier',()=>{
  const play=dynamic(),project={plays:[play],calibrations:[]};
  play.cameraSegments=[{id:'pan-zoom',start:0,end:1,calibrated:false},{id:'second-cut',start:1,end:2,calibrated:false},{id:'cut-away',start:2,end:3,calibrated:false}];
  const view=playAt(project,play,.25);
  assert.equal(view.cameraSegments[0].calibrated,false);
  assert.equal(renderOverlay(canvas(),view,.25).playerCount,0);
});

test('reviewed arrows replace source manual arrows exactly once; deletion and edits leave no old geometry',()=>{
  const project=fixed(),play=project.plays[0];
  play.annotations=[{id:'old',kind:'arrow',origin:'manual',start:0,end:2,points:[[.1,.1],[.9,.1]],label:'old geometry'},
    {id:'manual-source',kind:'arrow',source:'manual',start:0,end:2,points:[[.1,.2],[.9,.2]]},
    {id:'zone',kind:'zone',origin:'manual',start:0,end:2,points:[[.2,.2],[.4,.4]]},
    {id:'tag',kind:'tag',origin:'manual',start:0,end:2,points:[[.3,.3]],label:'keep'},
    {id:'provider',kind:'arrow',source:'provider',start:0,end:2,points:[[.5,.5],[.6,.6]],label:'supplied'}];
  const arrow={id:'reviewed',playId:play.id,start:0,end:1,origin:'manual',points:[{x:.2,y:.7},{x:.7,y:.7}]};
  const plan={arrows:[arrow],layers:{players:true,paths:true,zones:true,labels:true}},before=structuredClone(project);
  const frame=storyFrameAt(project,play,.5,plan);
  assert.deepEqual(frame.arrows,[arrow]);
  assert.deepEqual(frame.play.annotations.map(row=>row.id),['zone','tag','provider']);
  const overlay=renderOverlay(canvas(),frame.play,.5,{layers:plan.layers});
  assert.equal(overlay.drawn.filter(row=>row.kind==='arrow'&&row.source==='manual-image-annotation').length,0);
  assert.ok(overlay.drawn.some(row=>row.id==='zone'));assert.ok(overlay.drawn.some(row=>row.id==='tag'));assert.ok(overlay.drawn.some(row=>row.id==='provider'));
  const deleted=storyFrameAt(project,play,.5,{...plan,arrows:[]});
  assert.deepEqual(deleted.arrows,[]);assert.equal(deleted.play.annotations.some(row=>row.id==='old'),false);
  const edited={...arrow,points:[{x:.2,y:.4},{x:.7,y:.4}]};
  assert.deepEqual(storyFrameAt(project,play,.5,{...plan,arrows:[edited]}).arrows[0].points,edited.points);
  assert.deepEqual(storyFrameAt(project,play,1.5,plan).arrows,[]);
  assert.deepEqual(storyFrameAt(project,play,.5,{...plan,layers:{...plan.layers,paths:false}}).arrows,[]);
  assert.deepEqual(project,before);
});

test('native MP4 shows project calibration and only the current reviewed manual arrow geometry',
  {skip:process.env.ARENA_EXPORT_INTEGRATION!=='1'},async()=>{
    const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
    const {spawnSync}=await import('node:child_process'),{createHash}=await import('node:crypto');
    const {createRequire}=await import('node:module'),{pathToFileURL}=await import('node:url');
    const {createLocalStoryPlan,reviewStoryPlan,reviseStoryPlan}=await import('../pro/story-plan.mjs');
    const {exportReviewedStoryPlan}=await import('../tools/export_story_plan.mjs');
    const task=await fs.mkdtemp(path.join(os.tmpdir(),'courtlens-camera-view-'));
    const run=(args)=>{const result=spawnSync('ffmpeg',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
    try {
      const video=path.join(task,'source.mp4');
      run(['-v','error','-f','lavfi','-i','color=c=navy:s=320x180:r=10:d=2','-c:v','libx264','-pix_fmt','yuv420p','-an',video]);
      const project=fixed();Object.assign(project,{name:'Native calibration smoke',revision:0,provenance:{kind:'synthetic',source:'generated camera test'},playlist:[{playId:'fixed',start:0,end:2}]});
      project.video={sha256:createHash('sha256').update(await fs.readFile(video)).digest('hex'),duration:2};
      const play=project.plays[0];Object.assign(play,{title:'Synthetic view test',shotTime:.5,resultTime:1.5,shotValue:2,outcome:'unknown',metrics:{}});
      play.annotations=[{id:'old-source-arrow',kind:'arrow',origin:'manual',start:0,end:2,points:[[.1,.2],[.9,.2]]}];
      const arrow={id:'reviewed',playId:'fixed',start:0,end:2,evidenceIds:['fixed:event'],playerId:null,origin:'manual',color:'#FF00FF',points:[{x:.1,y:.7},{x:.9,y:.7}]};
      const pending=await createLocalStoryPlan(project,{arrows:[arrow],layers:{players:true,paths:true,labels:false,zones:false,ball:false,metrics:false,defenders:false}});
      const plan=await reviewStoryPlan(pending,{reviewer:'Native pixel integration'});
      const options={plan,video,font:process.env.ARENA_CJK_FONT,releaseDir:path.join(task,'releases'),width:320,height:180,fps:10};
      const edited=await exportReviewedStoryPlan(options);
      const removedPlan=await reviewStoryPlan(await reviseStoryPlan(plan,{arrows:[]}),{reviewer:'Native deletion integration'});
      const deleted=await exportReviewedStoryPlan({...options,plan:removedPlan});
      const require=createRequire(import.meta.url);let runtime;
      try {runtime=require('@napi-rs/canvas');} catch {runtime=await import(pathToFileURL(path.join(process.env.RUNTIME_NODE_MODULES,'@napi-rs/canvas/index.js')).href);}
      const pixels=async(file,name)=>{const png=path.join(task,name);run(['-v','error','-ss','0.5','-i',file,'-frames:v','1',png]);const canvas=runtime.createCanvas(320,180),ctx=canvas.getContext('2d');ctx.drawImage(await runtime.loadImage(png),0,0);return ctx.getImageData(0,0,320,180).data;};
      const before=await pixels(edited.video,'edited.png'),after=await pixels(deleted.video,'deleted.png');
      const count=(data,x0,y0,x1,y1,predicate)=>{let total=0;for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const offset=(y*320+x)*4;if(predicate(data[offset],data[offset+1],data[offset+2]))total++;}return total;};
      // Player (20,20) under the project matrix is (96,72) in this 320x180 frame.
      const red=(r,g,b)=>r>120&&r>1.6*g&&r>1.6*b;
      assert.ok(count(before,88,64,104,80,red)>5,'project-level stationary calibration must render the player in native MP4');
      assert.ok(count(after,88,64,104,80,red)>5,'deleting an arrow must preserve the calibrated player');
      const magenta=(r,g,b)=>r>150&&g<100&&b>120;
      assert.ok(count(before,100,123,220,129,magenta)>30,'edited plan arrow should appear at its reviewed y=.7');
      assert.equal(count(after,100,123,220,129,magenta),0,'deleted plan arrow must leave no old geometry');
      const cyan=(r,g,b)=>g>120&&b>120;
      assert.equal(count(before,100,34,220,38,cyan),0,'source manual arrow must not survive under the reviewed edit');
      assert.equal(count(after,100,34,220,38,cyan),0,'source manual arrow must not reappear after reviewed deletion');
    } finally {await fs.rm(task,{recursive:true,force:true});}
  });
