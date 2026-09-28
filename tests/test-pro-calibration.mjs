import test from 'node:test';
import assert from 'node:assert/strict';
import {solveHomography,projectPoint,mapTime,validateCalibration} from '../pro/calibration.mjs';

const square=[[0,0],[50,0],[50,47],[0,47]];
const screen=[[.1,.9],[.9,.9],[.75,.2],[.25,.2]];
const close=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} ≠ ${expected}`);

test('planar calibration preserves all four matched corners, supports object and array points',()=>{
  const matrix=solveHomography(square.map(([x,y])=>({x,y})),screen);
  assert.equal(matrix.length,9);
  square.forEach((p,i)=>{const actual=projectPoint(matrix,p);close(actual.x,screen[i][0]);close(actual.y,screen[i][1]);});
  close(projectPoint(matrix,{x:25,y:0}).x,.5);
  close(projectPoint(matrix,{x:25,y:47}).x,.5);
});

test('independent interior point recovers a known non-affine perspective transform',()=>{
  const known=[1.2,.15,3,.05,.9,7,.002,.004,1];
  const targets=square.map(p=>projectPoint(known,p));
  const recovered=solveHomography(square,targets);
  const actual=projectPoint(recovered,{x:25,y:20});
  close(actual.x,36/1.13);close(actual.y,26.25/1.13);
});

test('collinear, duplicate, wrong count and non-finite calibration points are rejected',()=>{
  assert.throws(()=>solveHomography([[0,0],[1,0],[2,0],[0,1]],screen),/共线/);
  assert.throws(()=>solveHomography([[0,0],[0,0],[1,1],[0,1]],screen),/重合/);
  assert.throws(()=>solveHomography(square.slice(0,3),screen),/四对/);
  assert.throws(()=>solveHomography(square,[[0,0],[1,0],[1,1],[NaN,1]]),/有限/);
});

test('projection refuses zero denominators rather than fabricating an offscreen location',()=>{
  assert.throws(()=>projectPoint([1,0,0,0,1,0,1,0,0],{x:0,y:1}),/无穷/);
  assert.throws(()=>projectPoint([1,0,0],{x:1,y:1}),/9 个/);
});

test('operator source and review are required; contradiction and singular matrix fail closed',()=>{
  const base={courtPoints:square,imagePoints:screen,source:'人工四角对应',reviewed:true,start:0,end:10};
  assert.equal(validateCalibration(base).valid,true);
  assert.ok(validateCalibration(base).warnings.some(s=>s.includes('独立检查点')));
  assert.equal(validateCalibration({...base,source:''}).valid,false);
  assert.equal(validateCalibration({...base,reviewed:false}).valid,false);
  assert.equal(validateCalibration({...base,calibrated:false}).valid,false);
  assert.equal(validateCalibration({...base,matrix:[1,0,0,0,0,0,0,0,1]}).valid,false);
});

test('independent check points report measured residual and can reject poor calibration',()=>{
  const base={matrix:[.01,0,.1,0,.01,.1,0,0,1],source:'人工标定',reviewed:true,start:0,end:10,
    checkPoints:[{court:[10,10],image:[.2,.2]},{court:[20,20],image:[.31,.3]}]};
  const actual=validateCalibration(base);
  assert.equal(actual.valid,true);assert.equal(actual.error.count,2);close(actual.error.max,.01);
  close(actual.error.rms,.01/Math.SQRT2);
  assert.equal(validateCalibration({...base,maxError:.005}).valid,false);
});

test('calibration rejects invalid scope and non-normalized image positions',()=>{
  assert.equal(validateCalibration({courtPoints:square,imagePoints:[[0,0],[2,0],[2,1],[0,1]],source:'点击',reviewed:true}).valid,false);
  assert.equal(validateCalibration({courtPoints:square,imagePoints:screen,source:'点击',reviewed:true,start:5,end:4}).valid,false);
});

test('time mapping uses local piecewise slopes and exact verified anchors',()=>{
  const anchors=[{source:20,video:35},{source:0,video:10},{source:10,video:30}];
  close(mapTime(5,anchors),20);close(mapTime(15,anchors),32.5);assert.equal(mapTime(20,anchors),35);
  assert.equal(mapTime(5,[{sourceTime:5,videoTime:12}]),12);
});

test('time mapping forbids extrapolation, reversed clocks and duplicate source anchors',()=>{
  const anchors=[{source:0,video:10},{source:10,video:20}];
  assert.throws(()=>mapTime(-1,anchors),/禁止外推/);
  assert.throws(()=>mapTime(11,anchors),/禁止外推/);
  assert.throws(()=>mapTime(5,[{source:0,video:20},{source:10,video:10}]),/递增/);
  assert.throws(()=>mapTime(0,[{source:0,video:10},{source:0,video:20}]),/唯一/);
  assert.throws(()=>mapTime(null,anchors),/有限/);
});

test('separate clock/camera segments cannot be interpolated across',()=>{
  const anchors=[{source:0,video:10,segmentId:'q1'},{source:10,video:20,segmentId:'q2'}];
  assert.throws(()=>mapTime(5,anchors),/跨镜头/);
  assert.equal(mapTime(0,anchors),10);
  const repeated=[{source:0,video:10,segmentId:'q1'},{source:10,video:20,segmentId:'q1'},
    {source:0,video:40,segmentId:'q2'},{source:10,video:50,segmentId:'q2'}];
  assert.equal(mapTime({source:5,segmentId:'q2'},repeated),45);
});
