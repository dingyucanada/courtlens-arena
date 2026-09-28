import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METRICS_SCHEMA, validateMetricBundle, adaptMetricBundle, selectMetricRecords, selectBoundMetric, formatScopedMetric, metricTimeSyncPolicy, assertMetricTimeSyncAllowed } from '../pro/metrics-v2.mjs';
import { parseInput, exportProject, datasetForLegacy, validateProject } from '../pro/model.mjs';
import { analyzePossession, buildNarration, queryEvidence, rankPossessions } from '../pro/analytics.mjs';

const sample = JSON.parse(readFileSync(new URL('../pro/fixtures/metrics-v2-sample.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const bundle = () => clone(sample);
const imported = data => parseInput(JSON.stringify(data), 'provider-v2.json');
const playOf = data => imported(data).project.plays[0];

test('versioned import preserves dictionary, source values, scope, provenance and raw records', () => {
  const input = bundle(), result = imported(input), project = result.project;
  assert.equal(result.kind, 'metrics-v2');
  assert.deepEqual(project.metricAdapter.dictionary, input.dictionary);
  assert.deepEqual(project.metricAdapter.records, input.records);
  assert.deepEqual(project.plays[0].sourceRecord, input.plays[0]);
  assert.equal(project.plays[0].metricRecords.find(record => record.metricId === 'example-xfg').value, 62);
  assert.equal(project.plays[0].metricRecords[0].unit, 'percent');
  assert.deepEqual(project.plays[0].metricRecords[0].sourceRecord, input.records[0]);
  assert.deepEqual(sample, input);
});

test('old backups still open and v2 backup retains all independent source records', () => {
  const project = imported(bundle()).project;
  const roundTrip = parseInput(exportProject(project)).project;
  assert.deepEqual(roundTrip.metricAdapter, project.metricAdapter);
  assert.deepEqual(roundTrip.plays[0].metricRecords, project.plays[0].metricRecords);
  const old = parseInput(JSON.stringify({ schema: 'courtlens-arena/1', id: 'old', name: 'Old', plays: [{id: 'p', start: 1, end: 3, outcome: 'unknown', metrics: {}}] })).project;
  assert.equal(old.metricAdapter, undefined);
  assert.equal(validateProject(old), true);
});

test('unsupported adapter version and missing dictionary versions fail', () => {
  const input = bundle(); input.schema = 'courtlens-metrics/3';
  assert.throws(() => imported(input), /版本/);
  input.schema = METRICS_SCHEMA; delete input.dictionary.version;
  assert.throws(() => imported(input), /字典/);
  const missing = bundle(); delete missing.dictionary.metrics['example-xfg'].version;
  assert.throws(() => imported(missing), /version/);
});

test('invalid probability units, conflicting per-record units and versions fail', () => {
  for (const mutate of [
    input => input.dictionary.metrics['example-xfg'].unit = 'ft',
    input => input.records[0].unit = 'probability',
    input => input.records[0].version = 'unknown-version',
    input => input.records[0].dictionaryVersion = 'other',
    input => input.records[0].semantics = 'unknown',
  ]) { const input = bundle(); mutate(input); assert.throws(() => imported(input), /单位|冲突|口径/); }
});

test('explicit percent conversion preserves 62% and computes a separate 0.38 editorial difficulty', () => {
  const analysis = analyzePossession(playOf(bundle()), { asOf: 14 });
  assert.equal(analysis.metrics.difficulty.value, 62);
  assert.equal(analysis.metrics.difficulty.unit, 'percent');
  assert.equal(analysis.metrics.difficulty.probability, 0.62);
  assert.equal(analysis.metrics.difficulty.normalized, 0.38);
  assert.match(buildNarration(playOf(bundle()), analysis).text, /62%/);
  assert.ok(!buildNarration(playOf(bundle()), analysis).text.includes('6200%'));
});

test('percent and probability transforms happen only when expressly declared', () => {
  const input = bundle(); delete input.dictionary.metrics['example-xfg'].transforms;
  const analysis = analyzePossession(playOf(input));
  assert.equal(analysis.metrics.difficulty.value, 62);
  assert.equal(analysis.metrics.difficulty.probability, null);
  assert.equal(analysis.metrics.difficulty.normalized, null);
  input.dictionary.metrics['example-xfg'].unit = 'probability'; input.records[0].value = 0.62;
  assert.equal(analyzePossession(playOf(input)).metrics.difficulty.normalized, null);
});

test('invalid probability ranges and boolean/string missingness are rejected without guessing', () => {
  for (const value of [101, -1, true, '', '62']) { const input = bundle(); input.records[0].value = value; assert.throws(() => imported(input), /读数|value/); }
  const input = bundle(); input.dictionary.metrics['example-xfg'].unit = 'probability'; delete input.dictionary.metrics['example-xfg'].transforms;
  assert.throws(() => imported(input), /概率尺度/);
});

test('null retains its definition and real zero remains available', () => {
  const input = bundle(); input.records[0].value = null;
  const empty = analyzePossession(playOf(input));
  assert.equal(empty.metrics.difficulty.value, null);
  assert.equal(empty.metrics.difficulty.normalized, null);
  assert.equal(empty.scopedMetrics.find(record => record.metricId === 'example-xfg').definition, input.dictionary.metrics['example-xfg'].definition);
  input.records[0].value = 0;
  const zero = analyzePossession(playOf(input));
  assert.equal(zero.metrics.difficulty.available, true);
  assert.equal(zero.metrics.difficulty.value, 0);
  assert.equal(zero.metrics.difficulty.normalized, 1);
});

test('availability and observation times both prevent future leakage into evidence and stories', () => {
  const input = bundle(); input.records[0].time.availableAt = 11;
  const play = playOf(input), before = analyzePossession(play, { asOf: 13 });
  assert.equal(before.metrics.difficulty.value, null);
  assert.ok(!before.scopedMetrics.some(record => record.metricId === 'example-xfg'));
  assert.ok(!buildNarration(play, before).text.includes('62%'));
  assert.ok(!JSON.stringify(queryEvidence([play], {intent: 'metric', metric: 'difficulty', asOf: 13})).includes('62%'));
  input.records[0].time.availableAt = 15;
  assert.equal(analyzePossession(playOf(input), { asOf: 14 }).metrics.difficulty.value, null);
  assert.equal(analyzePossession(playOf(input), { asOf: 15 }).metrics.difficulty.value, 62);
});

test('unknown availability never becomes end-of-possession or zero in v2', () => {
  const input = bundle(); input.records[0].time.availableAt = null;
  const play = playOf(input), result = analyzePossession(play);
  assert.equal(result.metrics.difficulty.available, false);
  assert.equal(result.metrics.difficulty.reason, 'missing-availability');
  assert.ok(!result.scopedMetrics.some(record => record.metricId === 'example-xfg'));
});

test('explicit valid intervals expire instead of creating continuing Gravity dynamics', () => {
  const play = playOf(bundle());
  assert.equal(analyzePossession(play, {asOf: 14}).metrics.gravity.value, 1.8);
  assert.equal(analyzePossession(play, {asOf: 15}).metrics.gravity.available, false);
  assert.equal(selectBoundMetric(play, 'gravity', 15).reason, 'expired');
});

test('on-ball and off-ball Gravity retain separate values, players and evidence', () => {
  const play = playOf(bundle()), analysis = analyzePossession(play, {asOf: 14});
  const gravity = analysis.scopedMetrics.filter(record => record.role === 'gravity');
  assert.deepEqual(gravity.map(record => [record.value, record.ballState, record.scope.playerId]), [[1.8, 'on-ball', 'example-H1'], [2.4, 'off-ball', 'example-H2']]);
  assert.ok(gravity.every(record => analysis.evidence.some(evidence => evidence.id === record.evidenceId && evidence.ballState === record.ballState)));
  assert.match(buildNarration(play, analysis).text, /无球/);
  assert.match(queryEvidence([play], {intent:'metric',metric:'gravity',asOf:14}).answer, /example-H2/);
  assert.ok(gravity.every(record => record.unit === 'example-index'));
  assert.equal(analysis.metrics.gravity.normalized, null);
});

test('season Leverage remains contextual at original 6.2 and never ranks as instant opportunity', () => {
  const play = playOf(bundle()), analysis = analyzePossession(play, {asOf:14});
  assert.equal(analysis.metrics.leverage.available, false);
  assert.equal(analysis.metrics.leverage.normalized, null);
  const context = analysis.metricContext[0];
  assert.equal(context.value, 6.2);
  assert.equal(context.scope.granularity, 'season');
  assert.deepEqual(context.aggregation, sample.records[3].aggregation);
  const narrative = buildNarration(play, analysis);
  assert.match(narrative.text, /赛季汇总/);
  assert.match(narrative.text, /不代表本回合瞬时变化/);
  assert.ok(narrative.claims.some(claim => claim.type === 'aggregate-context'));
  const query = queryEvidence([play], {intent:'metric',metric:'leverage',asOf:14});
  assert.match(query.answer, /6.2 example-score/);
  assert.match(query.warnings.join(''), /不参与/);
});

test('unknown Leverage cannot acquire a normalization through a convenient range', () => {
  const input = bundle(), entry = input.dictionary.metrics['example-leverage-season'];
  entry.range = [0, 10]; entry.higherIs = 'more'; entry.transforms = {editorial:'declared-range'};
  assert.throws(() => imported(input), /未知 Leverage/);
});

test('season context binds only exact player, team and season identities', () => {
  const input = bundle(); input.plays.push({...clone(input.plays[0]), id:'p02', playerId:'other-player'});
  input.plays.push({...clone(input.plays[0]), id:'p03', seasonId:'other-season'});
  const project = imported(input).project;
  assert.equal(analyzePossession(project.plays[1]).metricContext.length, 0);
  assert.equal(analyzePossession(project.plays[2]).metricContext.length, 0);
});

test('wrong granularity, missing aggregate period and conflicting source scopes are rejected', () => {
  for (const mutate of [
    input => input.records[0].scope.granularity = 'season',
    input => delete input.records[3].aggregation,
    input => input.records[0].scope.shotId = 'wrong-shot',
    input => input.records[0].scope.playerId = 'wrong-player',
    input => input.records[0].time.observedAt = 13,
    input => input.records[0].scope.playId = 'absent',
  ]) { const input = bundle(); mutate(input); assert.throws(() => imported(input), /粒度|granularity|aggregation|回合|出手/); }
});

test('duplicate metric scopes and competing old metrics must be resolved before import', () => {
  const input = bundle(); input.records.push({...clone(input.records[0]), id:'duplicate', value:50});
  assert.throws(() => validateMetricBundle(input), /冲突/);
  const old = bundle(); old.plays[0].metrics = {xfg_pct:0.9};
  assert.throws(() => imported(old), /两个冲突/);
});

test('time-valid selection masks older values with a newer explicit null', () => {
  const input = bundle();
  delete input.records[1].time.validTo;
  input.records.push({...clone(input.records[1]), id:'new-null', value:null, time:{timeBase:'video',observedAt:13,availableAt:13,validFrom:12}});
  const selected = selectMetricRecords(playOf(input), {asOf:14}).selected.filter(record => record.metricId === 'example-gravity-on');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].value, null);
  assert.equal(selected[0].available, false);
});

test('mixed dictionary versions cannot be put on one editorial ranking scale', () => {
  const one = playOf(bundle());
  const input = bundle(); input.plays[0].id = 'p02'; input.records.forEach(record => {if(record.scope.playId)record.scope.playId='p02';}); input.dictionary.version = 'other-dictionary-version';
  const two = playOf(input), rows = rankPossessions([one,two]);
  assert.ok(rows.every(row => row.rank.incompatibleFields.includes('difficulty')));
  assert.ok(rows.every(row => row.rank.components.find(component => component.key === 'difficulty').points === null));
});

test('tampered v2 backups fail and lossy old-format export is refused', () => {
  const project = imported(bundle()).project;
  assert.throws(() => datasetForLegacy(project), /旧格式/);
  project.plays[0].metricRecords[0].value = 99;
  assert.throws(() => parseInput(JSON.stringify(project)), /来源.*冲突/);
});

test('helpers expose original units and scope without mutating supplied bundle', () => {
  const input = bundle(), original = clone(input), adapted = adaptMetricBundle(input);
  const context = selectMetricRecords(adapted.input.plays[0], {asOf:14}).selected.find(record => record.contextOnly);
  assert.match(formatScopedMetric(context), /6.2 example-score.*赛季汇总/);
  assert.deepEqual(input, original);
});

test('full stories retain expired earlier event evidence at its valid time', () => {
  const play = playOf(bundle()), final = analyzePossession(play);
  assert.ok(!final.scopedMetrics.some(record => record.ballState === 'off-ball'));
  const history = final.metricHistory.find(record => record.ballState === 'off-ball');
  assert.equal(history.historical, true);
  assert.equal(history.availableNow, false);
  const narration = buildNarration(play, final);
  const claim = narration.claims.find(item => item.evidenceIds.includes(history.evidenceId));
  assert.equal(claim.t, 12);
  assert.ok(narration.cues.filter(cue => cue.evidenceIds.includes(history.evidenceId)).every(cue => cue.start >= 12 && cue.end <= 15));
  assert.ok(final.evidence.some(item => item.id === history.evidenceId && item.time.validTo === 15));
});

test('a view before the possession begins reveals neither scoped identities nor story history', () => {
  const play = playOf(bundle()), analysis = analyzePossession(play, {asOf:9});
  assert.equal(analysis.scopedMetrics.length, 0);
  assert.equal(analysis.metricHistory.length, 0);
  assert.equal(buildNarration(play, analysis).claims.length, 0);
});

test('a distance dictionary cannot masquerade as Gravity', () => {
  const input = bundle(); input.dictionary.metrics['example-gravity-on'].semantics = 'nearest_defender_distance';
  assert.throws(() => imported(input), /距离语义不可绑定/);
});

test('shot semantics at event granularity cannot silently become a shot ranking component', () => {
  const input = bundle(); input.dictionary.metrics['example-xfg'].granularity = 'event';
  input.records[0].scope = {granularity:'event',playId:'p01',eventId:'not-a-shot'};
  const analysis = analyzePossession(playOf(input));
  assert.equal(analysis.metrics.difficulty.normalized, null);
  assert.equal(analysis.metrics.difficulty.reason, 'context-only-or-incompatible-granularity');
  assert.equal(analysis.scopedMetrics.find(record => record.metricId === 'example-xfg').value, 62);
});

test('Agent query bounds a long v2 event history and retains resolvable visible metric evidence', () => {
  const input = bundle(); input.records = input.records.filter(record => !record.metricId.includes('gravity'));
  for (let i=0;i<90;i++) input.records.push({id:`off-${i}`,metricId:'example-gravity-off',value:i/10,scope:{granularity:'event',playId:'p01',eventId:`e-${i}`,playerId:'example-H2'},time:{timeBase:'video',observedAt:10+i/20,availableAt:10+i/20}});
  const result = queryEvidence([playOf(input)], {intent:'metric',metric:'gravity'});
  assert.ok(result.matches[0].analysis.scopedMetrics.length <=16);
  assert.ok(result.matches[0].analysis.metricHistory.length <=16);
  assert.ok(result.evidence.length <=48);
  assert.ok(result.matches[0].analysis.scopedMetrics.every(record => result.evidenceIds.includes(record.evidenceId)));
  assert.ok(result.answer.length < 5000);
  assert.ok(result.matches[0].analysis.outputTruncated.scopedMetricsOmitted > 0);
});

test('same-start narration cannot extend a shorter valid metric to another record expiry', () => {
  const input = bundle(); input.records[2].time.validTo = 12.5;
  const play = playOf(input), analysis = analyzePossession(play), story = buildNarration(play, analysis);
  const off = analysis.metricHistory.find(record => record.ballState === 'off-ball');
  assert.ok(story.cues.filter(cue => cue.evidenceIds.includes(off.evidenceId)).every(cue => cue.end <= 12.5));
});

test('an explicit newer null ends historical display of an older same-scope reading', () => {
  const input = bundle(); delete input.records[1].time.validTo;
  input.records.push({...clone(input.records[1]),id:'new-null',value:null,time:{timeBase:'video',observedAt:13,availableAt:13,validFrom:12}});
  const play = playOf(input), analysis = analyzePossession(play), story = buildNarration(play, analysis);
  const old = analysis.metricHistory.find(record => record.id === 'example-r-on');
  assert.equal(old.displayUntil, 13);
  assert.equal(old.time.validTo, undefined);
  assert.ok(story.cues.filter(cue => cue.evidenceIds.includes(old.evidenceId)).every(cue => cue.end <= 13));
});

test('already video-aligned v2 times reject a second global sync without mutating sources', () => {
  const project = imported(bundle()).project, original = clone(project);
  const policy = metricTimeSyncPolicy(project);
  assert.equal(policy.allowed, false);
  assert.equal(policy.code, 'metric-v2-video-axis-fixed');
  assert.throws(() => assertMetricTimeSyncAllowed(project), error => error.code === 'metric-v2-video-axis-fixed' && /重新导入/.test(error.message));
  assert.deepEqual(project, original);
  assert.equal(assertMetricTimeSyncAllowed({plays:[]}), true);
});

test('different definitions cannot rank together even if a provider reuses dictionary version labels', () => {
  const first = playOf(bundle()), input = bundle();
  input.plays[0].id = 'p02'; input.records.forEach(record => {if(record.scope.playId)record.scope.playId='p02';});
  input.dictionary.metrics['example-xfg'].definition = '不同的人群和输入范围；相同版本标签不能消除口径差异。';
  const rows = rankPossessions([first, playOf(input)]);
  assert.ok(rows.every(row => row.rank.incompatibleFields.includes('difficulty')));
});
