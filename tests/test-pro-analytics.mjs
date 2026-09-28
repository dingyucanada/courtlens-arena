import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisError, ANALYTICS_LIMITS, analyzePossession, rankPossessions, buildNarration, queryEvidence } from '../pro/analytics.mjs';

const clone = object => structuredClone(object);
const metric = (value, semantics, extra = {}) => ({ value, semantics, availableAt: 14, provenance: { kind: 'measured', source: 'test sensor' }, ...extra });
function frame(t, { defenderOffset = 0, segmentId = '', missingDefender = false } = {}) {
  const offense = [[0, 0], [15, 0], [0, 15], [15, 15], [30, 0]].map(([x, y], index) => ({ id: `H${index + 1}`, name: `Home ${index + 1}`, team: 'HOU', x, y }));
  const defense = [[7, 0], [20, 0], [7, 15], [22, 15], [35, 0]].map(([x, y], index) => ({ id: `D${index + 1}`, name: `Away ${index + 1}`, team: 'DAL', x: x + defenderOffset, y }));
  if (missingDefender) defense.pop();
  return { t, players: [...offense, ...defense], ball: { x: 0, y: 0 }, segmentId };
}
function play(extra = {}) {
  return {
    id: 'p01', title: 'Evidence fixture', start: 10, end: 16, period: 3, clock: '07:41',
    shotTime: 14, resultTime: 15, team: 'HOU', player: 'H1', shotValue: 3, outcome: 'made',
    provenance: { kind: 'measured', source: 'test fixture, no NBA claim' },
    metrics: {
      difficulty: metric(0.4, 'shot_make_probability'),
      leverage: metric(0.8, 'possession_win_probability_opportunity'),
      gravity: metric(2, 'supplied_metric', { range: [0, 4], higherIs: 'more', unit: 'vendor-unit', definition: 'Test source scale.' }),
    },
    tracking: { kind: 'measured', units: 'ft', coordinateSystem: 'court', timeBase: 'video', maxGap: 0.75, source: 'test coordinates' },
    tracks: Array.from({ length: 13 }, (_, index) => frame(10 + index * 0.5)),
    ...extra,
  };
}

test('metric records preserve source readings and derive only explicit complementary xFG difficulty', () => {
  const result = analyzePossession(play());
  assert.equal(result.metrics.difficulty.value, 0.4);
  assert.equal(result.metrics.difficulty.normalized, 0.6);
  assert.equal(result.metrics.difficulty.transformed, true);
  assert.equal(result.metrics.gravity.value, 2);
  assert.equal(result.metrics.gravity.normalized, 0.5);
  assert.equal(result.metrics.leverage.normalized, 0.8);
  assert.equal(result.coverage.metrics.ratio, 1);
});

test('before-shot metrics, result, shot context and all future tracks are hidden', () => {
  const result = analyzePossession(play(), { asOf: 13.75 });
  assert.equal(result.metrics.difficulty.value, null);
  assert.equal(result.metrics.gravity.value, null);
  assert.equal(result.metrics.leverage.value, null);
  assert.equal(result.outcome.value, 'unknown');
  assert.equal(result.tactical.shotContext, null);
  assert.ok(result.temporal.samples.every(sample => sample.t <= 13.75));
  assert.equal(result.evidence.find(item => item.field === 'outcome').value, 'unknown');
  assert.ok(result.temporal.opportunityWindows.every(window => window.end <= 13.75));
});

test('metric availability and independent result reveal have distinct time anchors', () => {
  const result = analyzePossession(play(), { asOf: 14 });
  assert.equal(result.metrics.difficulty.value, 0.4);
  assert.equal(result.outcome.value, 'unknown');
  assert.equal(analyzePossession(play(), { asOf: 15 }).outcome.value, 'made');
});

