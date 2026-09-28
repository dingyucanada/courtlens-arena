import test from 'node:test';
import assert from 'node:assert/strict';
import { recordStory, validateStoryPlan, storyPlayAt, wrapStoryCaption, EXPORT_LIMITS } from '../pro/export-video.mjs';

function fixture(items = [[0, .24], [.8, 1.04], [0, .16]]) {
  const project = { id: 'fixture', name: 'Source game', provenance: { kind: 'measured' }, calibrations: [{ id: 'reviewed-snapshot', playId: 'p01', start: 0, end: 2 }],
    plays: [{ id: 'p01', title: 'Source possession', start: 0, end: 2, shotTime: .5, resultTime: 1, reviewed: true, outcome: 'made', metrics: { xfg_pct: { value: .42, semantics: 'shot_make_probability', availableAt: 1 } } }] };
  let offset = 0;
  const clips = items.map(([start, end]) => { const outputStart = offset; offset += end - start; return { playId: 'p01', start, end, outputStart, outputEnd: offset }; });
  return { project, plan: { clips, duration: offset }, narrations: { p01: { cues: [{ start: 1, end: 1.3, text: 'Result after source reveal', evidenceIds: ['p01:outcome', 'p01:metric:difficulty'] }] } } };
}

class Events {
  constructor() { this.events = new Map(); }
  addEventListener(name, fn, options) { if (!this.events.has(name)) this.events.set(name, new Map()); this.events.get(name).set(fn, { once: options?.once }); }
  removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
  emit(name, extra = {}) { for (const [fn, options] of [...(this.events.get(name) || [])]) { if (options.once) this.removeEventListener(name, fn); fn.call(this, { type: name, ...extra }); } }
  get listenerCount() { return [...this.events.values()].reduce((n, items) => n + items.size, 0); }
}

