import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {filmFilename, localArtifactLink} from '../pro/delivery.mjs';

// Exercise the production function and its real click handler. Browser/media
// edges are controlled here; the export/cancel implementation is never copied.
const source = readFileSync(new URL('../pro/app.mjs', import.meta.url), 'utf8');
const exportStart = source.indexOf('async function exportVideo(){');
const clickStart = source.indexOf("document.addEventListener('click',async event=>{");
const clickEnd = source.indexOf("\ndocument.addEventListener('submit',", clickStart);
assert.ok(exportStart >= 0 && clickStart > exportStart && clickEnd > clickStart,
  'Production export function/click handler boundaries must remain discoverable');
const productionCode = source.slice(exportStart, clickStart) + source.slice(clickStart, clickEnd);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function harness({voice = true, local = false, holdAt = null, ignoreAbort = false,
                  saveError = false, previous = true} = {}) {
  const signals = new Map(), pending = deferred(), requests = [], readers = [];
  const created = [], revoked = [], notices = [], handlers = new Map();
  const controls = [
    {tag: 'button', disabled: false}, {tag: 'button', disabled: true},
    {tag: 'input', disabled: false}, {tag: 'input', disabled: true},
    {tag: 'textarea', disabled: false}, {tag: 'select', disabled: true},
  ];
  const originalDisabled = controls.map(el => el.disabled);
  const p = {id: 'p01', start: 12, reviewed: true, reviewSignature: 'reviewed'};
  const oldFilm = previous ? {url: 'blob:previous', filename: 'previous.webm', sourceRevision: 6} : undefined;
  const oldReport = previous ? {sourceRevision: 6, marker: 'previous report'} : undefined;
  const state = {
    project: {id: 'project', name: '回归测试', revision: 7, provenance: {kind: 'synthetic'}, plays: [p]},
    narrations: {}, layers: {}, voiceSelected: voice, localServer: local,
    lastFilm: oldFilm, lastExport: oldReport, preview: null,
  };
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {hidden: true, style: {}, textContent: ''});
    return nodes.get(selector);
  }
  function signal(stage, value) {
    if (!signals.has(stage)) signals.set(stage, deferred());
    signals.get(stage).resolve(value);
  }
  function until(stage) {
    if (!signals.has(stage)) signals.set(stage, deferred());
    return signals.get(stage).promise;
  }
  const abortError = () => Object.assign(new Error('mock transport aborted'), {name: 'AbortError'});
  function held(stage, value, abortSignal) {
    signal(stage, value);
    if (stage !== holdAt) return Promise.resolve(value);
    if (abortSignal && !ignoreAbort) {
      if (abortSignal.aborted) pending.reject(abortError());
      else abortSignal.addEventListener('abort', () => pending.reject(abortError()), {once: true});
    }
    return pending.promise.then(() => value);
  }
  class Reader {
    readAsDataURL() {
      this.index = readers.push(this);
      signal(`encode:${this.index}`, this);
      if (holdAt !== `encode:${this.index}`) queueMicrotask(() => this.finish());
    }
    finish() {
      if (this.aborted) return;
      this.result = 'data:video/webm;base64,ZmFrZQ==';
      this.onload?.();
    }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  const artifact = {url: `/api/arena/artifacts/${'a'.repeat(32)}/video`, bytes: 5, sha256: 'b'.repeat(64)};
  const context = vm.createContext({
    state, Blob, AbortController, FileReader: Reader, setTimeout, clearTimeout, crypto: webcrypto,
    CSS: {escape: value => value}, $: node,
    $$: selector => controls.filter(el => selector.split(',').some(part => part.trim().split(':')[0] === el.tag)),
    play: () => p, stopPlayback() {}, reviewSignature: () => 'reviewed',
    playlistPlan: () => ({clips: [{playId: p.id}], cues: [], duration: 1}),
    // Reviewed-plan validation is tested in the StoryPlan suite and browser
    // workflow; this harness controls that boundary to exercise cancellation.
    reviewedStoryPlan: async () => ({planHash: 'c'.repeat(64), contentHash: 'd'.repeat(64), inputHash: 'e'.repeat(64), review: {status: 'approved'}, inputSnapshot:{project:state.project}, cues:[],layers:{}}),
    storyTimeMap: () => ({clips: [{playId: p.id}], cues: [], duration: 1}),
    sourceBadge: () => 'synthetic', renderOverlay() {}, viewPlay() {},
    recordStory: options => held('record', {blob: new Blob(['silent']), frameCount: 25}, null),
    render() {}, format: String, toast: text => notices.push(text),
    filmFilename, localArtifactLink,
    document: {addEventListener: (event, handler) => handlers.set(event, handler)},
    URL: {
      createObjectURL() { const url = `blob:new-${created.length + 1}`; created.push(url); return url; },
      revokeObjectURL: url => revoked.push(url),
    },
    fetch: async (url, options) => {
      const kind = url.endsWith('/narrate') ? 'narrate' : 'save';
      assert.ok(kind === 'narrate' || url === '/api/arena/export-video');
      requests.push({url, ...options});
      const response = {
        ok: !(kind === 'save' && saveError),
        headers: {get: () => JSON.stringify({provider: 'test-voice'})},
        blob: () => held(`body:${kind}`, new Blob(['voice']), null),
        json: () => held(`body:${kind}`, saveError ? {error: 'fixture storage unavailable'} : artifact, null),
      };
      return held(`fetch:${kind}`, response, options.signal);
    },
  });
  vm.runInContext(productionCode, context, {filename: 'production-export-and-click-handler.mjs'});
  return {
    state, controls, originalDisabled, oldFilm, oldReport, created, revoked, notices,
    requests, readers, artifact, until, release: () => pending.resolve(),
    start: () => context.exportVideo().then(value => ({value}), error => ({error})),
    cancel: () => handlers.get('click')({target: {closest: () => ({disabled: false, dataset: {action: 'cancel-export'}})}}),
    assertRestored() {
      assert.deepEqual(controls.map(el => el.disabled), originalDisabled);
      assert.equal(state.exporting, false);
      assert.equal(state.exportController, null);
      assert.equal(state.time, p.start);
    },
    assertUnpublished() {
      assert.equal(state.lastFilm, oldFilm, 'a cancelled attempt must preserve the previous film');
      assert.equal(state.lastExport, oldReport, 'a cancelled attempt must preserve the previous report');
      assert.ok(!revoked.includes('blob:previous'), 'the previous downloadable blob must stay live');
      assert.equal(notices.length, 0, 'cancellation must not announce a successful or fallback film');
      assert.deepEqual(revoked, created, 'all newly allocated URLs must be released after cancellation');
    },
  };
}

