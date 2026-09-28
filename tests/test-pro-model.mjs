import test from 'node:test';
import assert from 'node:assert/strict';
import { VERSION, LIMITS, newProject, normalizeMetric, validateProject, parseInput, fromLegacy, datasetForLegacy, exportProject, summarize } from '../pro/model.mjs';
import { analyzePossession } from '../pro/analytics.mjs';

const source = { kind: 'official', label: 'Provider declaration, not authentication', source: 'fixture://provider' };
function record(extra = {}) {
  return { id: 'p01', title: 'Fixture possession', start: 10, end: 20, shotTime: 17, resultTime: 18, team: 'HOU', player: 'H3', shotValue: 3, outcome: 'unknown',
    metrics: {}, tracking: { kind: 'unverified', coordinateSystem: 'unknown' }, tracks: [], screenTracks: [], annotations: [], sourceRefs: [], reviewed: false, ...extra };
}
function project(extra = {}) {
  return { ...newProject('Provider game'), provenance: source, plays: [record()], ...extra };
}
function json(records = [record()], extra = {}) {
  return JSON.stringify({ name: 'Provider game', provenance: source, plays: records, ...extra });
}
function legacy(extra = {}) {
  return { schema_version: '1.0', provenance: source, game: { title: 'Provider game' },
    metric_semantics: { xfg_pct: 'shot_make_probability', gravity: 'supplied_metric', leverage: 'player_cumulative_leverage_score' },
    metric_definitions: { xfg_pct: 'Provider single-shot probability v2', gravity: 'Provider gravity in vendor-units', leverage: 'Provider cumulative Leverage Score (-10 to +10)' },
    possessions: [{ id: 'p01', title: 'Original', start: 10, end: 20, shot_time: 17, result_time: 18, clock: 'Q3 07:41', offense: 'HOU', shooter: 'H3', result: 'unknown', points: 3,
      metrics: { xfg_pct: 0.42, gravity: 1.8, leverage: 0.7 }, tracks: [{ t: 17, players: [{ id: 'H3', team: 'HOU', x: 0.5, y: 0.5 }] }],
      source_refs: ['fixture://raw'], camera_segments: [{ start: 10, end: 20, calibrated: true }], annotations: [], provider_extra: { version: 2, originalLabel: 'Do not rename my metric.' } }], ...extra };
}

test('new projects start with no fabricated match, shot, metric or media records', () => {
  const value = newProject('My game');
  assert.equal(value.schema, VERSION);
  assert.deepEqual(value.plays, []);
  assert.deepEqual(value.playlist, []);
  assert.equal(value.video, null);
  assert.equal(validateProject(value), true);
});

test('unknown outcome remains unknown rather than made', () => {
  for (const outcome of [null, '', 'unknown', '0', 'not-observed']) {
    const result = parseInput(json([record({ outcome })]), 'game.json').project;
    assert.equal(result.plays[0].outcome, 'unknown');
    assert.equal(summarize(result).unknown, 1);
    assert.equal(analyzePossession(result.plays[0]).outcome.value, 'unknown');
  }
});

test('explicit made and missed outcomes survive import unchanged', () => {
  const result = parseInput(json([record({ outcome: 'made' }), record({ id: 'p02', outcome: 'missed' })]), 'game.json').project;
  assert.deepEqual(result.plays.map(play => play.outcome), ['made', 'missed']);
});

test('blank and null optional numeric fields remain null, while a real zero timestamp survives', () => {
  const result = parseInput(json([record({ start: 0, end: 5, shotTime: '', resultTime: null, shotValue: '' })]), 'game.json').project;
  assert.equal(result.plays[0].start, 0);
  assert.equal(result.plays[0].shotTime, null);
  assert.equal(result.plays[0].resultTime, null);
  assert.equal(result.plays[0].shotValue, null);
});

test('required blank start cannot become a zero second possession', () => {
  assert.throws(() => parseInput(json([record({ start: '' })]), 'game.json'));
  assert.throws(() => parseInput(json([record({ start: null })]), 'game.json'));
});

test('explicit null optional canonical time is not resurrected from a contradictory legacy alias', () => {
  const result = parseInput(json([record({ shotTime: null, shot_time: 17, resultTime: null, result_time: 18 })]), 'game.json').project;
  assert.equal(result.plays[0].shotTime, null);
  assert.equal(result.plays[0].resultTime, null);
});

test('explicit missing nested metric is not replaced by a top-level alternate reading', () => {
  const result = parseInput(json([record({ metrics: { xfg_pct: null }, xfg_pct: 0.8 })]), 'game.json').project;
  assert.equal(result.plays[0].metrics.xfg_pct ?? null, null);
});