test('an asOf before a later possession does not expose its first track frame', () => {
  const result = analyzePossession(play(), { asOf: 9 });
  assert.equal(result.availableAt, 9);
  assert.equal(result.temporal.samples.length, 0);
  assert.equal(result.metrics.difficulty.value, null);
  assert.equal(result.outcome.value, 'unknown');
  assert.equal(result.evidence.find(item => item.field === 'team/player/shotValue').value, null);
  assert.equal(buildNarration(play(), result).cues.length, 0);
});

test('missing availableAt conservatively keeps metric hidden until possession end', () => {
  const input = play();
  delete input.metrics.difficulty.availableAt;
  assert.equal(analyzePossession(input, { asOf: 15 }).metrics.difficulty.value, null);
  const final = analyzePossession(input);
  assert.equal(final.metrics.difficulty.value, 0.4);
  assert.match(final.warnings.join(' '), /保守隐藏到回合结束/);
});

test('missing resultTime does not reveal result in any explicit asOf view', () => {
  const input = play({ resultTime: null });
  assert.equal(analyzePossession(input, { asOf: 16 }).outcome.value, 'unknown');
  const retrospective = analyzePossession(input);
  assert.equal(retrospective.outcome.value, 'made');
  assert.ok(!buildNarration(input, retrospective).cues.some(cue => /命中/.test(cue.text) && !/概率/.test(cue.text)));
});

test('unknown and non-finite numeric values are not converted to zero', () => {
  const input = play({ metrics: { difficulty: { value: NaN, semantics: 'shot_difficulty' }, gravity: null, leverage: { value: Infinity, semantics: 'possession_win_probability_opportunity' } }, tracks: [] });
  const result = analyzePossession(input);
  for (const record of Object.values(result.metrics)) {
    assert.equal(record.value, null);
    assert.equal(record.normalized, null);
  }
  assert.equal(result.rank.score, null);
  assert.deepEqual(result.rank.scoreInterval, [0, 100]);
  assert.ok(result.rank.components.every(component => component.points === null));
  assert.equal(JSON.stringify(result).includes('NaN'), false);
});

test('zero is a valid supplied reading', () => {
  const input = play();
  input.metrics.leverage.value = 0;
  const result = analyzePossession(input);
  assert.equal(result.metrics.leverage.value, 0);
  assert.equal(result.metrics.leverage.available, true);
  assert.equal(result.rank.components.find(component => component.key === 'leverage').points, 0);
});

test('gravity without a comparable source scale stays visible and unranked', () => {
  const input = play();
  delete input.metrics.gravity.range;
  const result = analyzePossession(input);
  assert.equal(result.metrics.gravity.value, 2);
  assert.equal(result.metrics.gravity.normalized, null);
  assert.equal(result.rank.components.find(component => component.key === 'gravity').points, null);
  assert.match(result.warnings.join(' '), /口径|定义或尺度/);
});

test('a similarly named Leverage Score is not relabelled as a possession probability gap', () => {
  const input = play();
  input.metrics.leverage = metric(6.2, 'player_cumulative_leverage_score', { range: [-10, 10] });
  const result = analyzePossession(input);
  assert.equal(result.metrics.leverage.value, 6.2);
  assert.equal(result.metrics.leverage.normalized, null);
});

test('value outside explicitly declared source range is unavailable', () => {
  const input = play();
  input.metrics.gravity.value = 5;
  const result = analyzePossession(input);
  assert.equal(result.metrics.gravity.value, null);
  assert.equal(result.metrics.gravity.reason, 'outside-declared-range');
});

test('declared probability outside 0–1 is rejected instead of guessed to be a percentage', () => {
  const input = play(); input.metrics.difficulty.value = 62;
  const result = analyzePossession(input);
  assert.equal(result.metrics.difficulty.value, null);
  assert.equal(result.metrics.difficulty.reason, 'outside-semantic-range');
  assert.ok(!buildNarration(input, result).text.includes('6200%'));
});

