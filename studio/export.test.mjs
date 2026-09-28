import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReport, makeVTT, recordPlaylist } from './export.mjs';
import { createProject, validateProject } from './domain.mjs';

function fixture() {
  const project = createProject({ name: 'City vs Harbor', source: 'Club practice recording; manually annotated', opponent: 'Harbor', date: '2026-09-22' });
  project.video = { id: 'video-1', name: 'practice.mp4', size: 1024, duration: 30, width: 1280, height: 720, sha256: '' };
  const common = { shooter: 'A', team: 'City', reviewed: true, tag: 'Transition', notes: '', x: null, y: null, source: 'Coach review' };
  project.plays = [
    { ...common, id: 'p1', start: 0, end: 6, shotTime: 2, resultTime: 3, points: 3, made: true, xfg: 0.6 },
    { ...common, id: 'p2', start: 10, end: 16, shotTime: 11, resultTime: 12, points: 2, made: false, xfg: 0.25 },
    { ...common, id: 'p3', start: 20, end: 24, shotTime: 21, resultTime: 22, shooter: 'B', points: 2, made: null, xfg: null },
  ];
  project.playlist = [
    { id: 'c1', playId: 'p1', in: 2, out: 5, title: 'Spoiler: MADE winner' },
    { id: 'c2', playId: 'p2', in: 13, out: 15, title: 'Spoiler: MISSED' },
  ];
  project.status = 'approved';
  project.revision = 7;
  assert.equal(validateProject(project).filter(issue => issue.severity === 'error').length, 0);
  return project;
}

function cues(vtt) {
  return vtt.trim().split(/\n\n/).slice(1).map(block => {
    const [id, time, ...text] = block.split('\n');
    return { id, time, text: text.join('\n') };
  });
}

test('VTT concatenates selected clips and splits exactly at result revelation', () => {
  const output = cues(makeVTT(fixture()));
  assert.deepEqual(output.map(cue => cue.time), [
    '00:00:00.000 --> 00:00:01.000',
    '00:00:01.000 --> 00:00:03.000',
    '00:00:03.000 --> 00:00:05.000',
  ]);
  assert.match(output[0].text, /结果待揭示/);
  assert.doesNotMatch(output[0].text, /命中|未中|MADE|winner|MISSED/);
  assert.match(output[1].text, /\n命中$/);
  assert.match(output[2].text, /\n未中$/);
});

test('VTT excludes arbitrary titles and notes even after a known result', () => {
  const project = fixture();
  project.plays[0].notes = 'THE WINNING SHOT';
  assert.doesNotMatch(makeVTT(project), /Spoiler|THE WINNING SHOT/);
});

test('unknown outcomes remain unknown and do not become misses', () => {
  const project = fixture();
  project.playlist = [{ id: 'unknown', playId: 'p3', in: 20, out: 24, title: '' }];
  const output = cues(makeVTT(project));
  assert.equal(output.length, 1);
  assert.equal(output[0].time, '00:00:00.000 --> 00:00:04.000');
  assert.match(output[0].text, /结果未知/);
  assert.doesNotMatch(output[0].text, /命中|未中/);
});

test('clip ending at result time never reveals that result', () => {
  const project = fixture();
  project.playlist = [{ id: 'cut', playId: 'p1', in: 0, out: 3, title: '' }];
  assert.equal(cues(makeVTT(project)).length, 1);
  assert.doesNotMatch(makeVTT(project), /\n命中/);
});

test('clip beginning at result time reveals the already known result', () => {
  const project = fixture();
  project.playlist = [{ id: 'cut', playId: 'p1', in: 3, out: 5, title: '' }];
  assert.match(cues(makeVTT(project))[0].text, /\n命中$/);
});

test('sub-millisecond result time rounds forward, never early', () => {
  const project = fixture();
  project.plays[0].resultTime = 3.0004;
  const output = cues(makeVTT(project));
  assert.equal(output[0].time, '00:00:00.000 --> 00:00:01.001');
  assert.equal(output[1].time, '00:00:01.001 --> 00:00:03.000');
});