test('booleans are rejected as imported JSON times rather than interpreted as 0 or 1', () => {
  assert.throws(() => parseInput(json([record({ start: false })]), 'game.json'));
  assert.throws(() => parseInput(json([record({ end: true, start: 0 })]), 'game.json'));
});

test('booleans are rejected as measurements rather than treated as perfect probability', () => {
  assert.throws(() => parseInput(json([record({ metrics: { xfg_pct: true } })]), 'game.json'));
});

test('provided zero probability and zero gravity are measured values, not missing', () => {
  const result = parseInput(json([record({ metrics: { xfg_pct: 0, gravity: 0 } })]), 'game.json').project;
  assert.equal(result.plays[0].metrics.xfg_pct.value, 0);
  assert.equal(result.plays[0].metrics.gravity.value, 0);
});

test('metric object preserves official definition, scale, provenance, time and extra provider metadata', () => {
  const raw = { value: 6.2, semantics: 'player_cumulative_leverage_score', unit: 'Leverage Score', definition: 'Provider definition v7', availableAt: 20, range: [-10, 10], provenance: source, providerVersion: '7' };
  const normalized = normalizeMetric(raw, 'leverage', source);
  assert.deepEqual(normalized, raw);
  normalized.provenance.source = 'changed';
  assert.equal(raw.provenance.source, 'fixture://provider');
});

test('a null-valued metric record may preserve its official definition without inventing a zero', () => {
  const metric = { value: null, semantics: 'shot_make_probability', unit: 'probability', definition: 'Not provided for this possession', provenance: source };
  const result = parseInput(json([record({ metrics: { xfg_pct: metric } })]), 'game.json').project;
  assert.equal(result.plays[0].metrics.xfg_pct.value, null);
  assert.equal(result.plays[0].metrics.xfg_pct.semantics, 'shot_make_probability');
});

test('unknown scalar Leverage never receives a guessed possession-opportunity meaning', () => {
  const result = parseInput(json([record({ metrics: { leverage: 0.7 } })]), 'game.json').project;
  assert.equal(result.plays[0].metrics.leverage.semantics, 'unknown');
  assert.equal(analyzePossession(result.plays[0]).metrics.leverage.normalized, null);
});

test('CSV column mapping supports quoted commas, escaped quotes and a multiline title', () => {
  const input = '\uFEFFclip,begin,finish,athlete,result,caption\r\nA,10,20,"Curry, Stephen",unknown,"Look at ""this""\nspace"\r\n';
  const parsed = parseInput(input, 'game.csv', { id: 'clip', start: 'begin', end: 'finish', player: 'athlete', outcome: 'result', title: 'caption' });
  assert.equal(parsed.project.plays[0].id, 'A');
  assert.equal(parsed.project.plays[0].player, 'Curry, Stephen');
  assert.equal(parsed.project.plays[0].title, 'Look at "this"\nspace');
  assert.equal(parsed.project.plays[0].outcome, 'unknown');
});

test('malformed CSV fails instead of shifting source columns silently', () => {
  assert.throws(() => parseInput('id,start,end\np01,10\n', 'game.csv'));
  assert.throws(() => parseInput('id,start,start\np01,10,20\n', 'game.csv'));
  assert.throws(() => parseInput('id,start,end\n"p01,10,20', 'game.csv'));
});

test('CSV cannot accept arbitrary text immediately after a closed quoted field', () => {
  assert.throws(() => parseInput('id,start,end\n"p01"corrupt,10,20\n', 'game.csv'));
});

test('legacy input retains original per-possession records and provider semantics', () => {
  const original = legacy(); const before = structuredClone(original);
  const result = fromLegacy(original);
  assert.deepEqual(result.plays[0].sourceRecord, original.possessions[0]);
  assert.equal(result.plays[0].metrics.leverage.semantics, 'player_cumulative_leverage_score');
  assert.equal(result.plays[0].metrics.leverage.definition, before.metric_definitions.leverage);
  assert.equal(result.plays[0].tracks.length, 0);
  assert.equal(result.plays[0].screenTracks.length, 1);
  assert.equal(result.plays[0].tracking.coordinateSystem, 'image');
  assert.deepEqual(original, before);
});

test('legacy export preserves the same Leverage meaning instead of rewriting a source metric', () => {
  const imported = fromLegacy(legacy());
  const exported = datasetForLegacy(imported);
  assert.equal(exported.metric_semantics.leverage, 'player_cumulative_leverage_score');
  assert.equal(exported.metric_definitions.leverage, imported.metricDictionary.leverage);
});