test('unknown Leverage semantics retain a source metric label', () => {
  const input = play(); input.metrics.leverage = metric(6.2, 'player_cumulative_leverage_score');
  const result = analyzePossession(input);
  assert.equal(result.metrics.leverage.label, 'Leverage（来源指标）');
  assert.match(queryEvidence([input], { intent: 'metric', metric: 'leverage' }).answer, /Leverage（来源指标）/);
});

test('huge finite supplied values do not overflow while formatting a source reading', () => {
  const input = play(); input.metrics.gravity = metric(1e308, 'supplied_metric');
  const result = analyzePossession(input);
  assert.equal(result.metrics.gravity.value, 1e308);
  assert.ok(!buildNarration(input, result, { audience: 'analyst' }).text.includes('Infinity'));
});

test('overflowing source ranges do not manufacture a normalized reading', () => {
  const input = play(); input.metrics.gravity = metric(1, 'supplied_metric', { range: [-1e308, 1e308], higherIs: 'more' });
  assert.equal(analyzePossession(input).metrics.gravity.normalized, null);
});

test('invalid metric availability cannot disclose a value in a front view', () => {
  const input = play(); input.metrics.gravity.availableAt = -1;
  const result = analyzePossession(input, { asOf: 14 });
  assert.equal(result.metrics.gravity.value, null);
  assert.equal(result.metrics.gravity.reason, 'invalid-availability-time');
});

test('plain numeric legacy fields require explicit semantics before ranking', () => {
  const input = play({ metrics: { xfg_pct: 0.4, gravity: 2, leverage: 0.8 }, tracks: [], metricSemantics: { xfg_pct: 'shot_make_probability', gravity: 'supplied_metric', leverage: 'unknown' } });
  const result = analyzePossession(input);
  assert.equal(result.metrics.difficulty.normalized, 0.6);
  assert.equal(result.metrics.leverage.normalized, null);
});

test('nearest defender distance is computed from supplied court coordinates', () => {
  const result = analyzePossession(play());
  assert.equal(result.tactical.shotContext.nearestDefender.id, 'D1');
  assert.equal(result.tactical.shotContext.nearestDefender.distanceFt, 7);
  assert.equal(result.tactical.shotContext.kind, 'derived');
  assert.equal(result.tactical.shotContext.defendersComplete, true);
});

test('image-normalized tracks cannot create physical feet distances', () => {
  const result = analyzePossession(play({ tracking: { kind: 'measured', units: 'normalized', coordinateSystem: 'image' } }));
  assert.equal(result.coverage.tracking.geometric, false);
  assert.equal(result.temporal.samples.length, 0);
  assert.equal(result.tactical.shotContext, null);
  assert.match(result.warnings.join(' '), /屏幕距离/);
});

test('metres convert to feet exactly once', () => {
  const input = play();
  input.tracking.units = 'm';
  input.tracks.forEach(record => record.players.forEach(player => { player.x /= 3.280839895013123; player.y /= 3.280839895013123; }));
  assert.ok(Math.abs(analyzePossession(input).tactical.shotContext.nearestDefender.distanceFt - 7) < 1e-9);
});

test('normalized court coordinates require declared physical court units', () => {
  const input = play();
  input.tracking = { ...input.tracking, units: 'normalized', court: { width: 50, length: 94, units: 'ft' } };
  input.tracks.forEach(record => record.players.forEach(player => { player.x /= 50; player.y /= 94; }));
  assert.ok(Math.abs(analyzePossession(input).tactical.shotContext.nearestDefender.distanceFt - 7) < 1e-9);
  delete input.tracking.court.units;
  assert.equal(analyzePossession(input).coverage.tracking.geometric, false);
});