test('no playlist means all plays in project order; repeated clips are preserved', () => {
  const project = fixture();
  project.playlist = [];
  const output = cues(makeVTT(project));
  assert.equal(output.at(-1).time, '00:00:12.000 --> 00:00:16.000');
  project.playlist = [fixture().playlist[0], { ...fixture().playlist[0], id: 'repeat' }];
  assert.equal(cues(makeVTT(project)).at(-1).time, '00:00:04.000 --> 00:00:06.000');
});

test('VTT user text cannot inject markup, lines, or a new cue', () => {
  const project = fixture();
  project.plays[0].shooter = '<b>A</b> & B\n\n00:00:00.000 --> 00:00:10.000\nINJECT';
  const output = makeVTT(project);
  assert.doesNotMatch(output, /<b>|\nINJECT|\n\n00:00:00.000/);
  assert.match(output, /&lt;b&gt;A&lt;\/b&gt; &amp; B/);
  assert.equal(cues(output).length, 3);
});

test('invalid playlist references and ranges fail rather than quietly changing selection', () => {
  const project = fixture();
  project.playlist[0].playId = 'missing';
  assert.throws(() => makeVTT(project), /引用或时间范围无效/);
  project.playlist = [{ id: 'bad', playId: 'p1', in: -1, out: 2, title: '' }];
  assert.throws(() => makeVTT(project), /引用或时间范围无效/);
  project.plays = [];
  project.playlist = [];
  assert.throws(() => makeVTT(project), /至少一个/);
});

test('report gives correct denominator, eFG, subset expectation, and revision', () => {
  const output = makeReport(fixture());
  assert.match(output, /A · City/);
  assert.match(output, /50\.0%/);
  assert.match(output, /75\.0%/);
  assert.match(output, /1 命中 \/ 2 次已知结果/);
  assert.match(output, /<strong>2\.3<\/strong>/);
  assert.match(output, /xFG 已提供 2 \/ 3 条/);
  assert.match(output, /修订 7/);
  assert.match(output, /未知结果不计作未中/);
  assert.match(output, /共 2 段 \/ 5 秒/);
  assert.match(output, /播放列表中的重复片段不会重复计入/);
});

test('report preserves unknown aggregates and is useful for empty drafts', () => {
  const project = createProject({ name: 'Empty' });
  const output = makeReport(project);
  assert.match(output, /草稿/);
  assert.match(output, /期望投篮得分<\/span><strong>—/);
  assert.match(output, /投篮命中率 FG%<\/span><strong>—/);
  assert.match(output, /暂无有效片段/);
  assert.match(output, /尚未提供来源说明/);
  assert.match(output, /数据检查/);
});

test('report escapes every displayed free-text surface and has no remote dependencies', () => {
  const project = fixture();
  const attack = '<script src="https://evil.invalid/x">"&\'</script>';
  project.name = attack;
  project.source = attack;
  project.opponent = attack;
  project.plays[0].shooter = attack;
  project.plays[0].notes = attack;
  project.plays[0].tag = attack;
  project.plays[0].source = attack;
  project.playlist[0].title = attack;
  project.video.name = attack;
  const output = makeReport(project);
  assert.doesNotMatch(output, /<script|<iframe|<link|<img|<a\s|<style[^>]*src=/i);
  assert.match(output, /&lt;script src=&quot;https:\/\/evil.invalid\/x&quot;&gt;&quot;&amp;&#39;&lt;\/script&gt;/);
  assert.match(output, /Content-Security-Policy/);
  assert.match(output, /@media print/);
});

test('shot chart appears only for explicit valid coordinate pairs', () => {
  const project = fixture();
  assert.doesNotMatch(makeReport(project), /<svg/);
  project.plays[0].x = 0.4;
  project.plays[0].y = 0.8;
  project.plays[1].x = 0.2;
  project.plays[1].y = 0.1;
  const output = makeReport(project);
  assert.match(output, /<svg/);
  assert.match(output, /2 \/ 3<\/b> 条回合/);
  assert.match(output, /cx="212" cy="388"/);
  assert.match(output, /坐标来自人工填写或导入/);
});

test('recording rejects unapproved, invalid, unbound, and oversized projects before touching media', async () => {
  const project = fixture();
  project.status = 'draft';
  await assert.rejects(recordPlaylist({ project }), /先批准/);
  project.status = 'approved';
  project.plays[0].reviewed = false;
  await assert.rejects(recordPlaylist({ project }), /复核|reviewed/);
  project.plays[0].reviewed = true;
  project.video.needsReattach = true;
  await assert.rejects(recordPlaylist({ project }), /Reattach|重新绑定/);
  delete project.video.needsReattach;
  project.playlist = Array.from({ length: 61 }, (_, i) => ({ ...fixture().playlist[0], id: `clip-${i}` }));
  await assert.rejects(recordPlaylist({ project }), /最多 180 秒/);
});

test('recording rejects wrong media identity and unsupported runtime, never returns a fake file', async () => {
  const project = fixture();
  const video = { src: 'blob:real-video', play() {} };
  await assert.rejects(recordPlaylist({ project, video: { ...video, dataset: { mediaId: 'wrong-video' } } }), /不属于当前项目/);
  await assert.rejects(recordPlaylist({ project, video }), /此浏览器不支持/);
});

test('already aborted recording has AbortError without touching player', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recordPlaylist({ project: fixture(), signal: controller.signal }), error => error.name === 'AbortError');
});

