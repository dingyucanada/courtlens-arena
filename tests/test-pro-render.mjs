import test from 'node:test';
import assert from 'node:assert/strict';
import {frameAt,renderOverlay,drawCourt} from '../pro/render.mjs';

function canvas(width=1200,height=675) {
  const events=[];
  const ctx={canvas:{width,height},events,measureText:text=>({width:String(text).length*7}),
    createLinearGradient:()=>({addColorStop(){}})};
  for(const name of ['save','restore','beginPath','closePath','moveTo','lineTo','arc','ellipse','rect','roundRect','fill','stroke','fillText','clearRect','fillRect','clip','setLineDash'])ctx[name]=(...args)=>events.push({name,args});
  return ctx;
}
const player=(id,x,y,team='HOU')=>({id,x,y,team,name:id});
function fixture() {
  return {id:'p1',start:0,end:2,player:'H1',shotTime:.6,resultTime:1.5,outcome:'made',
    tracking:{coordinateSystem:'court',kind:'measured',units:'ft',court:{width:50,length:47},maxGap:.75},
    cameraSegments:[{id:'a',start:0,end:2,calibrated:true}],
    screenTracks:[{t:0,players:[player('H1',.3,.5),player('D1',.4,.5,'DAL')],ball:{x:.31,y:.51}},
      {t:.5,players:[player('H1',.4,.5),player('D1',.45,.5,'DAL')],ball:{x:.41,y:.51}},
      {t:1,players:[player('H1',.5,.5),player('D1',.55,.5,'DAL')],ball:{x:.51,y:.51}}],
    tracks:[{t:0,players:[player('H1',15,25),player('D1',20,25,'DAL')]},
      {t:.5,players:[player('H1',20,25),player('D1',22.5,25,'DAL')]},
      {t:1,players:[player('H1',25,25),player('D1',27.5,25,'DAL')]}],annotations:[]};
}

test('matching identities interpolate; disappearing players and ball are never fabricated',()=>{
  const list=[{t:0,players:[player('A',0,0),player('B',1,1)],ball:{x:0,y:1}},
    {t:.5,players:[player('A',1,1),player('C',0,0)],ball:null}];
  const result=frameAt(list,.25);
  assert.deepEqual(result.players.map(p=>p.id),['A']);assert.equal(result.players[0].x,.5);assert.equal(result.ball,null);
  assert.equal(frameAt(list,-.1),null);assert.equal(frameAt(list,.6),null);
});

test('long gaps, cut flags, camera identity changes and duplicate time samples stop interpolation',()=>{
  const a={t:0,players:[player('A',0,0)]},b={t:1,players:[player('A',1,1)]};
  assert.equal(frameAt([a,b],.5),null);
  assert.equal(frameAt([a,{...b,t:.5,cut:true}],.25),null);
  assert.equal(frameAt([{...a,segmentId:'a'},{...b,t:.5,segmentId:'b'}],.25),null);
  assert.equal(frameAt([a,{...a}],0),null);
});

test('ambiguous duplicate identity is withheld while identical IDs on different teams remain distinct',()=>{
  const a={t:0,players:[player('A',0,0),player('A',1,1),player('B',0,0,'HOU'),player('B',1,1,'DAL')]};
  const result=frameAt([a],0);assert.deepEqual(result.players.map(p=>[p.id,p.team]),[['B','HOU'],['B','DAL']]);
});

test('a shooter or string focus is scoped to the offense team when IDs repeat across teams',()=>{
  const play=fixture();play.player='7';play.team='HOU';
  play.screenTracks.forEach(f=>f.players=[player('7',.2,.3,'DAL'),player('7',.6,.7,'HOU')]);
  play.tracks.forEach(f=>f.players=[player('7',10,15,'DAL'),player('7',30,35,'HOU')]);
  const result=renderOverlay(canvas(),play,.25,{layers:['players','defenders']});
  assert.equal(result.players.find(p=>p.team==='DAL').focus,false);assert.equal(result.players.find(p=>p.team==='HOU').focus,true);
  const nearest=result.drawn.find(p=>p.kind==='nearest-court-defender');assert.equal(nearest.fromTeam,'HOU');assert.equal(nearest.team,'DAL');
  const explicit=drawCourt(canvas(),play,.25,{focusPlayer:{id:'7',team:'DAL'},layers:['players']});
  assert.equal(explicit.players.find(p=>p.team==='DAL').focus,true);assert.equal(explicit.players.find(p=>p.team==='HOU').focus,false);
});