test('rectangular normalized courts scale x by width and y by length before nearest-defender selection', () => {
  for (const units of ['ft', 'm']) {
    const input = play();
    const factor = units === 'm' ? 0.3048 : 1;
    input.tracking = { ...input.tracking, units: 'normalized', court: { width: 50 * factor, length: 94 * factor, units } };
    input.tracks.forEach(record => record.players = [
      { id: 'H1', team: 'HOU', x: 0.5, y: 0.5 },
      { id: 'D1', team: 'DAL', x: 0.6, y: 0.5 },
      { id: 'D2', team: 'DAL', x: 0.5, y: 0.58 },
    ]);
    const nearest = analyzePossession(input).tactical.shotContext.nearestDefender;
    assert.equal(nearest.id, 'D1');
    assert.ok(Math.abs(nearest.distanceFt - 5) < 1e-9);
  }
});

test('physically unbounded court declarations cannot overflow derived geometry', () => {
  const input = play(); input.tracking = { ...input.tracking, units: 'normalized', court: { length: 1e308, width: 1e308, units: 'm' } };
  const result = analyzePossession(input);
  assert.equal(result.coverage.tracking.geometric, false);
  assert.equal(result.temporal.samples.length, 0);
});

test('possession-relative track times convert to absolute video times', () => {
  const input = play();
  input.tracking.timeBase = 'possession';
  input.tracks.forEach(record => { record.t -= input.start; });
  const result = analyzePossession(input);
  assert.equal(result.temporal.samples[0].t, 10);
  assert.equal(result.tactical.shotContext.t, 14);
});

test('sampled opportunity windows require complete defenders, at least two samples and bounded gaps', () => {
  const result = analyzePossession(play());
  const window = result.temporal.opportunityWindows.find(item => item.playerId === 'H1');
  assert.equal(window.start, 10);
  assert.equal(window.end, 16);
  assert.equal(window.duration, 6);
  assert.equal(window.minDistanceFt, 7);
  assert.equal(window.maxGap, 0.5);
  assert.equal(window.timingUncertaintySec, 0.25);
  assert.equal(window.sampleCount, 13);
  assert.match(result.evidence.find(item => item.id === window.evidenceId).definition, /离散采样/);
});

test('distance display rounding cannot promote a below-threshold defender into open space', () => {
  const input = play();
  input.tracks.forEach(record => { record.players.find(player => player.id === 'D1').x = 5.9996; });
  const result = analyzePossession(input);
  assert.equal(result.temporal.samples[0].shooterDefenderDistanceFt, 6);
  assert.ok(!result.temporal.opportunityWindows.some(window => window.playerId === 'H1'));
});

test('a gap splits an opportunity window instead of interpolating open space', () => {
  const input = play({ tracks: [frame(10), frame(10.5), frame(12), frame(12.5), frame(14)] });
  const windows = analyzePossession(input).temporal.opportunityWindows.filter(item => item.playerId === 'H1');
  assert.deepEqual(windows.map(window => [window.start, window.end]), [[10, 10.5], [12, 12.5]]);
});

test('a camera segment boundary splits windows even without a time gap', () => {
  const input = play({ tracks: [frame(10, { segmentId: 'A' }), frame(10.5, { segmentId: 'A' }), frame(11, { segmentId: 'B' }), frame(11.5, { segmentId: 'B' })] });
  const windows = analyzePossession(input).temporal.opportunityWindows.filter(item => item.playerId === 'H1');
  assert.deepEqual(windows.map(window => [window.start, window.end]), [[10, 10.5], [11, 11.5]]);
});

test('missing defenders do not permit an open-window conclusion', () => {
  const input = play({ tracks: [frame(10, { missingDefender: true }), frame(10.5, { missingDefender: true }), frame(14, { missingDefender: true })] });
  const result = analyzePossession(input);
  assert.equal(result.temporal.opportunityWindows.length, 0);
  assert.equal(result.tactical.shotContext.defendersComplete, false);
  assert.ok(result.tactical.alternatives.every(item => item.descriptiveCandidate === false));
});

test('nearest sample tolerance does not invent a shooter at a distant track time', () => {
  const result = analyzePossession(play({ tracks: [frame(10), frame(11)] }));
  assert.equal(result.tactical.shotContext, null);
  assert.equal(result.tactical.alternatives.length, 0);
});

