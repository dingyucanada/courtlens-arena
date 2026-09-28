import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calibrationAt,projectAt,auditCalibration,createCalibrationSelector,validateCalibration,validateDynamicCalibration,
  addCalibrationKeyframe,addCalibrationCheckpoint} from '../pro/calibration.mjs';
import {frameAt,renderOverlay} from '../pro/render.mjs';

const input=JSON.parse(readFileSync(new URL('./fixtures/dynamic-camera.json',import.meta.url),'utf8'));
const fixture=()=>structuredClone(input.play);
const close=(actual,expected,tolerance=1e-9)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} ≠ ${expected}`);
function canvas(width=1280,height=720) {
  const ctx={canvas:{width,height},measureText:text=>({width:String(text).length*7})};
  for (const name of ['save','restore','beginPath','closePath','moveTo','lineTo','arc','ellipse','rect','roundRect','fill','stroke','fillText','clip','setLineDash'])ctx[name]=()=>{};
  return ctx;
}

// Expected numbers below are from the fixture's known camera equations, not from
// a second call to the fitting code. Court player A remains fixed at (20,20).
test('shift plus zoom uses timestamped anchors with independently known screen positions',()=>{
  const play=fixture(),calibration=play.calibration;
  const before=structuredClone(calibration);
  const atQuarter=projectAt(calibration,.25,[20,20]);
  close(atQuarter.x,.2825);close(atQuarter.y,.39875);
  const zoomed=projectAt(calibration,1.75,[20,20]);
  close(zoomed.x,.4175);close(zoomed.y,.39125);
  const cut=projectAt(calibration,2,[20,20]);close(cut.x,.34);close(cut.y,.48);
  const after=projectAt(calibration,2.25,[20,20]);close(after.x,.3475);close(after.y,.4775);
  assert.equal(calibrationAt(calibration,.25).interpolated,true);
  assert.equal(calibrationAt(calibration,2).segmentId,'cut-away');
  assert.deepEqual(calibration,before);
  assert.equal(validateDynamicCalibration(calibration).valid,true);
  assert.equal(validateCalibration(calibration).valid,true);
});

test('browser/offline shared renderer selects the same camera at time and field-locks historical trails',()=>{
  const play=fixture(),before=structuredClone(play);
  for (const [t,x,y] of [[.25,.2825,.39875],[1.75,.4175,.39125],[2,.34,.48],[2.25,.3475,.4775]]) {
    const rendered=renderOverlay(canvas(),play,t,{layers:['players','paths'],focusPlayer:'A'});
    assert.equal(rendered.playerCount,2);const a=rendered.players.find(p=>p.id==='A');
    close(a.point.x,x);close(a.point.y,y);
    assert.equal(rendered.calibration.segmentId,t<2?'pan-zoom':'cut-away');
    assert.equal(rendered.calibration.error.count,2);
    for (const trail of rendered.drawn.filter(row=>row.kind==='trail')) {
      for (const p of trail.points) {close(p.x,x);close(p.y,y);}
    }
  }
  assert.deepEqual(play,before);
});

test('cut boundaries never borrow a previous camera or extrapolate into unsupported edges',()=>{
  const play=fixture(),calibration=play.calibration;
  assert.equal(calibrationAt(calibration,2,{segmentId:'pan-zoom'}).valid,false);
  assert.equal(calibrationAt(calibration,3).valid,false);
  const gap=fixture().calibration;gap.segments[0].end=1.9;gap.segments[0].keyframes.pop();
  assert.equal(calibrationAt(gap,1.8).valid,false);
  const overlap=fixture().calibration;overlap.segments[1].start=1.9;
  assert.equal(calibrationAt(overlap,.25).valid,false);
  const duplicate=fixture().calibration;duplicate.segments[0].keyframes.push(structuredClone(duplicate.segments[0].keyframes[0]));
  assert.equal(calibrationAt(duplicate,.25).valid,false);
});

test('declared occlusion hides all automatic projection and blocks interpolation through it',()=>{
  const play=fixture();play.calibration.segments[0].invalidIntervals=[input.occlusion];
  assert.equal(calibrationAt(play.calibration,.25).valid,true);
  assert.equal(calibrationAt(play.calibration,1.25).valid,false);
  assert.equal(renderOverlay(canvas(),play,1.25).playerCount,0);
  assert.equal(calibrationAt(play.calibration,1.75).valid,true);
  const crossing=fixture().calibration;
  crossing.segments[0].invalidIntervals=[{start:.2,end:.3,reason:'identity lost',kind:'identity'}];
  assert.equal(calibrationAt(crossing,.1).valid,false);
  assert.equal(calibrationAt(crossing,.4).valid,false);
  assert.equal(calibrationAt(crossing,.75).valid,true);
});

test('audit reports measured independent errors, local failures, and rejects the four fitting points',()=>{
  const play=fixture(),segment=play.calibration.segments[0];
  segment.checkpoints[0].image[0]+=.006;
  let audit=auditCalibration(play.calibration),first=audit.segments[0];
  close(first.checkpoints[0].residual,.006);
  close(first.spans[0].error.max,.006);close(first.spans[0].error.rms,.006/Math.SQRT2);
  assert.equal(calibrationAt(play.calibration,.25).valid,true);
  segment.checkpoints[0].image[0]+=.01;
  audit=auditCalibration(play.calibration);close(audit.segments[0].checkpoints[0].residual,.016);
  assert.equal(calibrationAt(play.calibration,.25).valid,false);
  assert.equal(calibrationAt(play.calibration,.75).valid,true);
  segment.checkpoints[0].court=[0,0];
  audit=auditCalibration(play.calibration);
  assert.ok(audit.segments[0].checkpoints[0].errors.some(s=>s.includes('不是独立点')));
  assert.equal(calibrationAt(play.calibration,.25).valid,false);
});

test('missing independent evidence, unreviewed frames, wrong shot and long gaps fail closed',()=>{
  for (const mutate of [
    segment=>{segment.checkpoints=[];},
    segment=>{segment.keyframes[0].reviewed=false;},
    segment=>{segment.keyframes[0].segmentId='other-shot';},
    segment=>{segment.maxGap=.1;},
    segment=>{segment.keyframes[0].identityReliable=false;},
    segment=>{segment.interpolation='optical-flow';},
    segment=>{segment.checkpoints[0].independent=false;},
    segment=>{segment.checkpoints[0].t=NaN;}
  ]) {
    const play=fixture();mutate(play.calibration.segments[0]);
    assert.equal(calibrationAt(play.calibration,.25).valid,false);
    assert.equal(renderOverlay(canvas(),play,.25).playerCount,0);
    assert.throws(()=>projectAt(play.calibration,.25,[20,20]));
  }
});

test('matrix keyframes interpolate common anchors rather than arbitrary homography coefficients',()=>{
  const play=fixture();
  for (const segment of play.calibration.segments) for (const frame of segment.keyframes) {
    frame.matrix=calibrationAt(play.calibration,frame.t===3?2.999:frame.t).matrix;
    // Last endpoint of a segment must use that segment's own fitted matrix.
    const [a,b,c,d]=frame.imagePoints;
    const sx=(b[0]-a[0])/50,sy=(d[1]-a[1])/47;
    frame.matrix=[sx,0,a[0],0,sy,a[1],0,0,1];delete frame.imagePoints;
  }
  const actual=projectAt(play.calibration,.25,[20,20]);close(actual.x,.2825);close(actual.y,.39875);
});

test('immutable editor helpers save times and honestly retain a failing measured checkpoint',()=>{
  let calibration=fixture().calibration;const before=structuredClone(calibration);
  const keyframe={...calibration.segments[0].keyframes[0],source:'operator refreshed current frame'};
  calibration=addCalibrationKeyframe(calibration,'pan-zoom',keyframe);
  assert.deepEqual(before.segments[0].keyframes[0].source,'known fixture transform anchors');
  assert.equal(calibration.segments[0].keyframes[0].source,keyframe.source);
  const check={...calibration.segments[0].checkpoints[0],image:[.9,.9]};
  calibration=addCalibrationCheckpoint(calibration,'pan-zoom',check);
  assert.equal(auditCalibration(calibration).segments[0].checkpoints.find(row=>row.id===check.id).valid,false);
  assert.throws(()=>addCalibrationCheckpoint(calibration,'pan-zoom',{...check,independent:false}),/independent/);
  assert.throws(()=>addCalibrationKeyframe(calibration,'pan-zoom',{...keyframe,t:4}),/超出/);
});

test('legacy static backups remain intact and require an explicit stationary camera declaration',()=>{
  const staticCalibration={matrix:[.01,0,.1,0,.01,.2,0,0,1],reviewed:true,source:'old backup',start:0,end:300,segmentId:'fixed'};
  const before=structuredClone(staticCalibration);
  assert.equal(validateCalibration(staticCalibration).valid,true);
  const unknown=calibrationAt(staticCalibration,10);
  assert.equal(unknown.valid,false);assert.ok(unknown.reason.includes('stationary:true'));
  assert.deepEqual(staticCalibration,before);
  assert.equal(calibrationAt({...staticCalibration,stationary:true},10).valid,true);
  const actual=projectAt({...staticCalibration,stationary:true},10,[20,20]);close(actual.x,.3);close(actual.y,.4);
});

test('occluded or ambiguous identities are withheld at exact frames and during interpolation',()=>{
  const rows=[{t:0,players:[{id:'A',team:'HOU',x:.2,y:.3},{id:'D',team:'DAL',x:.4,y:.3}]},
    {t:.5,players:[{id:'A',team:'HOU',x:.3,y:.3,identityReliable:false},{id:'D',team:'DAL',x:.5,y:.3}]}];
  assert.deepEqual(frameAt(rows,.25).players.map(p=>p.id),['D']);
  assert.deepEqual(frameAt(rows,.5).players.map(p=>p.id),['D']);
  rows[0].players[1].occluded=true;assert.deepEqual(frameAt(rows,.25).players,[]);
  rows[1].occluded=true;assert.deepEqual(frameAt(rows,.5).players,[]);
});

test('screen tracks respect declared invalid intervals and do not interpolate across a hidden interval',()=>{
  const play={start:0,end:1,cameraSegments:[{id:'s',start:0,end:1,calibrated:true,
    invalidIntervals:[{start:.2,end:.3,reason:'occlusion',kind:'occlusion'}]}],
    screenTracks:[{t:0,segmentId:'s',players:[{id:'A',team:'HOU',x:.2,y:.3}]},
      {t:.5,segmentId:'s',players:[{id:'A',team:'HOU',x:.3,y:.3}]},
      {t:.75,segmentId:'s',players:[{id:'A',team:'HOU',x:.4,y:.3}]}]};
  assert.equal(renderOverlay(canvas(),play,.25).playerCount,0);
  assert.equal(renderOverlay(canvas(),play,.1).playerCount,0);
  assert.equal(renderOverlay(canvas(),play,.4).playerCount,0);
  assert.equal(renderOverlay(canvas(),play,.625).playerCount,1);
  const after=renderOverlay(canvas(),play,.625,{layers:['players','paths'],focusPlayer:'A'});
  for (const trail of after.drawn.filter(row=>row.kind==='trail')) assert.ok(trail.points.every(p=>p.t>=.5));
});


test('compiled render selector holds an immutable snapshot with the same gates as direct selection',()=>{
  const calibration=fixture().calibration,select=createCalibrationSelector(calibration);
  const direct=calibrationAt(calibration,.25);
  assert.deepEqual(select(.25),direct);
  calibration.segments[0].identityReliable=false;
  assert.equal(calibrationAt(calibration,.25).valid,false);
  assert.equal(select(.25).valid,true);
  assert.equal(select(NaN).valid,false);
});


test('final supplied court sample supports interpolation up to play end without rendering the excluded end',()=>{
  const play=fixture();
  const nearEnd=renderOverlay(canvas(),play,2.9,{layers:['players']});
  assert.equal(nearEnd.playerCount,2);
  close(nearEnd.players.find(row=>row.id==='A').point.x,.367);
  close(nearEnd.players.find(row=>row.id==='A').point.y,.471);
  assert.equal(renderOverlay(canvas(),play,3).playerCount,0);
  const fixed={start:0,end:1,tracking:{coordinateSystem:'court',units:'ft',maxGap:1,court:{width:50,length:47}},
    tracks:[{t:0,players:[{id:'A',team:'HOU',x:10,y:20}]},{t:1,players:[{id:'A',team:'HOU',x:20,y:20}]}],
    calibration:{start:0,end:1,stationary:true,reviewed:true,source:'verified stationary camera',matrix:[.01,0,.1,0,.01,.2,0,0,1]}};
  const result=renderOverlay(canvas(),fixed,.75,{layers:['players']});
  assert.equal(result.playerCount,1);close(result.players[0].point.x,.275);
});


test('dynamic calibrations require an explicit physical anchor unit',()=>{
  const calibration=fixture().calibration;delete calibration.court.units;
  assert.equal(calibrationAt(calibration,.25).valid,false);
  assert.ok(auditCalibration(calibration).errors.some(message=>message.includes('物理单位')));
});