test('screen tracks render exact pixel-linked positions without clearing the source video',()=>{
  const ctx=canvas(),actual=renderOverlay(ctx,fixture(),.25,{layers:['players','labels','paths','ball'],focusPlayer:'H1'});
  assert.equal(actual.status,'ready');assert.equal(actual.playerCount,2);
  assert.equal(actual.players.find(p=>p.id==='H1').point.x,.35);
  assert.equal(actual.drawn.filter(p=>p.kind==='trail').length,1);
  assert.ok(ctx.events.some(e=>e.name==='arc'&&Math.abs(e.args[0]-420)<1e-7));
  assert.equal(ctx.events.some(e=>e.name==='clearRect'),false);
});

test('court tracks cannot be copied onto video without an explicit valid camera calibration',()=>{
  const play=fixture();play.screenTracks=[];
  const result=renderOverlay(canvas(),play,.25);
  assert.equal(result.playerCount,0);assert.equal(result.status,'tracking-unavailable');assert.equal(result.drawn.length,0);
  play.calibration={stationary:true,matrix:[.01,0,.1,0,.01,.1,0,0,1],reviewed:true,source:'人工四角标定',start:0,end:2,segmentId:'a'};
  const mapped=renderOverlay(canvas(),play,.25);assert.equal(mapped.playerCount,2);assert.equal(mapped.source,'calibrated-court');
  assert.ok(Math.abs(mapped.players.find(p=>p.id==='H1').point.x-.275)<1e-10);
});

test('calibration from another camera or outside its time scope is never used',()=>{
  const play=fixture();play.screenTracks=[];
  play.calibration={stationary:true,matrix:[.01,0,.1,0,.01,.1,0,0,1],reviewed:true,source:'人工标定',start:0,end:.2,segmentId:'a'};
  assert.equal(renderOverlay(canvas(),play,.25).playerCount,0);
  play.calibration.end=2;play.calibration.segmentId='other';assert.equal(renderOverlay(canvas(),play,.25).playerCount,0);
});

test('perspective projection follows interpolated court motion, not image-space approximation',()=>{
  const play=fixture();play.screenTracks=[];
  play.calibration={stationary:true,matrix:[.02,0,0,0,.02,0,.02,0,1],reviewed:true,source:'人工标定',start:0,end:2,segmentId:'a'};
  const result=renderOverlay(canvas(),play,.25,{focusPlayer:'H1'});
  const actual=result.players.find(p=>p.id==='H1').point;
  assert.ok(Math.abs(actual.x-.35/1.35)<1e-9);assert.ok(Math.abs(actual.y-.5/1.35)<1e-9);
  const trail=result.drawn.find(r=>r.kind==='trail'&&r.id==='H1');
  assert.ok(Math.abs(trail.points.at(-1).x-actual.x)<1e-9);
});