test('defensive convex hull contraction uses the same identities and gives a transparent change', () => {
  const a = frame(10);
  const b = clone(a); b.t = 10.5;
  b.players.filter(player => player.team === 'DAL').forEach(player => { player.x = 20 + (player.x - 20) * 0.5; player.y = 7.5 + (player.y - 7.5) * 0.5; });
  const result = analyzePossession(play({ tracks: [a, b] }));
  assert.equal(result.temporal.contraction.length, 1);
  assert.equal(result.temporal.contraction[0].areaChangePct, -75);
  assert.match(result.evidence.find(item => item.field === 'tracks.players.defensive-convex-hull').definition, /不推断协防原因/);
});

test('a defender identity replacement cannot appear as a contraction', () => {
  const a = frame(10);
  const b = frame(10.5); b.players.find(player => player.id === 'D1').id = 'D6';
  b.players.filter(player => player.team === 'DAL').forEach(player => { player.x *= 0.5; player.y *= 0.5; });
  assert.equal(analyzePossession(play({ tracks: [a, b] })).temporal.contraction.length, 0);
});

test('passing alternatives calculate static lane clearance without predicting success', () => {
  const result = analyzePossession(play());
  const alternative = result.tactical.alternatives.find(item => item.playerId === 'H2');
  assert.equal(alternative.passDistanceFt, 15);
  assert.equal(alternative.laneClearanceFt, 0);
  assert.equal(alternative.descriptiveCandidate, false);
  assert.match(result.evidence.find(item => item.id === alternative.evidenceId).definition, /不能预测传球成功/);
});

test('schematic tracking cannot be labelled measured NBA movement', () => {
  const input = play(); input.tracking.kind = 'schematic';
  const result = analyzePossession(input);
  assert.equal(result.tactical.shotContext.kind, 'schematic-derived');
  assert.ok(result.temporal.opportunityWindows.every(window => window.kind === 'schematic-derived'));
  assert.match(result.warnings.join(' '), /示意演练/);
  assert.match(buildNarration(input, result).limitations.join(' '), /不能当作真实比赛/);
});

test('movement paths do not include unobserved time gaps', () => {
  const a = frame(10); const b = frame(10.5, { defenderOffset: 1 }); const c = frame(14, { defenderOffset: 100 });
  const result = analyzePossession(play({ tracks: [a, b, c] }));
  const d1 = result.temporal.movement.find(item => item.playerId === 'D1');
  assert.equal(d1.pathLengthFt, 1);
  assert.equal(d1.observedSeconds, 0.5);
  assert.equal(d1.peakSegmentSpeedFtPerSec, 2);
});

test('invalid, duplicate and out-of-bounds frames are explicitly dropped', () => {
  const invalid = frame(11); invalid.players[0].x = NaN;
  const result = analyzePossession(play({ tracks: [frame(10), frame(10), invalid, frame(17), frame(14)] }));
  assert.equal(result.validation.droppedFrames, 3);
  assert.deepEqual(result.temporal.samples.map(sample => sample.t), [10, 14]);
});

test('duplicate player identities within a frame are not silently reused', () => {
  const bad = frame(14); bad.players[1].id = 'H1';
  const result = analyzePossession(play({ tracks: [bad] }));
  assert.equal(result.validation.droppedFrames, 1);
  assert.equal(result.tactical.shotContext, null);
});

test('the same player id on opposing teams does not select the wrong shooter', () => {
  const input = play();
  input.tracks.forEach(record => { record.players.find(player => player.id === 'D1').id = 'H1'; });
  const result = analyzePossession(input);
  assert.equal(result.tactical.shotContext.shooter.team, 'HOU');
  assert.equal(result.tactical.shotContext.nearestDefender.team, 'DAL');
});