async function browser(options, run) {
  const originals = new Map(), env = { timers: new Set(), canvases: [], streams: [], recorders: [], rendered: [], captured: [], textDraws: [], locatingWhileRecording: [], seekTimes: [], playing: 0 };
  const after = (fn, ms = 3) => { const timer = setTimeout(() => { env.timers.delete(timer); fn(); }, ms); env.timers.add(timer); return timer; };
  const cancel = id => { clearTimeout(id); env.timers.delete(id); };
  class Video extends Events {
    constructor() { super(); this.duration = 3; this.readyState = 2; this.videoWidth = 1280; this.videoHeight = 720; this.paused = true; this.playbackRate = .5; this.ended = false; this.seeking = false; this._currentTime = 0; this.decodedTime = 0; this.frameIds = new Map(); this.frameNumber = 0; }
    get currentTime() { return this._currentTime; }
    set currentTime(t) {
      env.seekTimes.push(t); if (env.recorder?.state === 'recording') env.locatingWhileRecording.push(t);
      this.seeking = true; this._currentTime = t; this.decodedTime = Math.max(0, t + (options.seekOffset || 0)); this.ended = false;
      if (!options.seekNever) queueMicrotask(() => { this.seeking = false; this.emit('seeked'); });
    }
    advance() { if (!this.paused && !options.stalled) { this.decodedTime += .04; this._currentTime = this.decodedTime + .019; } }
    play() { env.playing++; if (options.playReject) return Promise.reject(new Error('Rejected playback')); this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    requestVideoFrameCallback(callback) {
      const id = ++this.frameNumber;
      const timer = after(() => { this.frameIds.delete(id); this.advance(); callback(0, { mediaTime: this.decodedTime, presentedFrames: id }); });
      this.frameIds.set(id, timer); return id;
    }
    cancelVideoFrameCallback(id) { cancel(this.frameIds.get(id)); this.frameIds.delete(id); }
  }
  const video = new Video(); if (options.raf) { video.requestVideoFrameCallback = undefined; video.cancelVideoFrameCallback = undefined; }
  env.video = video;
  if (options.readyNever) { video.readyState = 0; video.videoWidth = 0; video.videoHeight = 0; }
  class Context {
    save() {} restore() {} setTransform() {} translate() {} fillRect() {}
    drawImage(source) { this.pixelTime = source.decodedTime; }
    measureText(text) { return { width: String(text).length * 12 }; }
    fillText(text) { env.textDraws ||= []; env.textDraws.push({ text, t: this.pixelTime }); }
  }
  class Canvas {
    constructor() { this.ctx = new Context(); this.ctx.canvas = this; env.canvases.push(this); }
    getContext() { return this.ctx; }
    captureStream(rate) {
      const track = { stopped: 0, stop() { this.stopped++; } };
      if (!options.noRequestFrame) track.requestFrame = () => { if (env.recorder?.state === 'recording') env.captured.push({ pixelTime: this.ctx.pixelTime, overlayTime: this.ctx.overlayTime }); };
      const stream = { rate, getVideoTracks: () => [track], getTracks: () => [track], track }; env.streams.push(stream); return stream;
    }
  }
  class Recorder extends Events {
    static isTypeSupported() { return true; }
    constructor(stream, config) {
      super(); if (options.constructorReject) throw new Error('Unsupported encoder');
      this.stream = stream; this.state = 'inactive'; this.mimeType = config.mimeType; this.stops = 0; env.recorders.push(this); env.recorder = this;
    }
    start() { this.state = 'recording'; if (!options.startNever) queueMicrotask(() => this.emit('start')); if (options.encoderError) after(() => this.emit('error', { error: new Error('Encoding failed') }), 5); }
    pause() { this.state = 'paused'; queueMicrotask(() => this.emit('pause')); }
    resume() { this.state = 'recording'; queueMicrotask(() => this.emit('resume')); }
    stop() { this.stops++; this.state = 'inactive'; if (!options.stopNever) queueMicrotask(() => { this.emit('dataavailable', { data: new Blob(options.emptyEncoding ? [] : ['mock-encoding']) }); this.emit('stop'); }); }
  }
  const doc = new Events(); doc.visibilityState = 'visible'; doc.createElement = name => { assert.equal(name, 'canvas'); return new Canvas(); }; env.document = doc;
  const replacements = { document: doc, MediaRecorder: Recorder, requestAnimationFrame: fn => after(() => { video.advance(); fn(0); }), cancelAnimationFrame: cancel };
  if (options.clockFactor) { const original = globalThis.performance; replacements.performance = { now: () => original.now() * options.clockFactor }; }
  for (const [key, value] of Object.entries(replacements)) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  const renderOverlay = (ctx, play, t) => { ctx.overlayTime = t; env.rendered.push({ t, pixelTime: ctx.pixelTime, calibration: play.calibration?.id, metric: play.metrics.xfg_pct?.value ?? null, outcome: play.outcome }); };
  env.renderOverlay = renderOverlay;
  try { return await run(env); }
  finally {
    for (const timer of [...env.timers]) cancel(timer);
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

test('edit plan supports independently trimmed repeat possessions in continuous output order', () => {
  const { plan, project } = fixture(); assert.equal(validateStoryPlan(plan, project), true);
});

test('edit plan rejects invalid boundaries, unreviewed material and invented output gaps', () => {
  for (const change of [p => p.clips[0].start = -.1, p => p.clips[0].end = Infinity, p => p.clips[1].outputStart += .1, p => p.duration += 1, p => p.clips[0].playId = 'missing']) {
    const { plan, project } = fixture(); change(plan); assert.throws(() => validateStoryPlan(plan, project));
  }
  const { plan, project } = fixture(); project.plays[0].reviewed = false; assert.throws(() => validateStoryPlan(plan, project), { code: 'UNREVIEWED_CLIP' });
});

test('recording budget is based on the complete repeated film, capped at 180 seconds', () => {
  const { project } = fixture(); project.plays[0].end = 200;
  assert.equal(validateStoryPlan({ clips: [{ playId: 'p01', start: 0, end: 180, outputStart: 0, outputEnd: 180 }], duration: 180 }, project), true);
  assert.throws(() => validateStoryPlan({ clips: [{ playId: 'p01', start: 0, end: 181, outputStart: 0, outputEnd: 181 }], duration: 181 }, project), { code: 'PLAN_LIMIT' });
});

test('per-frame playback view conservatively hides future/missing availability metrics and results', () => {
  const { project } = fixture(), play = project.plays[0]; play.metrics.gravity = { value: 8, semantics: 'supplied_metric' };
  const early = storyPlayAt(play, .8, project), reveal = storyPlayAt(play, 1, project);
  assert.equal(early.metrics.xfg_pct.value, null); assert.equal(early.metrics.gravity.value, null); assert.equal(early.outcome, 'unknown');
  assert.equal(reveal.metrics.xfg_pct.value, .42); assert.equal(reveal.outcome, 'made'); assert.equal(play.metrics.gravity.value, 8);
});

test('live-state calibration callbacks cannot replace the reviewed recording snapshot', () => {
  const { project } = fixture(); const view = storyPlayAt(project.plays[0], .5, project, p => ({ ...p, calibration: { id: 'changed-live' } }));
  assert.equal(view.calibration.id, 'reviewed-snapshot');
  assert.equal(storyPlayAt(project.plays[0], 2, project, p => ({ ...p, calibration: { id: 'changed-live' } })).calibration, null);
});

test('caption wrapping bounds line count and treats source newlines as readable text', () => {
  const ctx = { measureText: text => ({ width: text.length * 10 }) };
  assert.deepEqual(wrapStoryCaption(ctx, 'AB\nCD', 30, 3), ['AB ', 'CD']); assert.equal(wrapStoryCaption(ctx, 'long text '.repeat(1000), 30, 3).length, 3);
});

test('decoded export aligns overlay to actual submitted video frame, not the later playback clock', async () => {
  await browser({}, async env => {
    const film = await recordStory({ ...fixture(), video: env.video, renderOverlay: env.renderOverlay });
    assert.ok(film.blob.size > 0); assert.equal(film.frameClock, 'decoded-media-time'); assert.equal(film.captureMode, 'manual-frame-request');
    assert.equal(film.clips.length, 3); assert.equal(film.audioIncluded, false); assert.equal(film.durationBasis, 'playlist-plan');
    assert.equal(env.canvases.length, 1); assert.ok(env.rendered.every(frame => frame.t === frame.pixelTime)); assert.ok(env.captured.every(frame => frame.pixelTime === frame.overlayTime));
    assert.deepEqual(env.locatingWhileRecording, []); assert.ok(film.clips.every(clip => clip.firstFrameTime >= clip.requestedStart && clip.lastFrameTime < clip.requestedEnd));
    assert.equal(env.video.paused, true); assert.equal(env.video.playbackRate, .5); assert.equal(env.video.frameIds.size, 0); assert.equal(env.video.listenerCount, 0); assert.equal(env.document.listenerCount, 0);
    assert.ok(env.streams.every(stream => stream.track.stopped > 0)); assert.equal(env.recorders[0].listenerCount, 0);
  });
});

test('frames that decode just before a requested trim are never written into the film', async () => {
  await browser({ seekOffset: -.02 }, async env => {
    const film = await recordStory({ ...fixture([[.8, 1.08]]), video: env.video, renderOverlay: env.renderOverlay });
    assert.ok(film.clips[0].firstFrameTime >= .8); assert.ok(env.rendered.every(frame => frame.t >= .8 && frame.t < 1.08));
  });
});

test('recording clones source media interpretation, captions and layers before progress callbacks can mutate the editor', async () => {
  await browser({}, async env => {
    const input = fixture([[.8, 1.2]]); const layers = { labels: true };
    const film = await recordStory({ ...input, layers, video: env.video, renderOverlay: env.renderOverlay, viewPlay: p => ({ ...p, calibration: input.project.calibrations[0] }), onProgress: () => { input.project.calibrations[0].id = 'changed-live'; input.narrations.p01.cues[0].text = 'Changed after export'; layers.labels = false; } });
    assert.ok(film.blob.size); assert.ok(env.rendered.every(row => row.calibration === 'reviewed-snapshot')); assert.ok(!env.textDraws.some(row => row.text === 'Changed after export'));
    assert.ok(env.rendered.filter(row => row.t < 1).every(row => row.metric === null && row.outcome === 'unknown'));
    assert.ok(env.textDraws.filter(row => row.text === 'Result after source reveal').every(row => row.t >= 1));
  });
});

test('future result and metric cues reject export before constructing any encoder', async () => {
  await browser({}, async env => {
    for (const evidenceIds of [['p01:outcome'], ['p01:metric:difficulty']]) {
      const input = fixture(); input.narrations.p01.cues = [{ start: .7, end: .9, text: 'Future', evidenceIds }];
      await assert.rejects(recordStory({ ...input, video: env.video }), /不能早于/);
    }
    assert.equal(env.recorders.length, 0);
  });
});

test('RAF fallback explicitly reports approximate synchronization without claiming decoded frame precision', async () => {
  await browser({ raf: true }, async env => {
    const film = await recordStory({ ...fixture([[0, .16]]), video: env.video });
    assert.equal(film.frameClock, 'raf-approximate'); assert.ok(film.warnings.some(text => text.includes('近似同步')));
  });
});

test('missing requestFrame uses an explicitly identified 30 fps canvas stream and closes the discarded stream', async () => {
  await browser({ noRequestFrame: true }, async env => {
    const film = await recordStory({ ...fixture([[0, .16]]), video: env.video });
    assert.equal(film.captureMode, 'automatic-30fps'); assert.deepEqual(env.streams.map(s => s.rate), [0, 30]); assert.ok(env.streams.every(s => s.track.stopped > 0));
  });
});

test('encoder constructor failure retains the real error and stops the acquired capture stream', async () => {
  await browser({ constructorReject: true }, async env => {
    await assert.rejects(recordStory({ ...fixture(), video: env.video }), { code: 'ENCODER_CONSTRUCTION_FAILED' });
    assert.equal(env.streams[0].track.stopped, 1); assert.equal(env.video.frameIds.size, 0); assert.equal(env.video.listenerCount, 0);
  });
});

test('playback rejection cancels pending video-frame callbacks and discards partial encoder bytes', async () => {
  await browser({ playReject: true }, async env => {
    await assert.rejects(recordStory({ ...fixture(), video: env.video }), { code: 'VIDEO_PLAY_FAILED' });
    assert.equal(env.video.frameIds.size, 0); assert.equal(env.video.listenerCount, 0);
    // Fresh-frame priming detects denied playback before capture resources are acquired.
    assert.equal(env.recorders.length, 0); assert.equal(env.streams.length, 0);
  });
});

test('encoder error interrupts playback promptly, cancels all scheduling and cannot return a film', async () => {
  await browser({ encoderError: true }, async env => {
    await assert.rejects(recordStory({ ...fixture([[0, 2]]), video: env.video }), { code: 'ENCODER_FAILED' });
    assert.equal(env.video.frameIds.size, 0); assert.equal(env.video.paused, true); assert.equal(env.video.listenerCount, 0); assert.equal(env.streams[0].track.stopped, 1);
  });
});

test('cancellation after recording starts returns no partial output and leaves no active scheduling', async () => {
  await browser({}, async env => {
    let cancelled = false;
    await assert.rejects(recordStory({ ...fixture([[0, 2]]), video: env.video, shouldCancel: () => cancelled, onProgress: info => { if (info.sourceTime > .04) cancelled = true; } }), { code: 'CANCELLED' });
    assert.equal(env.video.frameIds.size, 0); assert.equal(env.recorder.state, 'inactive'); assert.equal(env.video.listenerCount, 0);
  });
});

test('backgrounding the page immediately terminates recording without returning a partial Blob', async () => {
  await browser({}, async env => {
    await assert.rejects(recordStory({ ...fixture([[0, 2]]), video: env.video, onProgress: info => { if (info.sourceTime > .04) { env.document.visibilityState = 'hidden'; env.document.emit('visibilitychange'); } } }), { code: 'NOT_FOREGROUND' });
    assert.equal(env.video.frameIds.size, 0); assert.equal(env.video.listenerCount, 0); assert.equal(env.document.listenerCount, 0);
  });
});

test('non-advancing decoded frames hit a bounded stall deadline and close the recorder', async () => {
  await browser({ stalled: true, clockFactor: 100 }, async env => {
    await assert.rejects(recordStory({ ...fixture([[0, 2]]), video: env.video }), { code: 'VIDEO_STALLED' });
    assert.equal(env.video.frameIds.size, 0); assert.equal(env.streams[0].track.stopped, 1);
  });
});

test('global wall deadline is independent of media progression and stops endless recording', async () => {
  await browser({ stalled: true, clockFactor: 1000 }, async env => {
    await assert.rejects(recordStory({ ...fixture([[0, 2]]), video: env.video }), { code: 'EXPORT_TIMEOUT' });
    assert.equal(env.video.frameIds.size, 0); assert.equal(env.streams[0].track.stopped, 1);
  });
});

test('empty encoded data is a failure even after the browser reported a stop event', async () => {
  await browser({ emptyEncoding: true }, async env => {
    await assert.rejects(recordStory({ ...fixture([[0, .12]]), video: env.video }), { code: 'EMPTY_ENCODING' });
    assert.equal(env.video.listenerCount, 0); assert.equal(env.streams[0].track.stopped, 1);
  });
});

test('seek timeout removes stale seek listeners as well as the compositor callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  await browser({ seekNever: true }, async env => {
    const pending = recordStory({ ...fixture([[.8, 1]]), video: env.video });
    const rejected = assert.rejects(pending, { code: 'SEEK_TIMEOUT' });
    await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(EXPORT_LIMITS.seekMs + 1); await rejected;
    assert.equal(env.video.listenerCount, 0); assert.equal(env.video.frameIds.size, 0); assert.equal(env.recorders.length, 0);
  });
});

