import test from 'node:test';
import assert from 'node:assert/strict';
import {AnalysisError, analyzePossession, buildNarration, queryEvidence} from '../pro/analytics.mjs';
import {agentPayload} from '../pro/agent-contract.mjs';

const frame = t => ({t, players: [
  {id:'H3', name:'H3', team:'HOU', x:0, y:0},
  {id:'H2', name:'H2', team:'HOU', x:15, y:0},
  {id:'D1', name:'D1', team:'DAL', x:7, y:0},
]});
const play = (extra = {}) => ({
  id:'p01', title:'Missing event-time fixture', start:10, end:20,
  shotTime:null, resultTime:null, team:'HOU', player:'H3', shotValue:3, outcome:'unknown',
  provenance:{kind:'measured', source:'test fixture, no NBA claim'},
  metrics:{xfg_pct:{value:.42, semantics:'shot_make_probability', unit:'probability', availableAt:14,
    provenance:{kind:'measured', source:'input metric fixture'}}},
  tracking:{kind:'measured', units:'ft', coordinateSystem:'court', timeBase:'video', maxGap:.75},
  tracks:[frame(10), frame(14), frame(20)],
  ...extra,
});
const difficultyClaim = narration => narration.claims.find(claim => claim.id.endsWith(':difficulty'));

test('missing shot time stays null and cannot turn a final tracking sample into shot geometry', () => {
  for (const input of [play(), (()=>{const p=play();delete p.shotTime;return p;})()]) {
    const analysis=analyzePossession(input);
    assert.equal(analysis.shotTime,null);
    assert.equal(analysis.tactical.shotContext,null);
    assert.deepEqual(analysis.tactical.alternatives,[]);
    assert.ok(!analysis.evidence.some(item=>/shot-context|pass-segment/.test(item.field)));
  assert.equal(analysis.temporal.samples.at(-1).t,20,'The final input sample remains a sample, with no invented event label.');
    assert.match(buildNarration(input,analysis).text,/出手时间未提供/);
  }
});

test('explicit null event fields suppress contradictory legacy event aliases', () => {
  const input=play({shot_time:14,result_time:18,outcome:'made'});
  const analysis=analyzePossession(input,{asOf:20});
  assert.equal(analysis.shotTime,null);
  assert.equal(analysis.tactical.shotContext,null);
  assert.equal(analysis.outcome.value,'unknown');
  assert.equal(analysis.outcome.availableAt,null);
  assert.ok(!buildNarration(input,analysis).claims.some(claim=>claim.id.endsWith(':outcome')||claim.id.endsWith(':shot')));
});

test('result-only records remain valid and reveal the independent result at its own time', () => {
  const input=play({resultTime:18,outcome:'made'});
  const before=analyzePossession(input,{asOf:17.9}),after=analyzePossession(input,{asOf:18});
  assert.equal(before.outcome.value,'unknown');
  assert.equal(after.outcome.value,'made');
  assert.equal(after.shotTime,null);
  const narration=buildNarration(input,analyzePossession(input));
  assert.equal(narration.claims.find(claim=>claim.id.endsWith(':outcome')).t,18);
  assert.ok(!narration.claims.some(claim=>claim.id.endsWith(':shot')));
  assert.equal(queryEvidence([input],{intent:'summary'}).matches[0].playId,input.id);
});

test('without a shot anchor a difficulty reading is narrated at availability as an input reading', () => {
  const input=play(),analysis=analyzePossession(input),narration=buildNarration(input,analysis);
  const claim=difficultyClaim(narration);
  assert.equal(claim.t,14);
  assert.match(claim.text,/输入读数/);
  assert.doesNotMatch(claim.text,/H3出手|完成出手/);
  assert.deepEqual(claim.evidenceIds,['p01:metric:difficulty']);
  assert.equal(narration.cues.find(cue=>cue.evidenceIds.includes('p01:metric:difficulty')).start,14);
  const before=buildNarration(input,analyzePossession(input,{asOf:13.9}));
  assert.equal(difficultyClaim(before),undefined);
});

test('missing shot and missing difficulty cannot manufacture an end-of-play shot claim', () => {
  const input=play({metrics:{}}),narration=buildNarration(input,analyzePossession(input));
  assert.ok(!narration.claims.some(claim=>claim.id.endsWith(':shot')||claim.id.endsWith(':difficulty')));
  assert.ok(!narration.cues.some(cue=>/完成出手|H3出手/.test(cue.text)));
});

test('an unanchored metric with no availability keeps its conservative end-time reading and no shot cue', () => {
  const input=play();delete input.metrics.xfg_pct.availableAt;
  assert.equal(difficultyClaim(buildNarration(input,analyzePossession(input,{asOf:19.9}))),undefined);
  const narration=buildNarration(input,analyzePossession(input)),claim=difficultyClaim(narration);
  assert.equal(claim.t,20);
  assert.match(claim.text,/输入读数/);
  assert.deepEqual(claim.evidenceIds,['p01:metric:difficulty']);
  assert.ok(!narration.cues.some(cue=>cue.start===20),'An endpoint claim does not invent a zero-length subtitle.');
});

test('legacy-only known event aliases retain their original shot geometry and timed narration', () => {
  const input=play({shot_time:14,result_time:18,outcome:'made'});delete input.shotTime;delete input.resultTime;
  const analysis=analyzePossession(input),narration=buildNarration(input,analysis);
  assert.equal(analysis.shotTime,14);
  assert.equal(analysis.tactical.shotContext.shotTime,14);
  assert.equal(analysis.outcome.availableAt,18);
  assert.equal(difficultyClaim(narration).t,14);
  assert.match(difficultyClaim(narration).text,/H3出手/);
  assert.deepEqual(difficultyClaim(narration).evidenceIds,['p01:metric:difficulty','p01:event']);
});

test('a supplied shot at video second zero remains a known event', () => {
  const input=play({start:0,end:2,shotTime:0,resultTime:1,outcome:'made',tracks:[frame(0),frame(1)],
    metrics:{xfg_pct:{value:.42,semantics:'shot_make_probability',unit:'probability',availableAt:0}}});
  const analysis=analyzePossession(input),narration=buildNarration(input,analysis);
  assert.equal(analysis.shotTime,0);
  assert.equal(analysis.tactical.shotContext.shotTime,0);
  assert.equal(difficultyClaim(narration).t,0);
  assert.match(difficultyClaim(narration).text,/H3出手/);
});

test('known result-before-shot contradictions still reject analysis', () => {
  assert.throws(()=>analyzePossession(play({shotTime:14,resultTime:13,outcome:'made'})),AnalysisError);
});

test('Agent payload preserves finite reading and result anchors without reviving a missing shot', () => {
  const input=play({resultTime:18,outcome:'made'}),analysis=analyzePossession(input),narration=buildNarration(input,analysis);
  const payload=JSON.parse(JSON.stringify(agentPayload([input],{p01:analysis},{p01:narration},{question:'p01 的来源证据'})));
  const packed=payload.plays[0],claim=packed.claims.find(item=>item.id.endsWith(':difficulty'));
  assert.deepEqual(claim.evidenceIds,['p01:metric:difficulty']);
  assert.equal(claim.start,14);
  assert.ok(!packed.evidence.some(item=>/shot-context|pass-segment/.test(item.field)));
  for(const item of packed.claims){
    assert.ok(Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.start>=input.start&&item.end<=input.end&&item.end>=item.start);
    for(const id of item.evidenceIds){const evidence=packed.evidence.find(e=>e.id===id);assert.ok(evidence&&Number.isFinite(evidence.t)&&evidence.t<=item.start);}
  }
});