for (const kind of ['narrate', 'save']) {
  test(`actual cancel click aborts pending ${kind} fetch without replacing an existing film`, {timeout: 2000}, async () => {
    const h = harness({voice: true, local: kind === 'save', holdAt: `fetch:${kind}`});
    const operation = h.start();
    await h.until(`fetch:${kind}`);
    assert.ok(h.controls.every(el => el.disabled));
    await h.cancel();
    assert.equal(h.requests.at(-1).signal.aborted, true, 'the request must receive the cancellation signal');
    const {error} = await operation;
    assert.equal(error?.name, 'AbortError');
    h.assertUnpublished(); h.assertRestored();
  });

  test(`late successful ${kind} response cannot publish after cancellation`, {timeout: 2000}, async () => {
    const h = harness({voice: true, local: kind === 'save', holdAt: `fetch:${kind}`, ignoreAbort: true});
    const operation = h.start();
    await h.until(`fetch:${kind}`);
    await h.cancel();
    h.release();
    assert.equal((await operation).error?.name, 'AbortError');
    h.assertUnpublished(); h.assertRestored();
  });

  test(`cancel during ${kind} response-body decoding cannot publish`, {timeout: 2000}, async () => {
    const h = harness({voice: true, local: kind === 'save', holdAt: `body:${kind}`});
    const operation = h.start();
    await h.until(`body:${kind}`);
    await h.cancel();
    h.release();
    assert.equal((await operation).error?.name, 'AbortError');
    h.assertUnpublished(); h.assertRestored();
  });
}

for (const voice of [true, false]) {
  test(`cancel aborts the FileReader before ${voice ? 'narration' : 'saving'} begins`, {timeout: 2000}, async () => {
    const h = harness({voice, local: !voice, holdAt: 'encode:1', previous: false});
    const operation = h.start();
    const reader = await h.until('encode:1');
    await h.cancel();
    assert.equal(reader.aborted, true);
    assert.equal((await operation).error?.name, 'AbortError');
    assert.equal(h.requests.length, 0);
    h.assertUnpublished(); h.assertRestored();
  });
}

test('cancel after the recorder starts prevents every later delivery stage', {timeout: 2000}, async () => {
  const h = harness({voice: true, local: true, holdAt: 'record'});
  const operation = h.start();
  await h.until('record');
  await h.cancel();
  h.release();
  assert.equal((await operation).error?.name, 'AbortError');
  assert.equal(h.requests.length, 0);
  h.assertUnpublished(); h.assertRestored();
});

test('successful voice plus storage commits once and retires only obsolete blobs', {timeout: 2000}, async () => {
  const h = harness({voice: true, local: true});
  assert.equal((await h.start()).error, undefined);
  assert.deepEqual(h.requests.map(r => r.url), ['/api/arena/narrate', '/api/arena/export-video']);
  assert.equal(h.requests[0].signal, h.requests[1].signal, 'one cancellation signal spans post-processing');
  assert.equal(h.state.lastFilm.url, h.artifact.url);
  assert.equal(h.state.lastFilm.audio, true);
  assert.equal(h.state.lastExport.sourceRevision, 7);
  assert.equal(h.state.lastExport.delivery.sha256, h.artifact.sha256);
  assert.deepEqual(h.revoked, ['blob:new-1', 'blob:previous']);
  h.assertRestored();
});

test('ordinary storage failure still delivers a recoverable blob and restores controls', {timeout: 2000}, async () => {
  const h = harness({voice: false, local: true, saveError: true});
  assert.equal((await h.start()).error, undefined);
  assert.equal(h.state.lastFilm.url, 'blob:new-1');
  assert.equal(h.state.lastExport.delivery, undefined);
  assert.match(h.notices[0], /fixture storage unavailable/);
  assert.match(h.notices[0], /立即下载/);
  assert.deepEqual(h.revoked, ['blob:previous']);
  h.assertRestored();
});