test('normalized rectangular court positions project in physical units and preserve source records',()=>{
  const play=fixture();play.screenTracks=[];play.tracking.court={width:50,length:94,units:'ft'};
  play.calibration={stationary:true,matrix:[.01,0,.1,0,.01,.1,0,0,1],court:{units:'ft'},reviewed:true,source:'known feet transform',start:0,end:2,segmentId:'a'};
  play.tracks.forEach(f=>f.ball={x:f.players[0].x+1,y:26});
  const physical=structuredClone(play),physicalCourt=drawCourt(canvas(),physical,.25,{layers:['players','defenders','paths','ball']});
  play.tracking.units='normalized';
  play.tracks.forEach(f=>{for(const p of [...f.players,f.ball]){p.x/=50;p.y/=94;}});
  play.sourceRecord=structuredClone(play);const before=structuredClone(play);
  const overlay=renderOverlay(canvas(),play,.25,{layers:['players','defenders','paths']}),court=drawCourt(canvas(),play,.25,{layers:['players','defenders','paths','ball']});
  assert.equal(overlay.playerCount,2);assert.equal(court.playerCount,2);
  const point=overlay.players.find(p=>p.id==='H1').point;
  assert.ok(Math.abs(point.x-.275)<1e-10);assert.ok(Math.abs(point.y-.35)<1e-10);
  assert.deepEqual(court.players,physicalCourt.players);
  assert.deepEqual(court.drawn,physicalCourt.drawn);
  const nearest=overlay.drawn.find(r=>r.kind==='nearest-court-defender');assert.equal(nearest.distance,3.75);assert.equal(nearest.unit,'ft');
  assert.deepEqual(play,before);
});

test('meter and normalized meter tracking agree with feet and meter calibrations',()=>{
  const feet=fixture();feet.screenTracks=[];
  feet.calibration={stationary:true,matrix:[.02,0,0,0,.02,0,.02,0,1],court:{units:'ft'},reviewed:true,source:'manual',start:0,end:2,segmentId:'a'};
  const expected=renderOverlay(canvas(),feet,.25),expectedCourt=drawCourt(canvas(),feet,.25,{layers:['players','defenders']});
  for(const normalized of [false,true])for(const calibrationUnit of ['ft','m','legacy-manual-ft','legacy-import-m']) {
    const play=structuredClone(feet);play.tracking.units=normalized?'normalized':'m';
    play.tracking.court={width:50*.3048,length:47*.3048,units:'m'};
    play.tracks.forEach(f=>f.players.forEach(p=>{p.x=normalized?p.x/50:p.x*.3048;p.y=normalized?p.y/47:p.y*.3048;}));
    if(calibrationUnit==='m'||calibrationUnit==='legacy-import-m'){
      play.calibration.source='imported';play.calibration.court.units='m';
      play.calibration.matrix=play.calibration.matrix.map((v,i)=>[0,1,3,4,6,7].includes(i)?v/.3048:v);
    }
    if(calibrationUnit.startsWith('legacy'))delete play.calibration.court.units;
    const overlay=renderOverlay(canvas(),play,.25),court=drawCourt(canvas(),play,.25,{layers:['players','defenders']});
    assert.equal(overlay.playerCount,2);assert.equal(court.playerCount,2);
    for(const player of overlay.players){const reference=expected.players.find(p=>p.id===player.id);assert.ok(Math.abs(player.point.x-reference.point.x)<1e-10);assert.ok(Math.abs(player.point.y-reference.point.y)<1e-10);}
    for(const player of court.players){const reference=expectedCourt.players.find(p=>p.id===player.id);assert.ok(Math.abs(player.screenPoint.x-reference.screenPoint.x)<1e-10);assert.ok(Math.abs(player.screenPoint.y-reference.screenPoint.y)<1e-10);}
    const relation=court.drawn.find(r=>r.kind==='nearest-court-defender');assert.equal(relation.unit,'m');assert.ok(Math.abs(relation.distance/.3048-3.75)<1e-10);
  }
});

test('physical court rendering requires declared extents without changing independent screen tracks',()=>{
  for(const court of [{},{width:50},{length:47},{width:50,length:47,units:'unknown'}]) {
    const play=fixture();play.tracking.court=court;
    const screen=structuredClone(play.screenTracks),video=renderOverlay(canvas(),play,.25);
    assert.equal(video.playerCount,2);assert.equal(video.source,'screen-tracks');assert.equal(video.players.find(p=>p.id==='H1').point.x,.35);
    const miniature=drawCourt(canvas(),play,.25);assert.equal(miniature.playerCount,0);assert.equal(miniature.status,'tracking-unavailable');assert.deepEqual(miniature.drawn,[]);
    assert.deepEqual(play.screenTracks,screen);
  }
  for(const court of [{width:50,length:47},{width:50,units:'ft'},{length:47,units:'ft'},{width:50,length:47,units:'unknown'}]) {
    const play=fixture();play.screenTracks=[];play.tracking={...play.tracking,units:'normalized',court};
    play.calibration={stationary:true,matrix:[.01,0,.1,0,.01,.1,0,0,1],reviewed:true,source:'input',start:0,end:2,segmentId:'a'};
    assert.equal(renderOverlay(canvas(),play,.25).playerCount,0);assert.equal(drawCourt(canvas(),play,.25).playerCount,0);
  }
});