test('ranking components disclose missing points and coverage intervals', () => {
  const input = play({ tracks: [] }); delete input.metrics.gravity.range;
  const result = analyzePossession(input);
  assert.equal(result.rank.coverage, 0.75);
  assert.equal(result.rank.priorityScore, 55);
  assert.equal(result.rank.score, 73.33);
  assert.deepEqual(result.rank.scoreInterval, [55, 80]);
  assert.equal(result.rank.components.find(component => component.key === 'gravity').points, null);
});

test('key-possession editorial ranking never depends on made versus missed', () => {
  const one = play({ tracks: [] }); const two = play({ id: 'p02', outcome: 'missed', tracks: [] });
  const rows = rankPossessions([one, two]);
  assert.equal(rows[0].rank.priorityScore, rows[1].rank.priorityScore);
  assert.deepEqual(rows[0].rank.components, rows[1].rank.components.map(component => ({ ...component, evidenceIds: component.evidenceIds.map(id => id.replace('p02', 'p01')) })));
});

test('different difficulty definitions are omitted from cross-possession ranking', () => {
  const one = play({ tracks: [] }); const two = play({ id: 'p02', tracks: [] });
  two.metrics.difficulty = metric(0.6, 'shot_difficulty');
  const rows = rankPossessions([one, two]);
  assert.ok(rows.every(row => row.rank.incompatibleFields.includes('difficulty')));
  assert.ok(rows.every(row => row.rank.components.find(component => component.key === 'difficulty').points === null));
});

test('different gravity units are omitted rather than rescaled into a fake common vendor metric', () => {
  const one = play({ tracks: [] }); const two = play({ id: 'p02', tracks: [] }); two.metrics.gravity.unit = 'another-vendor-unit';
  const rows = rankPossessions([one, two]);
  assert.ok(rows.every(row => row.rank.incompatibleFields.includes('gravity')));
});

test('schematic geometry is not placed on the same ranking scale as measured geometry', () => {
  const one = play(); const two = play({ id: 'p02' }); two.tracking.kind = 'schematic';
  assert.ok(rankPossessions([one, two]).every(row => row.rank.incompatibleFields.includes('opportunity')));
});

test('all narration cues carry absolute and matching relative time anchors', () => {
  const input = play(); const result = buildNarration(input, analyzePossession(input));
  assert.equal(result.timeBase, 'video');
  for (const cue of result.cues) {
    assert.ok(cue.start >= input.start && cue.end <= input.end && cue.end > cue.start);
    assert.equal(cue.relativeStart, cue.start - input.start);
    assert.equal(cue.relativeEnd, cue.end - input.start);
    assert.ok(cue.evidenceIds.length > 0);
  }
});

test('no outcome cue can start before its explicit reveal timestamp', () => {
  const input = play(); const full = buildNarration(input, analyzePossession(input));
  const outcome = full.cues.find(cue => cue.evidenceIds.includes('p01:outcome'));
  assert.equal(outcome.start, 15);
  const before = buildNarration(input, analyzePossession(input, { asOf: 14.9 }));
  assert.ok(!before.cues.some(cue => cue.evidenceIds.includes('p01:outcome')));
  assert.match(before.text, /尚未揭晓/);
});

test('full-window duration is not narrated before its last observed sample', () => {
  const input = play(); const result = buildNarration(input, analyzePossession(input));
  const claim = result.claims.find(item => item.id.endsWith(':window'));
  assert.equal(claim.t, 16);
  assert.ok(!result.cues.some(cue => cue.evidenceIds.some(id => id.includes(':window:')) && cue.start < 16));
});

test('the first spatial observation cue cites a contemporaneous frame instead of future duration', () => {
  const input = play(); const analysis = analyzePossession(input); const narration = buildNarration(input, analysis);
  const claim = narration.claims.find(item => item.id.endsWith(':window-observation'));
  const evidence = analysis.evidence.find(item => item.id === claim.evidenceIds[0]);
  assert.equal(claim.t, 10.5);
  assert.equal(evidence.t, 10.5);
  assert.equal(evidence.field, 'tracks.players.nearest-observed-defender');
  assert.equal(Object.hasOwn(evidence.value, 'duration'), false);
});