// These test doubles exercise cleanup paths; they do not claim to encode WebM.
async function withBrowserFailure(mode, run) {
  const saved = Object.fromEntries(['document', 'MediaRecorder', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const track = { stopped: false, stop() { this.stopped = true; } };
  const context = { fillRect() {}, drawImage() {}, fillText() {}, measureText(text) { return { width: text.length * 9 }; }, getImageData() { if (mode === 'tainted') throw new Error('SecurityError'); return {}; } };
  const canvas = { width: 0, height: 0, getContext() { return context; }, captureStream() { return { getTracks() { return [track]; }, getVideoTracks() { return [track]; }, getAudioTracks() { return []; } }; } };
  const document = new EventTarget();
  document.hidden = false;
  document.createElement = () => canvas;
  const video = new EventTarget();
  Object.assign(video, { readyState: 4, duration: 30, videoWidth: 1280, videoHeight: 720, src: 'blob:practice', paused: true, muted: false, volume: 0.7, playbackRate: 1.5, loop: true, seeking: false, dataset: { mediaId: 'video-1' } });
  let time = 9;
  Object.defineProperty(video, 'currentTime', { get() { return time; }, set(value) { time = value; queueMicrotask(() => video.dispatchEvent(new Event('seeked'))); } });
  video.pause = () => { video.paused = true; };
  video.play = async () => { video.paused = false; };
  class FailedRecorder {
    static isTypeSupported() { return mode !== 'unsupported'; }
    constructor() { throw new Error('Encoder could not initialize'); }
  }
  Object.assign(globalThis, { document, MediaRecorder: FailedRecorder, requestAnimationFrame: callback => setTimeout(callback, 1), cancelAnimationFrame: clearTimeout });
  try { await run({ video, canvas, track }); }
  finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('encoder initialization failure stops stream and restores all player state', async () => {
  await withBrowserFailure('encoder', async ({ video, canvas, track }) => {
    await assert.rejects(recordPlaylist({ project: fixture(), video }), /Encoder could not initialize/);
    assert.equal(track.stopped, true);
    assert.equal(video.currentTime, 9);
    assert.equal(video.paused, true);
    assert.equal(video.muted, false);
    assert.equal(video.volume, 0.7);
    assert.equal(video.playbackRate, 1.5);
    assert.equal(video.loop, true);
    assert.equal(canvas.width, 0);
    // A failed attempt must release the active-video guard, allowing a retry.
    await assert.rejects(recordPlaylist({ project: fixture(), video }), /Encoder could not initialize/);
  });
});

test('cross-origin canvas failure restores player and never returns a blob', async () => {
  await withBrowserFailure('tainted', async ({ video }) => {
    await assert.rejects(recordPlaylist({ project: fixture(), video }), /禁止画布读取/);
    assert.equal(video.currentTime, 9);
    assert.equal(video.muted, false);
    assert.equal(video.playbackRate, 1.5);
  });
});

test('unsupported WebM fails before changing playback', async () => {
  await withBrowserFailure('unsupported', async ({ video }) => {
    await assert.rejects(recordPlaylist({ project: fixture(), video }), /不支持 WebM/);
    assert.equal(video.currentTime, 9);
    assert.equal(video.muted, false);
    assert.equal(video.playbackRate, 1.5);
  });
});