test('normalized coordinates outside the supplied court are withheld before projection',()=>{
  const play=fixture();play.screenTracks=[];play.tracking={...play.tracking,units:'normalized',court:{width:50,length:94,units:'ft'}};
  play.calibration={stationary:true,matrix:[.01,0,.1,0,.01,.1,0,0,1],court:{units:'ft'},reviewed:true,source:'input',start:0,end:2,segmentId:'a'};
  play.tracks.forEach(f=>{f.players=[player('H1',1.01,.4)];f.ball={x:.4,y:-.01};});
  assert.equal(renderOverlay(canvas(),play,.25).playerCount,0);assert.equal(drawCourt(canvas(),play,.25).drawn.length,0);
});

test('unreviewed camera stops automatic points; independent manual image annotations still work',()=>{
  const play=fixture();play.cameraSegments[0].calibrated=false;
  play.annotations=[{id:'manual',kind:'arrow',origin:'manual',start:0,end:1,points:[[.2,.2],[.3,.3]],label:'人工观察'},
    {id:'automatic',kind:'zone',start:0,end:1,points:[[.4,.4],[.5,.5]],label:'自动候选'}];
  const result=renderOverlay(canvas(),play,.25);
  assert.equal(result.playerCount,0);assert.equal(result.status,'manual-only');assert.deepEqual(result.drawn.map(p=>p.id),['manual']);
});

test('manual zones/tags use only normalized active points and respect layer visibility',()=>{
  const play={start:0,end:2,annotations:[{id:'zone',kind:'zone',origin:'manual',start:0,end:1,points:[[.2,.2],[.3,.3]]},
    {id:'tag',kind:'tag',origin:'manual',start:0,end:1,points:[{x:.4,y:.4}],label:'空间'},
    {id:'bad',kind:'arrow',origin:'manual',start:0,end:1,points:[[.1,.1],[50,20]]}]};
  assert.deepEqual(renderOverlay(canvas(),play,.5,{layers:['zones']}).drawn.map(p=>p.id),['zone']);
  assert.deepEqual(renderOverlay(canvas(),play,.5,{layers:['labels']}).drawn.map(p=>p.id),['tag']);
  assert.equal(renderOverlay(canvas(),play,1.1).drawn.length,0);
});

test('metric and outcome layers cannot reveal information before their respective event times',()=>{
  const play=fixture();play.metrics={xfg_pct:{value:.6,semantics:'shot_make_probability',availableAt:.6}};
  const options={layers:['metrics'],revealOutcome:true};
  assert.equal(renderOverlay(canvas(),play,.25,options).drawn.length,0);
  assert.ok(renderOverlay(canvas(),play,.8,options).drawn.some(r=>r.kind==='metric'));
  assert.equal(renderOverlay(canvas(),play,.8,options).drawn.some(r=>r.kind==='outcome'),false);
  assert.ok(renderOverlay(canvas(),play,1.6,options).drawn.some(r=>r.kind==='outcome'));
  play.resultTime=null;assert.equal(renderOverlay(canvas(),play,1.6,options).drawn.some(r=>r.kind==='outcome'),false);
});

