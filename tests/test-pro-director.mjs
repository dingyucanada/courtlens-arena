import test from 'node:test';
import assert from 'node:assert/strict';
import { playlistPlan, timestamp, vtt, report } from '../pro/director.mjs';
import { newProject } from '../pro/model.mjs';
import { analyzePossession, buildNarration } from '../pro/analytics.mjs';

const play = (id, start, end, shotTime, resultTime, outcome) => ({ id, title: `Story ${id}`, start, end, shotTime, resultTime, team: 'HOU', player: 'H3', shotValue: 3, outcome,
  metrics: { xfg_pct: { value: 0.42, semantics: 'shot_make_probability', availableAt: shotTime, provenance: { kind: 'measured', source: 'fixture' } } }, tracks: [], annotations: [], provenance: { kind: 'measured', source: 'fixture' } });
function fixture() {
  const project = newProject('Fixture film');
  project.provenance = { kind: 'measured', label: 'Test records', source: 'fixture://source' };
  project.plays = [play('p01', 10, 20, 17, 18, 'made'), play('p02', 30, 42, 39, 40, 'missed')];
  project.playlist = [{ playId: 'p01', start: 15, end: 20 }, { playId: 'p02', start: 38, end: 42 }, { playId: 'p01', start: 16, end: 19 }];
  const analyses = Object.fromEntries(project.plays.map(play => [play.id, analyzePossession(play)]));
  const narrations = Object.fromEntries(project.plays.map(play => [play.id, buildNarration(play, analyses[play.id])]));
  return { project, analyses, narrations };
}

test('playlist order preserves duplicate source possession occurrences and correct concatenated duration', () => {
  const { project, narrations } = fixture();
  const plan = playlistPlan(project, narrations);
  assert.equal(plan.clips.length, 3);
  assert.deepEqual(plan.clips.map(clip => clip.playId), ['p01', 'p02', 'p01']);
  assert.deepEqual(plan.clips.map(clip => [clip.outputStart, clip.outputEnd]), [[0, 5], [5, 9], [9, 12]]);
  assert.equal(plan.duration, 12);
});

test('trimmed caption cues are clipped and translated from video seconds to concatenated film seconds', () => {
  const { project, narrations } = fixture();
  const plan = playlistPlan(project, narrations);
  const made = plan.cues.filter(cue => cue.evidenceIds.includes('p01:outcome'));
  assert.deepEqual(made.map(cue => [cue.start, cue.end, cue.sourceStart, cue.sourceEnd]), [[3, 5, 18, 20], [11, 12, 18, 19]]);
  const missed = plan.cues.find(cue => cue.evidenceIds.includes('p02:outcome'));
  assert.deepEqual([missed.start, missed.end, missed.sourceStart, missed.sourceEnd], [7, 9, 40, 42]);
});

test('no result caption is moved earlier than its independent source-video reveal', () => {
  const { project, narrations } = fixture();
  const plan = playlistPlan(project, narrations);
  for (const cue of plan.cues) {
    const play = project.plays.find(play => play.id === cue.playId);
    if (cue.evidenceIds.includes(`${play.id}:outcome`)) assert.ok(cue.sourceStart >= play.resultTime);
    assert.ok(cue.start >= 0 && cue.end <= plan.duration && cue.end > cue.start);
  }
});

test('output cue relative times cannot retain stale positions from the original possession', () => {
  const { project, narrations } = fixture();
  const plan = playlistPlan(project, narrations);
  for (const cue of plan.cues) {
    if (cue.relativeStart !== undefined) assert.equal(cue.relativeStart, cue.start);
    if (cue.relativeEnd !== undefined) assert.equal(cue.relativeEnd, cue.end);
  }
});

test('trimming entirely before result removes result captions, even though later outcome exists in the source', () => {
  const { project, narrations } = fixture();
  project.playlist = [{ playId: 'p01', start: 14, end: 17.9 }];
  const plan = playlistPlan(project, narrations);
  assert.ok(!plan.cues.some(cue => cue.evidenceIds.includes('p01:outcome')));
  assert.ok(Math.abs(plan.duration - 3.9) < 1e-9);
});

test('a clip starting after result may show it immediately, with the original reveal anchor retained', () => {
  const { project, narrations } = fixture();
  project.playlist = [{ playId: 'p01', start: 18.5, end: 20 }];
  const cue = playlistPlan(project, narrations).cues.find(cue => cue.evidenceIds.includes('p01:outcome'));
  assert.equal(cue.start, 0);
  assert.equal(cue.sourceStart, 18.5);
});

test('playlist with omitted trim defaults to the full source possession', () => {
  const { project, narrations } = fixture(); project.playlist = [{ playId: 'p01' }];
  const plan = playlistPlan(project, narrations);
  assert.deepEqual([plan.clips[0].start, plan.clips[0].end, plan.duration], [10, 20, 10]);
});

test('empty playlist has no invented footage or subtitles', () => {
  const { project, narrations } = fixture(); project.playlist = [];
  assert.deepEqual(playlistPlan(project, narrations), { clips: [], cues: [], duration: 0 });
});

