'use strict';

// Run from any directory with: node --test path/to/tests/tracking.test.cjs
// These tests execute the actual browser renderer in a small DOM-like harness.
// The source fixture is the project's synthetic demo, not real NBA observations.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const appPath = path.join(projectRoot, 'web', 'app.js');
const app = fs.readFileSync(appPath, 'utf8');
const demo = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'demo.json'), 'utf8'));
const rendererStart = app.indexOf('  function renderOverlay(');
const rendererEnd = app.indexOf('  function updateCaptions(', rendererStart);
const cameraStart = app.indexOf('  function currentCamera(');
assert(rendererStart >= 0, 'Cannot locate the real renderOverlay function in app.js');
assert(rendererEnd > rendererStart, 'Cannot locate the end of the real renderOverlay function');
assert(cameraStart >= 0 && cameraStart < rendererStart, 'Cannot locate the real currentCamera helper');
const actualSource = app.slice(cameraStart, rendererEnd);
const template = demo.possessions.find(p => p.id === 'p01');
assert(template, 'The demo fixture must contain possession p01');
assert.equal(template.start, 0, 'These regression times require p01 to start at 0 seconds');
assert.equal(template.end, 12, 'These regression times require p01 to end at 12 seconds');
assert(template.tracks.some(f => f.t === 0.5), 'The demo fixture must contain a sample at 0.5 seconds');
assert(template.tracks.some(f => f.t === template.end), 'The demo fixture must retain its terminal sample');
const clone = value => JSON.parse(JSON.stringify(value));

function element(tag, attrs = {}, text) {
  return {
    tag, attrs, text, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute(name, value) { this.attrs[name] = value; }
  };
}

function harness() {
  const root = element('svg');
  const notice = { hidden: true };
  const possession = clone(template);
  const state = { dataset: clone(demo), synchronized: true, overlay: true };
  const context = {
    state,
    $: id => {
      if (id === 'video-overlay') return root;
      if (id === 'calibration-note') return notice;
      throw new Error(`Unexpected DOM dependency in renderOverlay: ${id}`);
    },
    rawPossession: () => possession,
    svgEl: element
  };
  vm.createContext(context);
  vm.runInContext(actualSource, context, { filename: appPath });
  assert.equal(typeof context.renderOverlay, 'function', 'The actual renderer must be executable');
  assert.equal(typeof context.currentCamera, 'function', 'The actual camera helper must be executable');
  return {
    root, notice, possession, state,
    render(t) { context.renderOverlay(t); return root.children; },
    hasPlayer(id) { return root.children.some(n => n.tag === 'text' && n.text === id); },
    ballCount() { return root.children.filter(n => n.tag === 'circle').length; }
  };
}

function removePlayer(frame, id) {
  assert(frame.players.some(p => p.id === id), `Fault fixture requires player ${id}`);
  frame.players = frame.players.filter(p => p.id !== id);
}

function sample(h, t) {
  const frame = h.possession.tracks.find(f => f.t === t);
  assert(frame, `Demo fixture requires a sample at ${t}`);
  return frame;
}

test('演练 fixture 的有效双样本区间显示 H3', () => {
  const h = harness();
  h.render(0.25);
  assert(h.hasPlayer('H3'), 'A player observed in both bracketing samples should be visible');
});

test('首样本前 0.5 秒隐藏全部叠加，不保持未来样本', () => {
  const h = harness();
  h.possession.tracks = h.possession.tracks.filter(f => f.t >= 0.5);
  h.render(0);
  assert.equal(h.root.children.length, 0, 'No overlay may extrapolate before the first sample');
});

test('末样本后 0.4 秒隐藏全部叠加，不保持过去样本', () => {
  const h = harness();
  h.possession.tracks = h.possession.tracks.filter(f => f.t <= 10);
  h.render(10.4);
  assert.equal(h.root.children.length, 0, 'No overlay may extrapolate after the last sample');
});

test('下一帧缺少 H3 时，区间内不显示 H3', () => {
  const h = harness();
  removePlayer(sample(h, 0.5), 'H3');
  h.render(0.25);
  assert(!h.hasPlayer('H3'), 'A disappearing player must not be held through the interval');
  assert(h.hasPlayer('H1'), 'Other players observed in both samples should remain visible');
});

test('上一帧缺少 H3 时，直到真实样本时刻才显示 H3', () => {
  const h = harness();
  removePlayer(sample(h, 0), 'H3');
  h.render(0.25);
  assert(!h.hasPlayer('H3'), 'A newly appearing player must not appear before its sample');
  h.render(0.5);
  assert(h.hasPlayer('H3'), 'A player at its exact observed sample should be visible');
});