test('narration evidence references can be resolved without the private input record', () => {
  const input = play(); const analysis = analyzePossession(input); const narration = buildNarration(input, analysis, { audience: 'analyst' });
  const ids = new Set(analysis.evidence.map(item => item.id));
  assert.ok(narration.evidenceIds.every(id => ids.has(id)));
});

test('a narrator cannot attach one possession analysis to another video possession', () => {
  assert.throws(() => buildNarration(play({ id: 'p02' }), analyzePossession(play())), AnalysisError);
});

test('free-text query resolves p01 without accidentally also matching p010', () => {
  const result = queryEvidence([play(), play({ id: 'p010' })], 'p01 的来源证据');
  assert.deepEqual(result.matches.map(item => item.playId), ['p01']);
});

test('an unknown explicit possession is reported, never substituted with a top-ranked one', () => {
  const result = queryEvidence([play()], '比较 p99 的投篮难度');
  assert.equal(result.matches.length, 0);
  assert.match(result.answer, /没有 p99/);
});

test('structured query scopes by team, player and period', () => {
  const result = queryEvidence([play(), play({ id: 'p02', team: 'DAL' })], { intent: 'metric', metric: 'difficulty', team: 'HOU', player: 'H1', period: 3 });
  assert.deepEqual(result.matches.map(item => item.playId), ['p01']);
  assert.match(result.answer, /40%/);
});

test('a difficulty ordering question is not silently converted to key-possession editorial order', () => {
  const second = play({ id: 'p02' }); second.metrics.difficulty.value = 0.8; second.metrics.leverage.value = 0.9;
  const result = queryEvidence([play(), second], '按投篮难度排序');
  assert.equal(result.intent, 'metric');
  assert.equal(result.matches[0].playId, 'p01');
  assert.match(result.answer, /编辑难度 1−xFG 0.6/);
});

test('asking for the highest xFG orders the source probability rather than inverse difficulty', () => {
  const second = play({ id: 'p02' }); second.metrics.difficulty.value = 0.8;
  const result = queryEvidence([play(), second], 'xFG 最高的是哪个回合？');
  assert.equal(result.matches[0].playId, 'p02');
  assert.ok(result.answer.startsWith('p02：预期命中概率 80%'));
});

test('queryEvidence obeys asOf instead of leaking results through a global search', () => {
  const result = queryEvidence([play()], { intent: 'evidence', asOf: 14 });
  assert.equal(result.matches[0].analysis.outcome.value, 'unknown');
  assert.equal(result.evidence.find(item => item.id === 'p01:outcome').value, 'unknown');
});

test('Agent retrieval omits bulky frame arrays while the detailed analysis remains available', () => {
  const input = play({ end: 110, shotTime: 100, resultTime: 101, tracks: Array.from({ length: 1000 }, (_, index) => frame(10 + index * 0.1)) });
  const result = queryEvidence([input], { intent: 'summary' });
  assert.equal(result.matches[0].analysis.temporal.samples.length, 0);
  assert.equal(result.matches[0].analysis.outputTruncated.samplesOmitted, 1000);
  assert.equal(result.output.trackingSamplesIncluded, 0);
  assert.ok(JSON.stringify(result).length < 20000);
  assert.equal(analyzePossession(input).temporal.samples.length, 1000);
});

test('many disconnected opportunity windows have a bounded Agent answer and matching evidence', () => {
  const input = play({ end: 220, shotTime: 214, resultTime: 215, tracks: Array.from({ length: 100 }, (_, index) => [frame(10 + index * 2), frame(10.5 + index * 2)]).flat() });
  const result = queryEvidence([input], { intent: 'opportunities' });
  assert.equal(result.matches[0].analysis.temporal.opportunityWindows.length, 8);
  assert.ok(result.matches[0].analysis.outputTruncated.opportunityWindowsOmitted > 0);
  assert.equal(result.evidence.length, 16);
  assert.match(result.answer, /仅列前 8 个/);
  assert.ok(result.matches[0].analysis.temporal.opportunityWindows.every(window => result.evidenceIds.includes(window.evidenceId)));
});