test('Arena backup round-trip preserves original source records and independent duplicate clips', () => {
  const original = fromLegacy(legacy());
  original.playlist = [{ playId: 'p01', start: 10, end: 17 }, { playId: 'p01', start: 16, end: 20 }];
  const result = parseInput(exportProject(original), 'backup.json');
  assert.equal(result.kind, 'backup');
  assert.deepEqual(result.project.playlist, original.playlist);
  assert.deepEqual(result.project.plays[0].sourceRecord, original.plays[0].sourceRecord);
});

test('backup cannot refer to an absent possession in its playlist', () => {
  const input = project({ playlist: [{ playId: 'missing', start: 10, end: 20 }] });
  assert.throws(() => parseInput(JSON.stringify(input), 'backup.json'));
});

test('backup playlist trim must remain finite and inside its source possession', () => {
  for (const item of [{ playId: 'p01', start: 9, end: 20 }, { playId: 'p01', start: 11, end: 21 }, { playId: 'p01', start: 17, end: 16 }, { playId: 'p01', start: '10', end: 20 }, { playId: 'p01', start: NaN, end: 20 }]) {
    assert.throws(() => validateProject(project({ playlist: [item] })));
  }
});

test('duplicate occurrences of the same possession are valid independently trimmed clips', () => {
  assert.equal(validateProject(project({ playlist: [{ playId: 'p01', start: 10, end: 18 }, { playId: 'p01', start: 16, end: 20 }] })), true);
});

test('backup top-level arrays have valid shape before the editor can call push and map', () => {
  for (const extra of [{ playlist: {} }, { calibrations: {} }, { notes: {} }, { activity: {} }]) {
    assert.throws(() => parseInput(JSON.stringify(project(extra)), 'backup.json'));
  }
});

test('backup revision and project identifiers cannot corrupt persistent history keys', () => {
  for (const extra of [{ id: '' }, { id: 'x'.repeat(501) }, { revision: -1 }, { revision: 1.2 }, { revision: '2' }]) {
    assert.throws(() => validateProject(project(extra)));
  }
});

test('non-finite video duration is rejected rather than bypassing possession bounds', () => {
  assert.throws(() => validateProject(project({ video: { id: 'media', duration: Infinity, width: 1280, height: 720 } })));
  assert.throws(() => validateProject(project({ video: { id: 'media', duration: NaN, width: 1280, height: 720 } })));
});

test('negative times, inverted results, duplicate possession IDs and unknown numeric infinities fail', () => {
  for (const play of [record({ start: -1 }), record({ end: 10 }), record({ resultTime: 16 }), record({ metrics: { gravity: { value: Infinity, semantics: 'supplied_metric' } } })]) {
    assert.throws(() => validateProject(project({ plays: [play] })));
  }
  assert.throws(() => validateProject(project({ plays: [record(), record()] })));
});

test('declared play-count limit is enforced before downstream analysis', () => {
  assert.throws(() => parseInput(json(Array.from({ length: LIMITS.plays + 1 }, (_, index) => record({ id: `p${index}` }))), 'game.json'));
});

test('input budget measures UTF-8 bytes, not the number of Chinese characters', () => {
  const input = '中'.repeat(Math.floor(LIMITS.bytes / 3) + 1);
  assert.throws(() => parseInput(input, 'game.json'), /16|MiB|容量/);
});

test('a validated project cannot contain a possession too long for the registered analysis kernel', () => {
  assert.throws(() => validateProject(project({ plays: [record({ start: 0, end: 700, shotTime: 650, resultTime: 660 })] })));
});

test('a validated project cannot contain more players than the registered analysis kernel supports', () => {
  const players = Array.from({ length: 21 }, (_, index) => ({ id: `player${index}`, team: index < 5 ? 'HOU' : 'DAL', x: index, y: 1 }));
  assert.throws(() => validateProject(project({ plays: [record({ tracks: [{ t: 17, players }] })] })));
});

test('a validated single possession cannot exceed the analysis kernel frame bound', () => {
  const tracks = Array.from({ length: 10001 }, (_, index) => ({ t: 10 + index / 1001, players: [{ id: 'H3', team: 'HOU', x: 10, y: 10 }] }));
  assert.throws(() => validateProject(project({ plays: [record({ tracks })] })));
});

test('standard imported records pass both project validation and the independent analysis kernel', () => {
  const result = parseInput(json([record({ metrics: { xfg_pct: { value: 0.42, semantics: 'shot_make_probability', availableAt: 17, provenance: source } } })]), 'game.json').project;
  assert.equal(validateProject(result), true);
  assert.equal(analyzePossession(result.plays[0]).metrics.difficulty.value, 0.42);
});