test('metadata readiness timeout releases all source and page listeners without constructing an encoder', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  await browser({ readyNever: true }, async env => {
    const pending = recordStory({ ...fixture(), video: env.video });
    const rejected = assert.rejects(pending, { code: 'VIDEO_READY_TIMEOUT' });
    t.mock.timers.tick(EXPORT_LIMITS.readyMs + 1); await rejected;
    assert.equal(env.video.listenerCount, 0); assert.equal(env.document.listenerCount, 0); assert.equal(env.recorders.length, 0);
  });
});

test('a recorder that never acknowledges start hits its transition deadline and closes its acquired stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  await browser({ startNever: true }, async env => {
    const pending = recordStory({ ...fixture([[.8, 1]]), video: env.video });
    const rejected = assert.rejects(pending, { code: 'ENCODER_TIMEOUT' });
    for (let i = 0; i < 12; i++) { t.mock.timers.tick(5); await Promise.resolve(); await Promise.resolve(); }
    t.mock.timers.tick(EXPORT_LIMITS.transitionMs + 1); await rejected;
    assert.equal(env.recorder.state, 'inactive'); assert.equal(env.recorder.listenerCount, 0); assert.equal(env.streams[0].track.stopped, 1);
  });
});

test('an encoder that never completes file writing hits its finalisation deadline without leaking stop listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  await browser({ stopNever: true }, async env => {
    const pending = recordStory({ ...fixture([[.8, .88]]), video: env.video });
    const rejected = assert.rejects(pending, { code: 'ENCODER_FINALISE_TIMEOUT' });
    for (let i = 0; i < 25; i++) { t.mock.timers.tick(5); await Promise.resolve(); await Promise.resolve(); }
    t.mock.timers.tick(EXPORT_LIMITS.finaliseMs + 1); await rejected;
    assert.equal(env.recorder.listenerCount, 0); assert.equal(env.video.listenerCount, 0); assert.equal(env.streams[0].track.stopped, 1);
  });
});
