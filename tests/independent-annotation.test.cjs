'use strict';
// Independent behavior tests against the actual authoring and renderer functions.
// No browser, app mutation, media rewriting, or dependency installation required.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const app=path.resolve(__dirname,'..');
const {create}=require(path.join(app,'web/annotation-model.js'));
const source=fs.readFileSync(path.join(app,'web/app.js'),'utf8');
const demo=JSON.parse(fs.readFileSync(path.join(app,'data/demo.json'),'utf8'));
const clone=x=>JSON.parse(JSON.stringify(x));
function element(tag,attrs={},text){return {tag,attrs,text,children:[],append(...c){this.children.push(...c)},replaceChildren(...c){this.children=[...c]},setAttribute(k,v){this.attrs[k]=v}}}
function harness(p,synchronized=true){
 const root=element('svg'),notice={hidden:true};
 const ctx={state:{dataset:clone(demo),synchronized,overlay:true},$:id=>id==='video-overlay'?root:notice,rawPossession:()=>p,svgEl:element};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('  function currentCamera('),source.indexOf('  function updateCaptions(')),ctx);
 return {root,render(t){ctx.renderOverlay(t);return root.children},texts(){return root.children.filter(n=>n.tag==='text').map(n=>n.text)}};
}
function manualFixture(calibrated=true){
 const p=clone(demo.possessions[0]);p.tracks=[];
 p.camera_segments=[{id:'camera-audit',start:0,end:12,calibrated}];
 p.annotations=[{id:'manual-audit',evidence_id:'p01:manual:audit',kind:'label',label:'人工观察',origin:'manual',frame_reviewed:true,author_note:'人工核对',start:1,end:4,points:[[.5,.5]]}];return p;
}
test('manual no-tracks annotation appears with explicit label and stops at end',()=>{
 const h=harness(manualFixture());h.render(2);assert(h.texts().includes('人工 · 人工观察'));h.render(4);assert.equal(h.root.children.length,0);
});
test('manual annotation requires media synchronization even when independently reviewed',()=>{
 for(const calibrated of [false,true]){const h=harness(manualFixture(calibrated),false);h.render(2);assert.equal(h.root.children.length,0)}
});
test('reviewed manual annotation works independently of camera tracking calibration',()=>{
 for(const calibrated of [false,true]){const h=harness(manualFixture(calibrated));h.render(2);assert(h.texts().includes('人工 · 人工观察'))}
});
test('unreviewed manual annotation is never drawn even if upstream validation is bypassed',()=>{
 for(const value of [undefined,false,'true',1]){const p=manualFixture();p.annotations[0].frame_reviewed=value;const h=harness(p);h.render(2);assert.equal(h.root.children.length,0)}
});
test('manual marker does not unlock unrelated tracking annotations with no tracks',()=>{
 const p=manualFixture();p.annotations.push({...p.annotations[0],id:'auto',origin:'tracking',label:'自动区'});const h=harness(p);h.render(2);assert.deepEqual(h.texts(),['人工 · 人工观察']);
});
test('event card has no missing result or undefined suffix',()=>{
 const start=source.indexOf('  function formatEvidenceValue('),end=source.indexOf('  function renderTrace(',start);const ctx={};vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
 assert.equal(ctx.formatEvidenceValue({value:{shooter:'H3',shot_value:3,offense:'HOU'}}),'H3 · 3 分投篮');
});
test('drawing one manual label must not unlock uncalibrated player tracks',()=>{
 const p=clone(demo.possessions[0]);p.camera_segments=[{id:'uncalibrated-camera',start:0,end:12,calibrated:false}];
 const before=harness(p);before.render(2);assert.equal(before.root.children.length,0);
 const r=create(p,'label','本点人工核对',1,3,[[.5,.5]],'calibration-audit');
 const edited={...p,camera_segments:r.camera_segments,annotations:[...p.annotations,r.annotation]};
 const h=harness(edited);h.render(2);
 assert(!h.texts().includes('H3'),'A static manual point is not calibration of unrelated supplied player tracks');
 assert(h.texts().includes('人工 · 本点人工核对'));
});
test('overlapping annotations within one real camera remain authorable',()=>{
 const p={id:'p01',start:0,end:12,camera_segments:[{id:'one-real-shot',start:0,end:12,calibrated:false}]};
 const a=create(p,'label','第一处',1,3,[[.4,.4]],'first');
 const edited={...p,camera_segments:a.camera_segments,annotations:[a.annotation]};
 assert.doesNotThrow(()=>create(edited,'label','第二处',2,4,[[.6,.6]],'second'),'No camera cut exists at the first annotation endpoint');
});
test('manual timing boundary must not introduce a gap in already valid tracking',()=>{
 const p=clone(demo.possessions[0]);p.camera_segments=[{id:'verified-camera',start:0,end:12,calibrated:true}];
 const before=harness(p);before.render(1.1);assert(before.texts().includes('H3'));
 const a=create(p,'label','人工点',1.2,3.2,[[.5,.5]],'fractional');
 const after=harness({...p,camera_segments:a.camera_segments,annotations:[...p.annotations,a.annotation]});after.render(1.1);
 assert(after.texts().includes('H3'),'Adding a future manual label must not remove valid earlier interpolated players');
});
test('authoring retains original camera geometry and calibration in both states',()=>{
 for(const calibrated of [false,true]){
  const p={id:'p01',start:0,end:12,camera_segments:[{id:'real-camera',start:0,end:12,calibrated,calibration_note:'do not rewrite'}]};
  const original=clone(p.camera_segments),r=create(p,'label','核对点',1.2,3.2,[[.5,.5]],'preserve');
  assert.deepEqual(r.camera_segments,original);assert.deepEqual(p.camera_segments,original);assert.equal(r.annotation.frame_reviewed,true);
 }
});