test('automatic layers stop at cuts and never bridge paths into another camera',()=>{
  const play=fixture();play.cameraSegments=[{id:'a',start:0,end:.5,calibrated:true},{id:'b',start:.5,end:2,calibrated:false}];
  assert.equal(renderOverlay(canvas(),play,.5).playerCount,0);
  play.cameraSegments=[];play.screenTracks.forEach((f,i)=>f.segmentId=i===0?'a':'b');
  const result=renderOverlay(canvas(),play,.5,{focusPlayer:'H1'});
  assert.equal(result.playerCount,2);assert.equal(result.drawn.filter(r=>r.kind==='trail').length,0);
});

test('nearest image defender is explicitly a pixel-space relation and requires known opposing teams',()=>{
  const play=fixture();play.tracks=[];
  const result=renderOverlay(canvas(),play,.25,{layers:['defenders'],focusPlayer:'H1'});
  const relation=result.drawn.find(r=>r.kind==='nearest-image-defender');assert.equal(relation.id,'D1');
  assert.ok(relation.label.includes('不是球场距离'));assert.equal(relation.distance,undefined);
});

test('video defender line prefers real court distance over misleading perspective proximity',()=>{
  const play=fixture();
  play.screenTracks.forEach(f=>f.players=[player('H1',.1,.5),player('D1',.12,.5,'DAL'),player('D2',.5,.5,'DAL')]);
  play.tracks.forEach(f=>f.players=[player('H1',10,25),player('D1',30,25,'DAL'),player('D2',11,25,'DAL')]);
  const result=renderOverlay(canvas(),play,.25,{layers:['defenders'],focusPlayer:'H1'});
  const relation=result.drawn.find(r=>r.kind==='nearest-court-defender');assert.equal(relation.id,'D2');assert.equal(relation.distance,1);assert.equal(relation.unit,'ft');
});

test('the final known frame supports interpolation until play end but not across an internal cut',()=>{
  const play=fixture();play.end=1;play.cameraSegments[0].end=1;
  assert.equal(renderOverlay(canvas(),play,.75).playerCount,2);
  play.cameraSegments=[{id:'a',start:0,end:.5,calibrated:true},{id:'b',start:.5,end:1,calibrated:true}];
  assert.equal(renderOverlay(canvas(),play,.25).playerCount,0);
});

test('malformed optional annotation and track rows are omitted without crashing the renderer',()=>{
  const play=fixture();play.annotations=[null,{kind:'tag',origin:'manual',start:0,end:1,points:[null]}];
  play.screenTracks.unshift(null,{t:.1,players:null});
  assert.equal(renderOverlay(canvas(),play,.25).playerCount,2);
});

test('independent court view renders supplied or schematic positions, never reinterprets image points',()=>{
  const play=fixture(),result=drawCourt(canvas(600,420),play,.25,{focusPlayer:'H1',layers:['players','defenders']});
  assert.equal(result.playerCount,2);assert.equal(result.source,'supplied-court');
  const distance=result.drawn.find(r=>r.kind==='nearest-court-defender');assert.equal(distance.distance,3.75);assert.equal(distance.unit,'ft');
  play.tracking.kind='schematic';assert.equal(drawCourt(canvas(),play,.25).source,'schematic-court');
  play.tracks=[];assert.equal(drawCourt(canvas(),play,.25).playerCount,0);
});

test('court positions can remain visible when the camera projection is uncalibrated',()=>{
  const play=fixture();play.cameraSegments[0].calibrated=false;
  assert.equal(renderOverlay(canvas(),play,.25).playerCount,0);
  assert.equal(drawCourt(canvas(),play,.25).playerCount,2);
});

test('missing units, off-court positions, out-of-play times and invalid canvas fail safely',()=>{
  const play=fixture();play.tracking.units='unknown';assert.equal(drawCourt(canvas(),play,.25).playerCount,0);
  play.tracking.units='ft';play.tracks.forEach(f=>f.players.forEach(p=>p.x=500));assert.equal(drawCourt(canvas(),play,.25).playerCount,0);
  assert.equal(renderOverlay(canvas(),play,2).status,'outside-play');
  assert.equal(renderOverlay(canvas(),fixture(),.5,{width:0,height:675}).drawn.length,0);
});
