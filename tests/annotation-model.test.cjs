const {test}=require('node:test'),assert=require('node:assert/strict'),{create}=require('../web/annotation-model.js');
const p={id:'p01',start:0,end:12,camera_segments:[{id:'c1',start:0,end:6,calibrated:false},{id:'c2',start:6,end:12,calibrated:false}]};
test('manual arrow preserves all original camera calibration',()=>{const r=create(p,'arrow','观察',1,3,[[.1,.2],[.4,.6]],'abc');assert.equal(r.annotation.origin,'manual');assert.equal(r.annotation.frame_reviewed,true);assert.deepEqual(r.camera_segments,p.camera_segments)});
test('rectangle expands into four normalized vertices',()=>{const r=create(p,'zone','观察',1,3,[[.1,.2],[.4,.6]],'abc');assert.deepEqual(r.annotation.points,[[.1,.2],[.4,.2],[.4,.6],[.1,.6]])});
test('camera cuts cannot be silently merged',()=>assert.throws(()=>create(p,'arrow','观察',5,7,[[.1,.2],[.4,.6]],'abc'),/跨镜头/));
test('invalid timeline and geometry rejected',()=>{assert.throws(()=>create(p,'zone','观察',1,3,[[.1,.2],[.1,.6]],'abc'));assert.throws(()=>create(p,'arrow','观察',3,1,[[.1,.2],[.4,.6]],'abc'));assert.throws(()=>create(p,'label','观察',1,3,[[2,.2]],'abc'))});
test('label uses one point and still records evidence source',()=>{const r=create(p,'label','持球人',1,3,[[.1,.2]],'abc');assert.match(r.annotation.author_note,/人工/);assert.equal(r.annotation.evidence_id,'p01:manual:abc')});
