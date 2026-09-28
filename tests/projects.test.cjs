'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const logic = require('../web/projects.js');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/demo.json'), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));

test('未知指标的空白保持 null，不伪造为 0', () => {
  for (const value of ['', ' ', null, undefined]) assert.equal(logic.nullableNumber(value, '指标'), null);
});
test('实际零值与空白可区分', () => {
  assert.equal(logic.nullableNumber('0', '概率', 0, 1), 0);
  assert.equal(logic.nullableNumber('0.000', '概率', 0, 1), 0);
});
test('拒绝 NaN、无穷、非十进制与混杂输入', () => {
  for (const value of ['NaN', 'Infinity', '1e9999', '0xFF', '2abc', '1,2', 'false']) assert.throws(() => logic.nullableNumber(value, '指标'));
});
test('接受有限小数、科学计数与负 Gravity', () => {
  assert.equal(logic.nullableNumber('.35', '概率', 0, 1), .35);
  assert.equal(logic.nullableNumber('2.5e-1', '概率', 0, 1), .25);
  assert.equal(logic.nullableNumber('-2.8', 'Gravity'), -2.8);
});
test('概率限制保留 0 和 1 边界，拒绝越界', () => {
  assert.equal(logic.nullableNumber('1', '概率', 0, 1), 1);
  for (const value of ['-0.01', '1.01']) assert.throws(() => logic.nullableNumber(value, '概率', 0, 1));
});
test('必填数值与名称拒绝空输入和过长名称', () => {
  assert.throws(() => logic.requiredNumber('', '出手时间'));
  assert.throws(() => logic.requiredText(' ', '项目名称'));
  assert.throws(() => logic.requiredText('四个汉字', '项目名称', 3));
  assert.equal(logic.requiredText('  正常名称  ', '项目名称'), '正常名称');
});
test('完整覆盖时不凭空创建重叠回合', () => {
  assert.equal(logic.nextInterval({ video: { duration: 20 }, possessions: [{ start: 0, end: 20 }] }), null);
});
test('新增回合使用首个真实空档，并最多占用 12 秒', () => {
  assert.deepEqual(logic.nextInterval({ video: { duration: 50 }, possessions: [{ start: 0, end: 5 }, { start: 30, end: 50 }] }), { start: 5, end: 17 });
  assert.deepEqual(logic.nextInterval({ video: { duration: 25 }, possessions: [{ start: 5, end: 20 }] }), { start: 0, end: 5 });
});
test('空档查找可处理无序输入，且不修改原数组', () => {
  const dataset = { video: { duration: 50 }, possessions: [{ start: 20, end: 50 }, { start: 0, end: 10 }] }, before = copy(dataset);
  assert.deepEqual(logic.nextInterval(dataset), { start: 10, end: 20 });
  assert.deepEqual(dataset, before);
});
test('未改时间的真实回合深拷贝保留轨迹、标注及校准', () => {
  const p = fixture.possessions[0], out = logic.cropPossession(p, p.start, p.end);
  assert.deepEqual(out, p); assert.notEqual(out, p); assert.notEqual(out.tracks, p.tracks);
});
test('缩短真实回合只保留区间内样本，不外推坐标', () => {
  const p = fixture.possessions[0], start = p.start + 1, end = p.end - 1, before = copy(p), out = logic.cropPossession(p, start, end);
  assert.deepEqual(out.tracks, p.tracks.filter(sample => sample.t >= start && sample.t <= end));
  assert(out.tracks.every(sample => sample.t >= start && sample.t <= end));
  assert.deepEqual(p, before);
});
test('裁切标注保留证据来源，移除完全区间外的几何', () => {
  const p = { start: 0, end: 10, tracks: [], camera_segments: [{ start: 0, end: 10, calibrated: true }], annotations: [
    { id: 'manual-a', origin: 'manual', author_note: '视频第 4 秒人工记录', start: 1, end: 6, points: [[.1, .2], [.3, .4]], evidence_id: 'manual-e' },
    { id: 'outside', start: 8, end: 10 },
  ] };
  const out = logic.cropPossession(p, 3, 7);
  assert.equal(out.annotations.length, 1); assert.equal(out.annotations[0].start, 3); assert.equal(out.annotations[0].end, 6);
  assert.equal(out.annotations[0].author_note, p.annotations[0].author_note); assert.equal(out.annotations[0].evidence_id, 'manual-e');
});
test('时间变化撤销镜头校准，并裁到新区间', () => {
  const p = { start: 0, end: 10, tracks: [], annotations: [], camera_segments: [{ start: 0, end: 5, calibrated: true }, { start: 5, end: 10, calibrated: true }] };
  assert.deepEqual(logic.cropPossession(p, 3, 8).camera_segments, [{ start: 3, end: 5, calibrated: false }, { start: 5, end: 8, calibrated: false }]);
});
test('空镜头区间建立明确未校准段，不自动通过', () => {
  const p = { start: 0, end: 5, tracks: [], annotations: [], camera_segments: [{ start: 0, end: 2, calibrated: true }] };
  assert.deepEqual(logic.cropPossession(p, 3, 5).camera_segments, [{ start: 3, end: 5, calibrated: false }]);
});
test('完整真实 fixture 的复核内容不被无关限制拒绝', () => {
  assert.equal(logic.reviewProblem(copy(fixture)), '');
});
test('占位球员与 0 分字段不能通过复核', () => {
  for (const patch of [{ shooter: '待标注' }, { shooter: '请填写真实球员' }, { points: 0 }]) {
    const data = copy(fixture); Object.assign(data.possessions[0], patch); assert.match(logic.reviewProblem(data), /占位/);
  }
});
test('缺失来源或仍为占位的证据不能通过复核', () => {
  const data = copy(fixture); data.provenance.source = ' '; assert.match(logic.reviewProblem(data), /来源/);
  data.provenance.source = '本地录像'; data.possessions[0].source_refs = []; assert.match(logic.reviewProblem(data), /证据来源/);
  data.possessions[0].source_refs = ['人工标注尚未完成']; assert.match(logic.reviewProblem(data), /证据来源/);
});
test('出手终点不属于可播放回合，复核必须拒绝', () => {
  const data = copy(fixture); data.possessions[0].shot_time = data.possessions[0].end;
  assert.match(logic.reviewProblem(data), /早于结束时间/);
});
test('未知指标仍能保留，在来源完整时不要求捏造数字', () => {
  const data = copy(fixture); data.possessions.forEach(p => { p.metrics = { xfg_pct: null, gravity: null, leverage: null }; });
  assert.equal(logic.reviewProblem(data), '');
});
test('时间与文件大小展示边界', () => {
  assert.equal(logic.clockTime(0), '00:00'); assert.equal(logic.clockTime(3661.9), '01:01:01');
  assert.equal(logic.byteSize(0), '0 B'); assert.equal(logic.byteSize(1024 ** 2), '1.0 MB');
});
test('内置演练创建保留全部合成来源、轨迹、媒体指纹与注释', () => {
  const out = logic.demoDraft(fixture);
  assert.deepEqual(out.provenance, fixture.provenance);
  assert.deepEqual(out.possessions, fixture.possessions);
  assert.deepEqual(out.video, fixture.video);
  assert.equal(out.workflow.state, 'draft');
  assert.notEqual(out, fixture); assert.notEqual(out.possessions, fixture.possessions);
});
test('演练即使带旧复核状态，新项目也必须恢复待复核且不改变输入', () => {
  const input = copy(fixture); input.workflow = { state: 'reviewed' };
  const before = copy(input), out = logic.demoDraft(input);
  assert.equal(out.workflow.state, 'draft'); assert.deepEqual(input, before);
});
test('缺失合成身份的数据不能从演练入口冒充内置演练', () => {
  for (const input of [null, {}, { ...copy(fixture), provenance: { kind: 'official' } }, { ...copy(fixture), video: null }]) assert.throws(() => logic.demoDraft(input), /合成标识/);
});
test('导出默认保持字幕版，无配音能力也可使用', () => {
  assert.equal(logic.exportVoice(false, { tts_available: false }), false);
  assert.equal(logic.exportVoice(false, undefined), false);
  assert.equal(logic.exportVoice(undefined, { tts_available: true }), false);
});
test('仅明确勾选且已检测本机能力才提交配音', () => {
  assert.equal(logic.exportVoice(true, { tts_available: true }), true);
  for (const capabilities of [undefined, {}, { tts_available: false }, { tts_available: 'true' }]) assert.throws(() => logic.exportVoice(true, capabilities), /本次配音任务未提交/);
});