test('editorial priority has its own derived evidence with input component references', () => {
  const result = queryEvidence([play()], { intent: 'rank' });
  const evidence = result.evidence.find(item => item.id === 'p01:rank');
  assert.equal(evidence.kind, 'derived');
  assert.equal(evidence.value.priorityScore, result.matches[0].rank.priorityScore);
  assert.ok(evidence.value.components.every(component => component.evidenceIds.every(id => result.evidenceIds.includes(id))));
});

test('cross-possession ranking evidence uses the actual compatible-field calculation', () => {
  const second = play({ id: 'p02', tracks: [] }); second.metrics.difficulty = metric(0.6, 'shot_difficulty');
  const rows = rankPossessions([play({ tracks: [] }), second]);
  for (const row of rows) {
    const evidence = row.analysis.evidence.find(item => item.id === `${row.id}:rank`);
    assert.equal(evidence.value.coverage, row.rank.coverage);
    assert.equal(evidence.value.components.find(component => component.key === 'difficulty').points, null);
  }
});

test('metric query with incompatible units reports the comparison boundary', () => {
  const two = play({ id: 'p02' }); two.metrics.gravity.unit = 'other-unit';
  const result = queryEvidence([play(), two], { intent: 'metric', metric: 'gravity' });
  assert.match(result.warnings.join(' '), /单位不一致/);
});

test('causal wording is answered with evidence and an explicit descriptive boundary', () => {
  const result = queryEvidence([play()], 'p01 的引力为什么导致命中？');
  assert.match(result.answer, /不能证明因果/);
  assert.ok(result.evidenceIds.includes('p01:metric:gravity'));
});

test('queries requesting unsupported metrics cannot silently become ranking questions', () => {
  assert.throws(() => queryEvidence([play()], { intent: 'metric', metric: 'salary' }), AnalysisError);
  assert.throws(() => queryEvidence([play()], { intent: 'delete_project' }), AnalysisError);
});

test('bounded input rejects invalid duration, time anchors, ids and counts', () => {
  for (const invalid of [play({ start: -1 }), play({ end: 10 }), play({ shotTime: 99 }), play({ resultTime: 13 }), play({ id: '' }), play({ tracks: new Array(ANALYTICS_LIMITS.framesPerPlay + 1) })]) {
    assert.throws(() => analyzePossession(invalid), AnalysisError);
  }
  assert.throws(() => rankPossessions([play(), play()]), AnalysisError);
  assert.throws(() => rankPossessions(new Array(ANALYTICS_LIMITS.plays + 1)), AnalysisError);
  assert.throws(() => queryEvidence([play()], 'x'.repeat(ANALYTICS_LIMITS.queryCharacters + 1)), AnalysisError);
});

test('invalid asOf is rejected even for an empty query scope', () => {
  assert.throws(() => analyzePossession(play(), { asOf: NaN }), AnalysisError);
  assert.throws(() => analyzePossession(play(), { asOf: -1 }), AnalysisError);
  assert.throws(() => rankPossessions([], { asOf: Infinity }), AnalysisError);
  assert.throws(() => queryEvidence([], { intent: 'summary', asOf: NaN }), AnalysisError);
});

test('analysis and narration leave the original project records unchanged', () => {
  const input = play(); const before = clone(input);
  const analysis = analyzePossession(input); buildNarration(input, analysis); queryEvidence([input], 'p01 的空位'); rankPossessions([input]);
  assert.deepEqual(input, before);
});

test('empty datasets are a valid no-match result, never an invented example', () => {
  assert.deepEqual(rankPossessions([]), []);
  const result = queryEvidence([], { intent: 'summary' });
  assert.equal(result.matches.length, 0);
  assert.match(result.answer, /没有匹配回合/);
});
