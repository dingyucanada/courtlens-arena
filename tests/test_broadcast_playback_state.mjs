import assert from 'node:assert/strict';
import {playbackState} from '../broadcast/playback_state.mjs';

const beat={id:'beat-1',label:'选择',sourceStart:2,sourceEnd:6,observationIds:['obs-1'],bindingIds:['bind-1'],metricRecordId:'metric-1',
  text:'本次指标 {{metric:metric-1}}',annotation:{sourceObservationId:'obs-1',points:[{x:.1,y:.2},{x:.8,y:.5}]}};
const manifest={story:{sourceRange:{start:0,end:10},beats:[beat,{...beat,id:'beat-2',sourceStart:7,sourceEnd:9,metricRecordId:null,annotation:null,text:'随后回看'}]},
  compiledBeats:[{beatId:'beat-1',compiledText:'本次指标 1.8',metric:{recordId:'metric-1',label:'示例指标',value:'1.8',source:'test'}},{beatId:'beat-2',compiledText:'随后回看',metric:null}],
  evidence:{observations:[{id:'obs-1',segmentId:'s1',review:{status:'accepted'},geometry:{segmentId:'s1',validFrom:3,validTo:4}}],
    bindings:[{id:'bind-1',status:'confirmed',observationId:'obs-1',metricRecordIds:['metric-1']}],
    metrics:{records:[{id:'metric-1',value:1.8,scope:{granularity:'event'},time:{timeBase:'video',observedAt:2,availableAt:3,validFrom:3,validTo:5}}]}}};

const before=playbackState(manifest,1.9);
assert.equal(before.beat,null);assert.equal(before.metric,null);assert.equal(before.phase,'between');
assert.equal(playbackState(manifest,2.5).metric,null,'future availableAt must not leak');
assert.equal(playbackState(manifest,2.5).compiledText,null,'compiled numerical text must also remain hidden');
assert.equal(playbackState(manifest,3).metric.value,'1.8');
assert.equal(playbackState(manifest,3).annotation.sourceObservationId,'obs-1');
assert.equal(playbackState(manifest,4).annotation,null,'short geometry expires at validTo');
assert.equal(playbackState(manifest,5).metric,null,'metric expires at validTo');
assert.equal(playbackState(manifest,6).beat,null,'chapter end clears prior data');
assert.equal(playbackState(manifest,7).beat.id,'beat-2');
assert.equal(playbackState(manifest,9).beat,null);
assert.equal(playbackState(manifest,10).phase,'after');
assert.equal(playbackState(manifest,3.5).beat.id,'beat-1','seeking backward recomputes instead of carrying beat 2');
const unconfirmed=structuredClone(manifest);unconfirmed.evidence.bindings[0].status='proposed';
assert.equal(playbackState(unconfirmed,3.5).metric,null,'unconfirmed binding must not expose value');
const missing=structuredClone(manifest);missing.evidence.metrics.records[0].time.availableAt=null;
assert.equal(playbackState(missing,3.5).metric,null,'unknown availability is not zero');
console.log('playback phase, seek, metric availability, and annotation windows passed');