test('恰好在有效样本时刻时，保留该样本中的 H3', () => {
  const h = harness();
  removePlayer(sample(h, 0.5), 'H3');
  h.render(0);
  assert(h.hasPlayer('H3'), 'An exact observation does not require a later observation');
});

test('防御性缺球输入在区间内不显示球', () => {
  // API validation currently rejects null ball coordinates. This deliberately
  // malformed in-memory case checks the renderer's own defensive behavior.
  const h = harness();
  sample(h, 0.5).ball = null;
  h.render(0.25);
  assert.equal(h.ballCount(), 0, 'The next sample must contain the ball');
  const previousMissing = harness();
  sample(previousMissing, 0).ball = null;
  previousMissing.render(0.25);
  assert.equal(previousMissing.ballCount(), 0, 'The previous sample must also contain the ball');
});

test('超过 1 秒的缺口隐藏，准确样本时刻仍可显示', () => {
  const h = harness();
  h.possession.tracks = h.possession.tracks.filter(f => f.t === 0 || f.t === 2);
  h.render(1);
  assert.equal(h.root.children.length, 0, 'A two-second gap must not be interpolated');
  h.render(2);
  assert(h.hasPlayer('H3'), 'The endpoint itself remains an actual observation');
});

test('内部切镜边界不向前镜头借用下一镜头的样本', () => {
  const h = harness();
  h.possession.camera_segments = [
    { start: 0, end: 1, calibrated: true },
    { start: 1, end: 12, calibrated: true }
  ];
  h.render(0.75);
  assert.equal(h.root.children.length, 0, 'The sample at 1 belongs to the second camera');
  h.render(1.25);
  assert(h.hasPlayer('H3'), 'Interpolation inside the second camera should work');
});

test('p.end 终端样本可关闭最后镜头区间，但回合结束时停止叠加', () => {
  // validation.number uses inclusive min/max and tracks.t is checked against
  // [p.start, p.end]. core.engine.nearest_track also allows this exact terminal
  // endpoint. This exception never applies to an internal camera cut.
  const h = harness();
  assert.equal(h.possession.tracks.at(-1).t, h.possession.end);
  h.render(11.75);
  assert(h.hasPlayer('H3'), 'The actual sample at p.end may close the final interpolation interval');
  h.render(h.possession.end);
  assert.equal(h.root.children.length, 0, 'The active possession interval itself is half-open');
});

test('未校准镜头清空叠加，并显示校准提示', () => {
  const h = harness();
  h.possession.camera_segments[0].calibrated = false;
  h.render(0.25);
  assert.equal(h.root.children.length, 0, 'Uncalibrated cameras must have no spatial overlay');
  assert.equal(h.notice.hidden, false, 'A matching but uncalibrated camera should explain the suppression');
});

test('媒体未配对时清除旧叠加，也不显示镜头校准提示', () => {
  const h = harness();
  h.state.synchronized = false;
  h.possession.camera_segments[0].calibrated = false;
  h.root.append(element('text', {}, 'stale'));
  h.render(0.25);
  assert.equal(h.root.children.length, 0, 'Unsynchronized media must clear even stale overlay nodes');
  assert.equal(h.notice.hidden, true, 'Calibration status is not meaningful before media pairing');
});

test('900×1600 数据保持 viewBox、球员与注释坐标的尺寸比例', () => {
  const h = harness();
  h.state.dataset.video.width = 900;
  h.state.dataset.video.height = 1600;
  h.render(0.25);
  assert.equal(h.root.attrs.viewBox, '0 0 900 1600', 'The source dimensions must define the SVG coordinate system');
  const label = h.root.children.find(n => n.tag === 'text' && n.text === 'H3');
  assert(label, 'Expected H3 label to validate normalized coordinates');
  const a = sample(h, 0).players.find(p => p.id === 'H3');
  const b = sample(h, 0.5).players.find(p => p.id === 'H3');
  assert(Math.abs(label.attrs.x - (a.x + b.x) / 2 * 900) < 1e-9, 'Interpolated x must use dataset width');
  assert(Math.abs(label.attrs.y - ((a.y + b.y) / 2 * 1600 - 20)) < 1e-9, 'Interpolated y must use dataset height');
  h.render(8.5);
  const zone = h.possession.annotations.find(a => a.kind === 'zone' && 8.5 >= a.start && 8.5 < a.end);
  assert(zone && zone.points.length > 2, 'The fixture must include a polygon zone at 8.5 seconds');
  const polygon = h.root.children.find(n => n.tag === 'polygon');
  assert(polygon, 'Expected the actual timed zone to be drawn');
  assert.equal(polygon.attrs.points, zone.points.map(([x, y]) => `${x * 900},${y * 1600}`).join(' '), 'Annotation geometry must use the same dataset dimensions');
});