test('absent possession and invalid source trim boundaries reject the plan', () => {
  const { project, narrations } = fixture();
  for (const item of [{ playId: 'p99' }, { playId: 'p01', start: 9, end: 20 }, { playId: 'p01', start: 10, end: 21 }, { playId: 'p01', start: 15, end: 15 }, { playId: 'p01', start: NaN, end: 18 }]) {
    assert.throws(() => playlistPlan({ ...project, playlist: [item] }, narrations));
  }
});

test('invalid narration timestamps cannot silently vanish from an otherwise successful film plan', () => {
  const { project, narrations } = fixture(); project.playlist = [{ playId: 'p01' }];
  for (const cue of [{ start: NaN, end: 18, text: 'Bad time' }, { start: 18, end: 17, text: 'Inverted' }, { start: 8, end: 21, text: 'Outside source' }]) {
    assert.throws(() => playlistPlan(project, { ...narrations, p01: { cues: [cue] } }));
  }
});

test('subtitle VTT uses output timestamps, not source timestamps', () => {
  const { project, narrations } = fixture(); const plan = playlistPlan(project, narrations);
  const text = vtt(plan);
  assert.ok(text.startsWith('WEBVTT\n\n'));
  assert.ok(text.includes('00:00:03.000 --> 00:00:05.000'));
  assert.ok(!text.includes('00:00:18.000 --> 00:00:20.000'));
});

test('caption line breaks cannot inject a second VTT timestamp or cue record', () => {
  const text = vtt({ duration: 2, cues: [{ start: 0, end: 2, text: 'hello\n\n99\n00:00:00.000 --> 99:00:00.000\r\nworld' }] });
  assert.equal(text.split('\n').filter(line => /^\d+$/.test(line)).length, 1);
  assert.equal(text.split('\n').filter(line => /^\d{2}:/.test(line)).length, 1);
});

test('VTT literal text escapes markup and ampersands so user captions remain visible text', () => {
  const text = vtt({ duration: 2, cues: [{ start: 0, end: 2, text: 'A < B & <script>alert(1)</script>' }] });
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('&lt;'));
  assert.ok(text.includes('&amp;'));
});

test('invalid output cue times reject VTT instead of emitting NaN or impossible intervals', () => {
  for (const cue of [{ start: NaN, end: 2, text: 'bad' }, { start: 0, end: Infinity, text: 'bad' }, { start: -1, end: 2, text: 'bad' }, { start: 2, end: 1, text: 'bad' }, { start: 0, end: 3, text: 'bad' }]) {
    assert.throws(() => vtt({ duration: 2, cues: [cue] }));
  }
});

test('millisecond timestamp rounding carries correctly across minute and hour boundaries', () => {
  assert.equal(timestamp(59.9995), '00:01:00.000');
  assert.equal(timestamp(3599.9995), '01:00:00.000');
  assert.equal(timestamp(0), '00:00:00.000');
});

test('non-finite timestamp values cannot produce strings advertised as valid video times', () => {
  assert.throws(() => timestamp(NaN));
  assert.throws(() => timestamp(Infinity));
});

test('HTML story report escapes names, provenance, narration and nested evidence values', () => {
  const { project, analyses, narrations } = fixture();
  project.name = '<script>project()</script>';
  project.provenance.label = '<img src=x onerror=source()> & "quoted"';
  project.provenance.source = '</blockquote><script>source()</script>';
  project.plays[0].title = '<svg onload=title()>';
  narrations.p01.text = '<iframe src=evil></iframe>';
  analyses.p01.evidence.push({ id: 'p01:untrusted', field: '<script>field()</script>', value: { injected: '</td><script>value()</script>' }, unit: '<img src=unit>', kind: '<svg>', t: null });
  const html = report(project, analyses, narrations);
  assert.ok(!/<script\b|<iframe\b|<img\b|<svg\b/i.test(html));
  assert.ok(html.includes('&lt;script&gt;project()'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('未提供'));
});

test('HTML report also escapes untrusted revision metadata instead of interpolating active markup', () => {
  const { project, analyses, narrations } = fixture(); project.revision = '<script>revision()</script>';
  const html = report(project, analyses, narrations);
  assert.ok(!html.includes('<script>revision()</script>'));
  assert.ok(html.includes('&lt;script&gt;revision()'));
});

test('story reports tolerate unavailable per-play analysis without publishing undefined prose', () => {
  const { project } = fixture();
  const html = report(project, {}, {});
  assert.ok(!html.includes('undefined'));
  assert.ok(html.includes('Fixture film'));
});

test('planning and rendering reports do not mutate persisted clips, narratives or evidence', () => {
  const { project, analyses, narrations } = fixture(); const before = structuredClone({ project, analyses, narrations });
  const plan = playlistPlan(project, narrations); vtt(plan); report(project, analyses, narrations);
  assert.deepEqual({ project, analyses, narrations }, before);
});
