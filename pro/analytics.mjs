/**
 * CourtLens Pro evidence kernel.
 *
 * This module performs inspectable calculations on supplied records. It does
 * not detect players in video, estimate vendor metrics, or establish causes.
 * All times in its public results are absolute video seconds. Relative cue
 * times are additional export conveniences, never a second interpretation of t.
 */
import { selectMetricRecords, selectBoundMetric, metricTransforms, metricRecordEvidence, formatScopedMetric, metricHistory } from './metrics-v2.mjs';

export const ANALYTICS_VERSION = '4.0.0';
export const ANALYTICS_LIMITS = Object.freeze({
  plays: 2000, framesPerPlay: 10000, totalFrames: 300000,
  playersPerFrame: 20, queryCharacters: 1200, playSeconds: 600,
});

export class AnalysisError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'AnalysisError';
    this.details = details;
  }
}

const FT_PER_M = 3.280839895013123;
const WEIGHTS = Object.freeze({ leverage: 50, difficulty: 25, gravity: 15, opportunity: 10 });
const MAKE_PROBABILITY = new Set(['shot_make_probability', 'official_xfg', 'xfg_probability']);
const DIFFICULTY = new Set(['shot_difficulty', 'shot_difficulty_probability']);
const LEVERAGE = new Set(['possession_win_probability_opportunity']);
const METRIC_KEYS = Object.freeze({
  difficulty: ['difficulty', 'xfg', 'xfg_pct', 'shotDifficulty'],
  gravity: ['gravity'], leverage: ['leverage'],
});
const METRIC_LABELS = Object.freeze({ difficulty: '出手难度', gravity: '球员引力', leverage: '回合胜率机会差' });

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, places = 3) => finite(value) ? Number(value.toFixed(places)) : null;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const cleanText = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : '';
const own = (object, key) => object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
const unique = values => [...new Set(values)];
const sourceKind = kind => ['official', 'measured', 'model', 'derived', 'synthetic', 'schematic', 'manual', 'unverified'].includes(kind) ? kind : 'unverified';
const derivedKind = kind => ['synthetic', 'schematic'].includes(kind) ? 'schematic-derived' : 'derived';
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const playerKey = player => `${player.team}\u0000${player.id}`;
const samePlayers = (a, b) => a.length === b.length && a.every(p => b.some(q => playerKey(p) === playerKey(q)));
// An explicit canonical null stays unknown; an alias only fills an absent field.
const eventTimeOf = (play, canonical, alias) => {
  const value = own(play, canonical) ? play[canonical] : play[alias];
  return finite(value) ? value : null;
};
const shotTimeOf = play => eventTimeOf(play, 'shotTime', 'shot_time');
const resultTimeOf = play => eventTimeOf(play, 'resultTime', 'result_time');
const teamOf = play => cleanText(play.team || play.offense, 80);
const playerOf = play => cleanText(play.playerId || play.player || play.shooter, 120);

function inspectPlay(play) {
  const errors = [];
  if (!play || typeof play !== 'object' || Array.isArray(play)) return ['回合必须是对象。'];
  if (typeof play.id !== 'string' || !play.id.trim() || play.id.length > 120) errors.push('回合 id 必须是 1–120 字符。');
  if (!finite(play.start) || play.start < 0) errors.push('start 必须是非负有限秒数。');
  if (!finite(play.end) || play.end <= play.start || play.end - play.start > ANALYTICS_LIMITS.playSeconds) errors.push('end 必须晚于 start，回合长度不能超过 600 秒。');
  for (const key of ['shotTime', 'shot_time', 'resultTime', 'result_time']) {
    if (own(play, key) && play[key] !== null && (!finite(play[key]) || play[key] < play.start || play[key] > play.end)) errors.push(`${key} 必须在回合视频时间内。`);
  }
  if (finite(shotTimeOf(play)) && finite(resultTimeOf(play)) && resultTimeOf(play) < shotTimeOf(play)) errors.push('结果揭晓时间不能早于出手时间。');
  if (play.tracks !== undefined && !Array.isArray(play.tracks)) errors.push('tracks 必须是数组。');
  if (Array.isArray(play.tracks) && play.tracks.length > ANALYTICS_LIMITS.framesPerPlay) errors.push('单回合轨迹超过 10000 帧，请先按时间重采样。');
  return errors;
}

function inspectPlays(plays) {
  if (!Array.isArray(plays) || plays.length > ANALYTICS_LIMITS.plays) throw new AnalysisError('回合列表无效或超过 2000 条。');
  const ids = new Set();
  let frames = 0;
  for (const play of plays) {
    const errors = inspectPlay(play);
    if (errors.length) throw new AnalysisError(`回合 ${cleanText(play?.id) || '(无 id)'} 校验失败。`, errors);
    if (ids.has(play.id)) throw new AnalysisError(`回合 id 重复：${play.id}`);
    ids.add(play.id);
    frames += play.tracks?.length || 0;
  }
  if (frames > ANALYTICS_LIMITS.totalFrames) throw new AnalysisError('总轨迹超过 300000 帧，请分场分析或重采样。');
}

function metricRecord(play, canonical, asOf, warnings) {
  if (Array.isArray(play.metricRecords)) {
    const { record, reason } = selectBoundMetric(play, canonical, asOf);
    if (!record) return { key: canonical, inputField: `metricBindings.${canonical}`, label: METRIC_LABELS[canonical], value: null, normalized: null, available: false,
      availableAt: null, semantics: '', unit: '来源单位', definition: '', kind: 'unverified', source: 'v2 字典绑定', range: null, higherIs: '',
      evidenceId: `${play.id}:metric:${canonical}`, transformed: false, signature: null, reason, adapterVersion: 2 };
    const transformed = metricTransforms(record);
    if (transformed.normalized === null && record.available) warnings.push(`${record.label} 保留来源单位和 ${record.scope.granularity} 粒度；未声明兼容的编辑转换，未参与排序。`);
    return { ...record, ...transformed, key: canonical, inputField: `metricRecords.${record.id}`, available: record.available,
      value: record.available ? record.value : null, kind: sourceKind(record.provenance.kind), source: record.provenance.source,
      range: record.range ?? null, higherIs: record.higherIs || '', reason: reason || (transformed.normalized === null ? 'unrankable-semantics' : null), adapterVersion: 2 };
  }
  const key = METRIC_KEYS[canonical].find(candidate => own(play.metrics, candidate));
  const valueIn = key ? play.metrics[key] : null;
  const record = valueIn && typeof valueIn === 'object' && !Array.isArray(valueIn) ? valueIn : { value: valueIn };
  const semantics = cleanText(record.semantics || play.metricSemantics?.[key] || play.metric_semantics?.[key], 160);
  const provenance = record.provenance || play.metricProvenance?.[key] || play.provenance || {};
  const kind = sourceKind(typeof provenance === 'string' ? provenance : provenance.kind);
  const source = cleanText(record.source || provenance.source || provenance.label || '输入记录；来源真实性未独立核验', 320);
  const unit = cleanText(record.unit || play.metricUnits?.[key], 80);
  const definition = cleanText(record.definition || play.metricDefinitions?.[key] || play.metric_definitions?.[key], 800);
  const suppliedTime = finite(record.availableAt) ? record.availableAt : finite(record.time) ? record.time : finite(record.t) ? record.t : null;
  const availableAt = suppliedTime ?? play.end;
  const value = finite(record.value) ? record.value : null;
  const range = Array.isArray(record.range) && record.range.length === 2 && record.range.every(finite) && record.range[1] > record.range[0] && finite(record.range[1] - record.range[0]) ? [...record.range] : null;
  const evidenceId = `${play.id}:metric:${canonical}`;
  const result = {
    key: canonical, inputField: key ? `metrics.${key}` : `metrics.${canonical}`,
    label: METRIC_LABELS[canonical], value: null, normalized: null, available: false,
    availableAt, semantics, unit: unit || '输入单位', definition, kind, source, range,
    higherIs: cleanText(record.higherIs, 40).trim(),
    evidenceId, transformed: false, signature: null, reason: null,
  };
  if (canonical === 'leverage' && !LEVERAGE.has(semantics)) result.label = 'Leverage（来源指标）';
  if (canonical === 'difficulty' && !DIFFICULTY.has(semantics) && !MAKE_PROBABILITY.has(semantics)) result.label = `${key || 'Difficulty'}（来源指标）`;
  if (suppliedTime !== null && suppliedTime < 0) {
    result.availableAt = null;
    result.reason = 'invalid-availability-time';
    warnings.push(`${METRIC_LABELS[canonical]} 的可用时间无效，未参与前视分析。`);
    return result;
  }
  if (availableAt > asOf) {
    result.reason = 'future';
    return result;
  }
  if (value === null) {
    result.reason = valueIn === null || valueIn === undefined || record.value === null ? 'missing' : 'invalid-number';
    if (result.reason === 'invalid-number') warnings.push(`${METRIC_LABELS[canonical]} 不是有限数字，已保留为缺失。`);
    return result;
  }
  if (suppliedTime === null) warnings.push(`${METRIC_LABELS[canonical]} 缺少 availableAt，保守隐藏到回合结束；这不是实测计算时刻。`);
  if (range && (value < range[0] || value > range[1])) {
    result.reason = 'outside-declared-range';
    warnings.push(`${METRIC_LABELS[canonical]} 超出声明范围，未参与排序。`);
    return result;
  }
  if (((canonical === 'difficulty' && (MAKE_PROBABILITY.has(semantics) || DIFFICULTY.has(semantics))) || (canonical === 'leverage' && LEVERAGE.has(semantics))) && (value < 0 || value > 1)) {
    result.reason = 'outside-semantic-range';
    warnings.push(`${METRIC_LABELS[canonical]} 的概率或难度口径要求 0–1；没有依据将输入自动除以 100。`);
    return result;
  }
  result.value = value;
  result.available = true;
  if (canonical === 'difficulty' && MAKE_PROBABILITY.has(semantics) && value >= 0 && value <= 1) {
    result.normalized = 1 - value;
    result.transformed = true;
    result.signature = 'complement:shot_make_probability';
    result.label = '预期命中概率';
    result.unit = unit || 'probability';
    result.definition ||= '输入单次出手预期命中概率；编辑难度由 1−概率计算，不保证结果。';
  } else if (canonical === 'difficulty' && DIFFICULTY.has(semantics) && value >= 0 && value <= 1) {
    result.normalized = value;
    result.signature = `difficulty:${semantics}:${unit || '0–1'}`;
  } else if (canonical === 'leverage' && LEVERAGE.has(semantics) && value >= 0 && value <= 1) {
    result.normalized = value;
    result.signature = 'possession_win_probability_opportunity';
    result.unit = unit || 'probability';
  } else if (canonical === 'gravity' && semantics === 'supplied_metric' && range && record.higherIs === 'more' && unit.trim() && definition.trim()) {
    result.normalized = (value - range[0]) / (range[1] - range[0]);
    result.signature = `gravity:${unit || 'unspecified'}:${range.join(',')}:${definition || 'undefined'}`;
  }
  if (result.normalized === null) {
    result.reason = 'unrankable-semantics';
    warnings.push(`${METRIC_LABELS[canonical]} 保留输入读数；没有兼容的定义或尺度，未参与统一排序。`);
  }
  return result;
}

function trackingConfig(play, warnings) {
  const config = play.tracking && typeof play.tracking === 'object' ? play.tracking : {};
  const kind = sourceKind(config.kind || config.provenance?.kind || play.provenance?.kind);
  const units = config.units;
  const system = config.coordinateSystem;
  const court = config.court || {};
  let scaleX = null;
  let scaleY = null;
  if (system === 'court' && units === 'ft') scaleX = scaleY = 1;
  if (system === 'court' && units === 'm') scaleX = scaleY = FT_PER_M;
  if (system === 'court' && units === 'normalized' && finite(court.length) && finite(court.width) && court.length > 0 && court.width > 0 && ['ft', 'm'].includes(court.units)) {
    const factor = court.units === 'm' ? FT_PER_M : 1;
    scaleX = court.width * factor;
    scaleY = court.length * factor;
  }
  if (scaleX !== null && (!finite(scaleX) || !finite(scaleY) || scaleX > 1000 || scaleY > 1000)) scaleX = scaleY = null;
  const maxGap = finite(config.maxGap) && config.maxGap > 0 && config.maxGap <= 2 ? config.maxGap : 1;
  const expected = Number.isInteger(config.expectedPlayersPerTeam) && config.expectedPlayersPerTeam > 0 && config.expectedPlayersPerTeam <= 10 ? config.expectedPlayersPerTeam : 5;
  const thresholds = config.thresholds || {};
  const openDistanceFt = finite(thresholds.openDistanceFt) && thresholds.openDistanceFt > 0 && thresholds.openDistanceFt <= 30 ? thresholds.openDistanceFt : 6;
  const passLaneFt = finite(thresholds.passLaneFt) && thresholds.passLaneFt > 0 && thresholds.passLaneFt <= 10 ? thresholds.passLaneFt : 2;
  const minWindowSec = finite(thresholds.minWindowSec) && thresholds.minWindowSec > 0 && thresholds.minWindowSec <= 10 ? thresholds.minWindowSec : 0.3;
  const geometric = scaleX !== null && scaleY !== null;
  if (play.tracks?.length && !geometric) warnings.push('轨迹没有明确的球场坐标系与物理单位；不把屏幕距离换算成防守距离。');
  if (geometric && ['synthetic', 'schematic'].includes(kind)) warnings.push('球场轨迹为示意演练；所有空间计算仅说明功能，不对应真实 NBA 球员位置。');
  if (geometric && kind === 'unverified') warnings.push('轨迹来源未经核验；几何计算只描述所输入的坐标。');
  return { kind, units, system, scaleX, scaleY, geometric, maxGap, expected, openDistanceFt, passLaneFt, minWindowSec,
    timeBase: config.timeBase === 'possession' ? 'possession' : 'video',
    source: cleanText(config.source || config.provenance?.source || '输入球场轨迹', 320) };
}

function readFrames(play, config, asOf, warnings) {
  if (!config.geometric) return { frames: [], droppedFrames: 0, futureFrames: 0 };
  const frames = [];
  let droppedFrames = 0;
  let futureFrames = 0;
  const seenTimes = new Set();
  for (const raw of play.tracks || []) {
    const t = finite(raw?.t) ? raw.t + (config.timeBase === 'possession' ? play.start : 0) : null;
    if (t === null || t < play.start || t > play.end || !Array.isArray(raw.players) || raw.players.length > ANALYTICS_LIMITS.playersPerFrame || seenTimes.has(t)) {
      droppedFrames++;
      continue;
    }
    seenTimes.add(t);
    if (t > asOf) { futureFrames++; continue; }
    const players = [];
    const identities = new Set();
    let bad = false;
    for (const player of raw.players) {
      if (!player || typeof player.id !== 'string' || !player.id || player.id.length > 120 || typeof player.team !== 'string' || !player.team || player.team.length > 80 || !finite(player.x) || !finite(player.y) || Math.abs(player.x) > 1000 || Math.abs(player.y) > 1000) { bad = true; break; }
      if (config.units === 'normalized' && (player.x < 0 || player.x > 1 || player.y < 0 || player.y > 1)) { bad = true; break; }
      const key = playerKey(player);
      if (identities.has(key)) { bad = true; break; }
      identities.add(key);
      players.push({ id: player.id, name: cleanText(player.name || player.id, 120), team: player.team, x: player.x * config.scaleX, y: player.y * config.scaleY });
    }
    if (bad) { droppedFrames++; continue; }
    let ball = null;
    if (raw.ball && finite(raw.ball.x) && finite(raw.ball.y) && Math.abs(raw.ball.x) <= 1000 && Math.abs(raw.ball.y) <= 1000) {
      if (config.units !== 'normalized' || (raw.ball.x >= 0 && raw.ball.x <= 1 && raw.ball.y >= 0 && raw.ball.y <= 1)) ball = { x: raw.ball.x * config.scaleX, y: raw.ball.y * config.scaleY };
    }
    frames.push({ t, players, ball, segmentId: cleanText(raw.segmentId || raw.cameraSegment, 120) });
  }
  frames.sort((a, b) => a.t - b.t);
  if (droppedFrames) warnings.push(`丢弃 ${droppedFrames} 帧无效、重复或越界轨迹；未用零坐标补齐。`);
  return { frames, droppedFrames, futureFrames };
}

function hull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const point of sorted) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop(); lower.push(point); }
  const upper = [];
  for (const point of sorted.toReversed ? sorted.toReversed() : [...sorted].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop(); upper.push(point); }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
}

function area(players) {
  if (players.length < 3) return null;
  const polygon = hull(players);
  return Math.abs(polygon.reduce((sum, p, index) => {
    const q = polygon[(index + 1) % polygon.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
}

function pairSpacing(players) {
  if (players.length < 2) return null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) { sum += distance(players[i], players[j]); count++; }
  return sum / count;
}

function nearest(player, defenders) {
  if (!player || !defenders.length) return null;
  const record = defenders.map(defender => ({ id: defender.id, name: defender.name, team: defender.team, distanceFt: distance(player, defender) })).sort((a, b) => a.distanceFt - b.distanceFt || a.id.localeCompare(b.id))[0];
  return record;
}

function connected(a, b, config) {
  return b.t > a.t && b.t - a.t <= config.maxGap && a.segmentId === b.segmentId;
}

function samplesFrom(frames, play, config) {
  const team = teamOf(play);
  const shooterId = playerOf(play);
  return frames.map(frame => {
    const offense = frame.players.filter(player => player.team === team);
    const defenders = frame.players.filter(player => player.team !== team);
    const shooter = offense.find(player => player.id === shooterId || player.name === shooterId) || null;
    const defendersComplete = defenders.length === config.expected && unique(defenders.map(player => player.team)).length === 1;
    const offenseComplete = offense.length === config.expected;
    const openPlayers = offense.map(player => ({ id: player.id, name: player.name, nearestDefender: nearest(player, defenders) }));
    return {
      t: frame.t, segmentId: frame.segmentId,
      offense, defenders, ball: frame.ball, shooter,
      shooterDefenderDistanceFt: round(nearest(shooter, defenders)?.distanceFt),
      offenseSpacingFt: round(pairSpacing(offense)), offenseAreaFt2: round(area(offense)), defenseAreaFt2: round(area(defenders)),
      defendersComplete, offenseComplete, openPlayers,
      meanDefenderBallDistanceFt: frame.ball && defenders.length ? round(defenders.reduce((sum, player) => sum + distance(player, frame.ball), 0) / defenders.length) : null,
      kind: derivedKind(config.kind),
    };
  });
}

function opportunityWindows(samples, play, config, evidence) {
  const open = new Map();
  const windows = [];
  let sequence = 0;
  const finish = key => {
    const interval = open.get(key);
    open.delete(key);
    if (!interval || interval.end - interval.start < config.minWindowSec || interval.sampleCount < 2) return;
    const ordinal = sequence++;
    const record = { ...interval, duration: round(interval.end - interval.start), minDistanceFt: round(interval.minDistanceFt), firstConfirmedDistanceFt: round(interval.firstConfirmedDistanceFt), maxGap: round(interval.maxGap), timingUncertaintySec: round(interval.maxGap / 2),
      thresholdFt: config.openDistanceFt, kind: derivedKind(config.kind), evidenceId: `${play.id}:window:${interval.playerId}:${ordinal}`, firstEvidenceId: `${play.id}:window-first:${interval.playerId}:${ordinal}` };
    windows.push(record);
    evidence.push({ id: record.firstEvidenceId, playId: play.id, t: record.firstConfirmedAt, field: 'tracks.players.nearest-observed-defender',
      value: { playerId: record.playerId, distanceFt: record.firstConfirmedDistanceFt, thresholdFt: record.thresholdFt },
      kind: record.kind, unit: 'ft', source: config.source,
      definition: '时间窗内的第二个有效位置样本；只说明这一帧的近防距离，不使用后来样本声称空位已经持续了整个时间窗。' });
    evidence.push({ id: record.evidenceId, playId: play.id, t: record.end, start: record.start, end: record.end, field: 'tracks.players',
      value: { playerId: record.playerId, duration: record.duration, minDistanceFt: record.minDistanceFt, thresholdFt: record.thresholdFt, sampleCount: record.sampleCount, maxGap: record.maxGap },
      kind: record.kind, unit: 'ft / seconds', source: config.source,
      definition: `在 ${record.sampleCount} 个已记录样本中，该球员与最近防守者的距离均不小于 ${config.openDistanceFt} ft。时间窗是离散采样描述，间隙内未确认持续空位；不证明有可完成的传球。` });
  };
  let previous = null;
  for (const sample of samples) {
    if (!sample.defendersComplete || !previous || !connected(previous, sample, config) || !samePlayers(previous.defenders, sample.defenders)) for (const key of [...open.keys()]) finish(key);
    const current = new Set();
    if (sample.defendersComplete) for (const player of sample.openPlayers) {
      if (!player.nearestDefender || player.nearestDefender.distanceFt < config.openDistanceFt) continue;
      const key = player.id;
      current.add(key);
      if (!open.has(key)) open.set(key, { playerId: player.id, playerName: player.name, start: sample.t, end: sample.t, minDistanceFt: player.nearestDefender.distanceFt, sampleCount: 1, maxGap: 0, firstConfirmedAt: null, firstConfirmedDistanceFt: null });
      else {
        const record = open.get(key);
        if (record.sampleCount === 1) { record.firstConfirmedAt = sample.t; record.firstConfirmedDistanceFt = player.nearestDefender.distanceFt; }
        record.maxGap = Math.max(record.maxGap, sample.t - record.end);
        record.end = sample.t;
        record.minDistanceFt = Math.min(record.minDistanceFt, player.nearestDefender.distanceFt);
        record.sampleCount++;
      }
    }
    for (const key of [...open.keys()]) if (!current.has(key)) finish(key);
    previous = sample;
  }
  for (const key of [...open.keys()]) finish(key);
  return windows.sort((a, b) => a.start - b.start || a.playerId.localeCompare(b.playerId));
}

function contractions(samples, play, config, evidence) {
  const result = [];
  for (let index = 1; index < samples.length; index++) {
    const a = samples[index - 1];
    const b = samples[index];
    const areaA = area(a.defenders);
    const areaB = area(b.defenders);
    if (!connected(a, b, config) || !a.defendersComplete || !b.defendersComplete || !samePlayers(a.defenders, b.defenders) || areaA === null || areaB === null || areaA <= 0) continue;
    const change = (areaB - areaA) / areaA;
    if (change > -0.1) continue;
    const record = { start: a.t, end: b.t, areaStartFt2: a.defenseAreaFt2, areaEndFt2: b.defenseAreaFt2, areaChangePct: round(change * 100), kind: derivedKind(config.kind), evidenceId: `${play.id}:contraction:${result.length}` };
    result.push(record);
    evidence.push({ id: record.evidenceId, playId: play.id, t: b.t, start: a.t, end: b.t, field: 'tracks.players.defensive-convex-hull', value: record.areaChangePct,
      kind: record.kind, unit: '%', source: config.source,
      definition: '相同已记录防守球员的凸包面积在相邻有效样本间缩小至少 10%。只描述阵形覆盖面积变化，不推断协防原因、质量或反应迟缓。' });
  }
  return result;
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return distance(point, a);
  const ratio = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
  return distance(point, { x: a.x + ratio * dx, y: a.y + ratio * dy });
}

function shotContext(samples, play, config, asOf, evidence) {
  const shotTime = shotTimeOf(play);
  if (!finite(shotTime) || shotTime > asOf) return { context: null, alternatives: [] };
  const tolerance = Math.min(config.maxGap / 2, 0.5);
  const sample = samples.filter(frame => frame.shooter && Math.abs(frame.t - shotTime) <= tolerance).sort((a, b) => Math.abs(a.t - shotTime) - Math.abs(b.t - shotTime) || a.t - b.t)[0];
  if (!sample) return { context: null, alternatives: [] };
  const nearestDefender = nearest(sample.shooter, sample.defenders);
  const context = { t: sample.t, shotTime, timeOffsetSec: round(sample.t - shotTime), shooter: { ...sample.shooter }, nearestDefender,
    defendersComplete: sample.defendersComplete, offenseSpacingFt: sample.offenseSpacingFt, offenseAreaFt2: sample.offenseAreaFt2,
    kind: derivedKind(config.kind), evidenceId: `${play.id}:shot-context` };
  evidence.push({ id: context.evidenceId, playId: play.id, t: sample.t, field: 'tracks.players.shot-context', value: { nearestDefender, offenseSpacingFt: context.offenseSpacingFt, sampleOffsetSec: context.timeOffsetSec, defendersComplete: context.defendersComplete },
    kind: context.kind, unit: 'ft', source: config.source,
    definition: '出手时刻附近最近输入样本的几何关系；未跨缺口插值。不完整防守名单只能得到已记录防守者距离，不代表实际最近防守者。' });
  const alternatives = sample.offense.filter(player => player.id !== sample.shooter.id).map(player => {
    const receiving = nearest(player, sample.defenders);
    const lane = sample.defenders.length ? Math.min(...sample.defenders.map(defender => pointSegmentDistance(defender, sample.shooter, player))) : null;
    return { playerId: player.id, playerName: player.name, from: { x: sample.shooter.x, y: sample.shooter.y }, to: { x: player.x, y: player.y },
      t: sample.t, passDistanceFt: round(distance(sample.shooter, player)), laneClearanceFt: round(lane), receivingDefenderDistanceFt: receiving?.distanceFt ?? null,
      descriptiveCandidate: sample.defendersComplete && lane !== null && lane >= config.passLaneFt && receiving && receiving.distanceFt >= config.openDistanceFt,
      defendersComplete: sample.defendersComplete, kind: derivedKind(config.kind), evidenceId: `${play.id}:alternative:${player.id}` };
  }).sort((a, b) => Number(b.descriptiveCandidate) - Number(a.descriptiveCandidate) || (b.receivingDefenderDistanceFt ?? -1) - (a.receivingDefenderDistanceFt ?? -1) || a.playerId.localeCompare(b.playerId));
  for (const alternative of alternatives) evidence.push({ id: alternative.evidenceId, playId: play.id, t: sample.t, field: 'tracks.players.pass-segment',
    value: { playerId: alternative.playerId, passDistanceFt: alternative.passDistanceFt, laneClearanceFt: alternative.laneClearanceFt, receivingDefenderDistanceFt: alternative.receivingDefenderDistanceFt },
    kind: alternative.kind, unit: 'ft', source: config.source,
    definition: `连接出手球员与队友的静态直线，计算已记录防守者到线段的最短距离。${config.passLaneFt} ft 为自定义几何阈值。没有球速、朝向、反应及后续运动，不能预测传球成功或替代选择的得分收益。` });
  return { context, alternatives };
}

function movement(samples, config) {
  const result = new Map();
  for (let index = 1; index < samples.length; index++) {
    const a = samples[index - 1];
    const b = samples[index];
    if (!connected(a, b, config)) continue;
    for (const player of [...b.offense, ...b.defenders]) {
      const before = [...a.offense, ...a.defenders].find(candidate => playerKey(candidate) === playerKey(player));
      if (!before) continue;
      const length = distance(before, player);
      const seconds = b.t - a.t;
      const key = playerKey(player);
      if (!result.has(key)) result.set(key, { playerId: player.id, playerName: player.name, team: player.team, pathLengthFt: 0, observedSeconds: 0, peakSegmentSpeedFtPerSec: 0, kind: derivedKind(config.kind) });
      const record = result.get(key);
      record.pathLengthFt += length;
      record.observedSeconds += seconds;
      record.peakSegmentSpeedFtPerSec = Math.max(record.peakSegmentSpeedFtPerSec, length / seconds);
    }
  }
  return [...result.values()].map(record => ({ ...record, pathLengthFt: round(record.pathLengthFt), observedSeconds: round(record.observedSeconds), peakSegmentSpeedFtPerSec: round(record.peakSegmentSpeedFtPerSec),
    definition: '仅对相邻有效采样位置求折线路径与区间平均速度，不等于高频瞬时速度；缺口不累计。' }));
}

function makeRank(metrics, windows) {
  const longestWindow = windows.reduce((maximum, window) => Math.max(maximum, window.duration), 0);
  const components = Object.keys(WEIGHTS).map(key => {
    const normalized = key === 'opportunity' ? windows.length ? Math.min(longestWindow / 5, 1) : null : metrics[key].normalized;
    const evidenceIds = key === 'opportunity' ? windows.filter(window => window.duration === longestWindow).slice(0, 1).map(window => window.evidenceId) : [metrics[key].evidenceId];
    return { key, label: key === 'opportunity' ? '采样空间窗' : METRIC_LABELS[key], weight: WEIGHTS[key], normalized,
      points: normalized === null ? null : round(normalized * WEIGHTS[key]), evidenceIds,
      signature: key === 'opportunity' ? windows.length ? `sampled-space-window:${windows[0].thresholdFt}ft` : null : metrics[key].signature,
      reason: normalized === null ? key === 'opportunity' ? '未确认空间窗；不能把未检出当作零空位。' : metrics[key].reason : null };
  });
  return rankFromComponents(components);
}

function rankFromComponents(components) {
  const availableWeight = components.reduce((sum, component) => sum + (component.normalized === null ? 0 : component.weight), 0);
  const observedPoints = components.reduce((sum, component) => sum + (component.points ?? 0), 0);
  return { score: availableWeight ? round(observedPoints / availableWeight * 100, 2) : null,
    priorityScore: availableWeight ? round(observedPoints, 2) : null,
    scoreInterval: availableWeight ? [round(observedPoints, 2), round(observedPoints + 100 - availableWeight, 2)] : [0, 100],
    coverage: availableWeight / 100, availableWeight, components,
    formula: '编辑权重：机会差 50、难度 25、可比引力 15、采样空间窗 10。score 为已知项权重内的描述分；priorityScore 使用区间下界保守排序，缺失读数仍为 null，不作为零测量。',
    label: '编辑回看优先级；非官方关键度、胜率或模型准确率',
  };
}

function rankEvidence(playId, t, rank) {
  return { id: `${playId}:rank`, playId, t, field: 'editorial-ranking', kind: 'derived', unit: 'editorial-points', source: '公开确定性公式，输入结果不参与计算', available: rank.priorityScore !== null,
    value: { score: rank.score, priorityScore: rank.priorityScore, scoreInterval: [...rank.scoreInterval], coverage: rank.coverage, components: rank.components.map(component => ({ key: component.key, weight: component.weight, normalized: component.normalized, points: component.points, evidenceIds: component.evidenceIds })) },
    definition: `${rank.formula} ${rank.label}` };
}

/** Analyze one normalized possession. asOf is an absolute video timestamp. */
export function analyzePossession(play, options = {}) {
  const errors = inspectPlay(play);
  if (errors.length) throw new AnalysisError('回合校验失败。', errors);
  if (own(options, 'asOf') && (!finite(options.asOf) || options.asOf < 0)) throw new AnalysisError('asOf 必须是非负有限的视频绝对秒数。');
  const asOf = own(options, 'asOf') ? Math.min(options.asOf, play.end) : play.end;
  const retrospective = !own(options, 'asOf');
  const warnings = [];
  if (shotTimeOf(play) === null) warnings.push('出手时间未提供；不生成出手采样或同步出手解说。');
  const metrics = Object.fromEntries(Object.keys(METRIC_KEYS).map(key => [key, metricRecord(play, key, asOf, warnings)]));
  const evidence = Object.values(metrics).map(metric => ({ id: metric.evidenceId, playId: play.id, t: metric.availableAt,
    field: metric.inputField, value: metric.value, kind: metric.kind, unit: metric.unit, source: metric.source, definition: metric.definition || '来源未提供完整定义；不能替代其他指标。',
    available: metric.available, reason: metric.reason, semantics: metric.semantics, normalizedForEditorialRanking: metric.normalized }));
  const scoped = selectMetricRecords(play, { asOf });
  const scopedMetrics = scoped.selected;
  const metricTimeline = metricHistory(play, { asOf });
  for (const record of metricTimeline) {
    const item = metricRecordEvidence(play.id, record);
    const index = evidence.findIndex(entry => entry.id === item.id);
    if (index >= 0) evidence[index] = { ...evidence[index], ...item };
    else evidence.push(item);
  }
  evidence.push({ id: `${play.id}:event`, playId: play.id, t: play.start, field: 'team/player/shotValue',
    value: asOf >= play.start ? { team: teamOf(play), player: playerOf(play), shotValue: [2, 3].includes(play.shotValue || play.points) ? play.shotValue || play.points : null } : null,
    kind: sourceKind(play.provenance?.kind), unit: 'event', source: cleanText(play.provenance?.source || '输入事件记录', 320), available: asOf >= play.start,
    definition: '输入事件记录；当前模块没有从视频识别出球员身份或出手分值。' });
  const config = trackingConfig(play, warnings);
  const { frames, droppedFrames, futureFrames } = readFrames(play, config, asOf, warnings);
  const samples = samplesFrom(frames, play, config);
  const windows = opportunityWindows(samples, play, config, evidence);
  const contraction = contractions(samples, play, config, evidence);
  const shot = shotContext(samples, play, config, asOf, evidence);
  const inputOutcome = ['made', 'missed'].includes(play.outcome || play.result) ? play.outcome || play.result : 'unknown';
  const resultTime = resultTimeOf(play);
  const resultAvailable = inputOutcome !== 'unknown' && ((resultTime !== null && asOf >= resultTime) || (retrospective && resultTime === null));
  const outcome = { value: resultAvailable ? inputOutcome : 'unknown', available: resultAvailable, availableAt: resultTime,
    evidenceId: `${play.id}:outcome`, reason: inputOutcome === 'unknown' ? 'missing' : resultTime === null && !retrospective ? 'missing-result-time' : resultAvailable ? null : 'future' };
  evidence.push({ id: outcome.evidenceId, playId: play.id, t: resultTime, field: 'outcome', value: outcome.value,
    kind: sourceKind(play.provenance?.kind), source: cleanText(play.provenance?.source || '输入结果记录', 320), unit: 'event', available: resultAvailable,
    definition: resultTime === null ? '缺少结果揭晓时间；只允许赛后总结读输入结果，不生成结果同步字幕。' : '输入结果仅从独立的 resultTime 起揭晓，结果不参与关键回合排序。' });
  if (inputOutcome !== 'unknown' && resultTime === null) warnings.push('结果记录缺少揭晓时间；回放解说不提前宣布命中或未中。');
  if (samples.some(sample => !sample.defendersComplete)) warnings.push('部分轨迹样本缺少完整防守名单；这些样本不生成空位时间窗。');
  if (samples.some((sample, index) => index && !connected(samples[index - 1], sample, config))) warnings.push('轨迹有时间缺口或镜头边界；未跨边界计算持续空间窗、位移或阵形变化。');
  const rank = makeRank(metrics, windows);
  evidence.push(rankEvidence(play.id, asOf, rank));
  const metricsAvailable = Object.values(metrics).filter(metric => metric.available).length;
  const eligibleFrames = (play.tracks || []).filter(frame => finite(frame?.t) && frame.t + (config.timeBase === 'possession' ? play.start : 0) <= asOf).length;
  const coveredSeconds = samples.reduce((sum, sample, index) => sum + (index && connected(samples[index - 1], sample, config) ? sample.t - samples[index - 1].t : 0), 0);
  const sampledDuration = Math.max(0, asOf - play.start);
  return {
    version: ANALYTICS_VERSION, playId: play.id, availableAt: asOf, start: play.start, end: play.end,
    shotTime: shotTimeOf(play), team: teamOf(play), player: playerOf(play), outcome, metrics, scopedMetrics,
    metricContext: scopedMetrics.filter(record => record.contextOnly), metricAvailability: scoped.unavailable, metricHistory: metricTimeline,
    coverage: { metrics: { available: metricsAvailable, total: 3, ratio: metricsAvailable / 3, rankable: Object.values(metrics).filter(metric => metric.normalized !== null).length },
      tracking: { validFrames: frames.length, totalFrames: play.tracks?.length || 0, eligibleFrames, futureFrames, ratio: eligibleFrames ? frames.length / eligibleFrames : 0,
        coveredSeconds: round(coveredSeconds), temporalRatio: sampledDuration ? clamp(coveredSeconds / sampledDuration, 0, 1) : 0, kind: config.kind, geometric: config.geometric,
        completeDefensiveFrames: samples.filter(sample => sample.defendersComplete).length, timeBase: 'video' } },
    temporal: { samples, opportunityWindows: windows, contraction, movement: movement(samples, config), thresholds: { openDistanceFt: config.openDistanceFt, passLaneFt: config.passLaneFt, minWindowSec: config.minWindowSec, maxGap: config.maxGap } },
    tactical: { shotContext: shot.context, alternatives: shot.alternatives, interpretation: '坐标描述，不是替代选择的预测或战术因果。' },
    rank, evidence, warnings: unique(warnings), validation: { ok: true, errors: [], droppedFrames },
  };
}

/** Rank by a conservative, disclosed editorial interval; never by outcome. */
export function rankPossessions(plays, options = {}) {
  inspectPlays(plays);
  if (own(options, 'asOf') && (!finite(options.asOf) || options.asOf < 0)) throw new AnalysisError('asOf 必须是非负有限的视频绝对秒数。');
  const rows = plays.map(play => ({ id: play.id, playId: play.id, title: cleanText(play.title || `${teamOf(play)} · ${playerOf(play)}`, 240), analysis: analyzePossession(play, own(options, 'asOf') ? { asOf: options.asOf } : {}) }));
  const incompatible = [];
  for (const key of Object.keys(WEIGHTS)) {
    const signatures = unique(rows.map(row => {
      const signature = row.analysis.rank.components.find(component => component.key === key)?.signature;
      const kind = key === 'opportunity' ? row.analysis.coverage.tracking.kind : row.analysis.metrics[key].kind;
      return signature ? `${['synthetic', 'schematic'].includes(kind) ? 'schematic' : 'source-record'}:${signature}` : null;
    }).filter(Boolean));
    if (signatures.length > 1) incompatible.push(key);
  }
  for (const row of rows) {
    const components = row.analysis.rank.components.map(component => incompatible.includes(component.key) ? { ...component, normalized: null, points: null, reason: '同一列表包含不同定义或尺度，不能统一比较。' } : component);
    row.rank = { ...rankFromComponents(components), incompatibleFields: [...incompatible] };
    row.analysis.rank = row.rank;
    const rankIndex = row.analysis.evidence.findIndex(item => item.id === `${row.id}:rank`);
    if (rankIndex >= 0) row.analysis.evidence[rankIndex] = rankEvidence(row.id, row.analysis.availableAt, row.rank);
    if (incompatible.length) row.analysis.warnings.push(`列表内 ${incompatible.map(key => METRIC_LABELS[key] || '空间窗').join('、')} 的定义或尺度不一致，已从跨回合排序排除。`);
  }
  rows.sort((a, b) => (b.rank.priorityScore ?? -1) - (a.rank.priorityScore ?? -1) || b.rank.coverage - a.rank.coverage || a.analysis.start - b.analysis.start || a.id.localeCompare(b.id));
  return rows;
}

function formatMetric(metric) {
  if (!metric.available) return `${metric.label}尚无可用数据`;
  if (metric.adapterVersion === 2) return formatScopedMetric(metric);
  if (MAKE_PROBABILITY.has(metric.semantics) || LEVERAGE.has(metric.semantics)) return `${metric.label} ${round(metric.value * 100, 1)}%`;
  if (DIFFICULTY.has(metric.semantics)) return `${metric.label} ${round(metric.value, 2)}（0–1）`;
  return `${metric.label} ${round(metric.value, 2)}（${metric.unit}）`;
}

/** Grounded, timed Chinese narration. No cue may disclose a future result. */
export function buildNarration(play, analysis = analyzePossession(play), options = {}) {
  const errors = inspectPlay(play);
  if (errors.length || analysis?.playId !== play.id) throw new AnalysisError('解说与回合不匹配。', errors);
  const audience = options.audience || 'fan';
  if (!['fan', 'analyst'].includes(audience)) throw new AnalysisError('audience 只支持 fan 或 analyst。');
  if (options.language && options.language !== 'zh') throw new AnalysisError('当前内核仅提供 zh 证据解说。');
  const limit = Math.min(play.end, analysis.availableAt);
  const claims = [];
  const pending = [];
  const add = (id, text, t, evidenceIds, type = 'record') => {
    if (!finite(t) || t > limit) return;
    claims.push({ id: `${play.id}:claim:${id}`, text, t, evidenceIds, type });
    if (t < limit) pending.push({ start: Math.max(play.start, t), end: Math.min(limit, t + 3), text, evidenceIds });
  };
  const eventEvidence = `${play.id}:event`;
  add('intro', `${cleanText(play.period ? `Q${play.period}` : '', 20)} ${cleanText(play.clock, 32)} · ${teamOf(play) || '本队'}进攻`.trim(), play.start, [eventEvidence]);
  const window = [...analysis.temporal.opportunityWindows].sort((a, b) => b.duration - a.duration)[0];
  if (window) add('window-observation', audience === 'fan'
    ? `${window.playerName} 在这一帧的近防距离为 ${window.firstConfirmedDistanceFt} ft，值得留意这个空间。`
    : `${window.playerName} 近防采样距离 ${window.firstConfirmedDistanceFt} ft；这是这一帧的几何读数。`, window.firstConfirmedAt, [window.firstEvidenceId], 'coordinate-derived');
  if (window) add('window', audience === 'fan'
    ? `${window.playerName} 在采样画面中保持 ${window.thresholdFt} ft 以上防守距离，观察窗 ${window.duration} 秒。`
    : `${window.playerName} 采样近防距离 ≥${window.thresholdFt} ft：${window.duration}s，最大样本间隔 ${window.maxGap}s。`, window.end, [window.evidenceId], 'coordinate-derived');
  const contraction = analysis.temporal.contraction.at(-1);
  if (contraction && audience === 'analyst') add('contraction', `防守阵形凸包面积缩小 ${Math.abs(contraction.areaChangePct)}%；这里只描述采样位置变化。`, contraction.end, [contraction.evidenceId], 'coordinate-derived');
  const difficulty = analysis.metrics.difficulty;
  const hasShotTime = finite(analysis.shotTime);
  if (difficulty.available) add('difficulty', `${hasShotTime ? `${analysis.player || '球员'}出手` : '输入读数'} · ${formatMetric(difficulty)}${audience === 'fan' && MAKE_PROBABILITY.has(difficulty.semantics) ? '，概率不保证结果。' : '。'}`, hasShotTime ? Math.max(analysis.shotTime, difficulty.availableAt) : difficulty.availableAt, hasShotTime ? [difficulty.evidenceId, eventEvidence] : [difficulty.evidenceId]);
  else if (hasShotTime && analysis.shotTime <= limit) add('shot', `${analysis.player || '球员'}完成出手；当前没有兼容的难度读数。`, analysis.shotTime, [eventEvidence]);
  if (audience === 'analyst' && analysis.metrics.gravity.available) add('gravity', `${formatMetric(analysis.metrics.gravity)}；按来源口径读取。`, analysis.metrics.gravity.availableAt, [analysis.metrics.gravity.evidenceId]);
  const displayed = new Set(Object.values(analysis.metrics).filter(metric => metric.available).map(metric => metric.evidenceId));
  const scopedClaims = (analysis.metricHistory || analysis.scopedMetrics || []).filter(record => record.available && !displayed.has(record.evidenceId));
  for (const record of scopedClaims.slice(0, 8)) {
    add(`scoped-${record.id}`, `${formatScopedMetric(record)}${record.contextOnly ? '；这是范围统计，不能解释此刻的球员变化。' : '；按来源定义读取。'}`, Math.max(play.start, record.availableAt), [record.evidenceId], record.contextOnly ? 'aggregate-context' : 'record');
    const until = finite(record.displayUntil) ? record.displayUntil : record.time?.validTo;
    if (finite(until)) { const cue = pending.at(-1); if (cue?.evidenceIds.includes(record.evidenceId)) cue.end = Math.min(cue.end, until); }
  }
  if (analysis.outcome.available && analysis.outcome.availableAt !== null) add('outcome', analysis.outcome.value === 'made' ? `投篮命中${[2, 3].includes(play.shotValue || play.points) ? ` · ${play.shotValue || play.points} 分` : ''}。` : '本次投篮未中。', analysis.outcome.availableAt, [analysis.outcome.evidenceId]);
  pending.sort((a, b) => a.start - b.start);
  const grouped = [];
  for (const cue of pending) {
    const previous = grouped.at(-1);
    if (previous && previous.start === cue.start) { previous.text += ` ${cue.text}`; previous.evidenceIds = unique([...previous.evidenceIds, ...cue.evidenceIds]); previous.end = Math.min(previous.end, cue.end); }
    else grouped.push({ ...cue });
  }
  const cues = grouped.map((cue, index) => ({ ...cue, end: Math.min(cue.end, grouped[index + 1]?.start ?? limit) })).filter(cue => cue.end > cue.start).map(cue => ({
    ...cue, start: round(cue.start, 6), end: round(cue.end, 6), relativeStart: round(cue.start - play.start, 6), relativeEnd: round(cue.end - play.start, 6),
  }));
  const limitations = ['解说是输入证据的确定性编排；不代表语言模型或视频识别已运行。', '位置、空间窗及传球线是几何描述，不证明牵制、失误、命中或胜负的因果。'];
  if (analysis.coverage.tracking.kind === 'schematic' || analysis.coverage.tracking.kind === 'synthetic') limitations.push('当前球场位置为示意演练，不能当作真实比赛分析结论。');
  if (cues.some(cue => cue.end - cue.start < 1.2)) limitations.push('部分字幕停留不足 1.2 秒，成片前应延长片段或精简措辞。');
  const summary = [
    hasShotTime ? `${analysis.player || '球员'}的${[2, 3].includes(play.shotValue || play.points) ? `${play.shotValue || play.points} 分` : ''}出手回合。` : `${analysis.player || '球员'}的回合记录；出手时间未提供。`,
    formatMetric(difficulty) + '。',
    analysis.metrics.leverage.available ? `${formatMetric(analysis.metrics.leverage)}，不是实际胜率增减。` : '回合机会差缺失，未替代为实际胜率。',
    audience === 'analyst' ? `${formatMetric(analysis.metrics.gravity)}；单一引力指标不证明牵制造成得分。` : '',
    ...scopedClaims.slice(0, 8).map(record => `${formatScopedMetric(record)}${record.contextOnly ? '；范围统计不代表本回合瞬时变化。' : record.historical ? '；该读数只描述所列事件时刻。' : '。'}`),
    analysis.outcome.available ? `输入结果：${analysis.outcome.value === 'made' ? '命中' : '未中'}。` : '结果尚未揭晓或没有独立时间锚。',
  ].filter(Boolean).join('');
  return { playId: play.id, title: cleanText(play.title || `${analysis.team} · ${analysis.player}`, 240), text: summary, audience, language: 'zh', timeBase: 'video', cues, claims,
    evidenceIds: unique(claims.flatMap(claim => claim.evidenceIds)), limitations,
    eventEvidence: { id: eventEvidence, playId: play.id, t: play.start, field: 'team/player/shotValue', kind: sourceKind(play.provenance?.kind), value: { team: teamOf(play), player: playerOf(play), shotValue: play.shotValue || play.points || null }, source: cleanText(play.provenance?.source || '输入事件记录', 320), definition: '事件记录，不是由当前模块识别视频得出的身份。' },
  };
}

function parseQuery(plays, query) {
  if (query && typeof query === 'object' && !Array.isArray(query)) return { ...query };
  if (typeof query !== 'string' || !query.trim() || query.length > ANALYTICS_LIMITS.queryCharacters) throw new AnalysisError('问题必须是 1–1200 字文本或结构化查询。');
  const text = query.trim();
  const playIds = plays.filter(play => {
    const escaped = play.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(text);
  }).map(play => play.id);
  const conventional = [...text.matchAll(/(?<![A-Za-z0-9_])p\d+(?![A-Za-z0-9_])/gi)].map(match => match[0]);
  const unknown = conventional.filter(id => !plays.some(play => play.id.toLowerCase() === id.toLowerCase()));
  let intent = 'summary';
  if (/关键|回看|排序|rank|top/i.test(text)) intent = 'rank';
  if (/空间|空位|空档|opportun|open\b/i.test(text)) intent = 'opportunities';
  if (/收缩|阵形|contraction/i.test(text)) intent = 'contraction';
  if (/传球|备选|alternative|pass/i.test(text)) intent = 'alternatives';
  if (/出手距离|近防|shot.?context/i.test(text)) intent = 'shot-context';
  if (/证据|来源|evidence|source/i.test(text)) intent = 'evidence';
  let metric = null;
  if (/难度|xfg|命中概率|difficulty/i.test(text)) metric = 'difficulty';
  if (/引力|牵制|gravity/i.test(text)) metric = 'gravity';
  if (/机会差|leverage|杠杆|胜率/i.test(text)) metric = 'leverage';
  if (metric && (intent === 'summary' || /最高|最低|最大|最小|排序|排行|highest|lowest|maximum|minimum|order|sort/i.test(text))) intent = 'metric';
  const comparison = metric === 'difficulty' && /难度|difficulty/i.test(text) && !/xfg|命中概率/i.test(text) ? 'difficulty' : 'source';
  return { intent, metric, comparison, playIds, unknown, causal: /导致|造成|证明|因果|为什么.{0,12}(得分|命中|输|赢)|caus|because/i.test(text), order: /最低|最小|ascending|min\b/i.test(text) ? 'asc' : 'desc', text };
}

/** Safe evidence retrieval for a local assistant or a model's structured tool. */
export function queryEvidence(plays, query) {
  inspectPlays(plays);
  const parsed = parseQuery(plays, query);
  const intents = ['rank', 'metric', 'opportunities', 'contraction', 'shot-context', 'alternatives', 'summary', 'evidence'];
  if (!intents.includes(parsed.intent || 'summary')) throw new AnalysisError('不支持的证据查询 intent。');
  const intent = parsed.intent || 'summary';
  if (parsed.metric && !Object.keys(METRIC_KEYS).includes(parsed.metric)) throw new AnalysisError('不支持的指标查询。');
  if (parsed.playIds !== undefined && (!Array.isArray(parsed.playIds) || parsed.playIds.length > ANALYTICS_LIMITS.plays || parsed.playIds.some(id => typeof id !== 'string' || id.length > 120))) throw new AnalysisError('playIds 查询范围无效。');
  if (parsed.limit !== undefined && (!Number.isInteger(parsed.limit) || parsed.limit < 1 || parsed.limit > 100)) throw new AnalysisError('limit 必须是 1–100。');
  if (own(parsed, 'asOf') && (!finite(parsed.asOf) || parsed.asOf < 0)) throw new AnalysisError('asOf 必须是非负有限的视频绝对秒数。');
  const unknown = unique([...(Array.isArray(parsed.unknown) ? parsed.unknown.filter(id => typeof id === 'string').slice(0, 2000) : []), ...(parsed.playIds || []).filter(id => !plays.some(play => play.id === id))]);
  const warnings = [];
  const trace = [{ tool: 'validate_normalized_plays', status: 'ok', detail: `${plays.length} 个回合通过数量、时序与唯一标识校验。` }, { tool: 'resolve_query_scope', status: unknown.length ? 'unavailable' : 'ok', detail: unknown.length ? `不存在的指定回合：${unknown.join('、')}` : '按显式回合、球队、球员或节次确定范围。' }];
  if (unknown.length) return { intent, answer: `当前数据中没有 ${unknown.join('、')}，未用其他回合替代。`, matches: [], evidence: [], evidenceIds: [], warnings: ['指定回合不存在。'], trace };
  const scope = plays.filter(play => !(parsed.playIds?.length && !parsed.playIds.includes(play.id)) && (!parsed.team || teamOf(play) === parsed.team) && (!parsed.player || playerOf(play) === parsed.player) && (parsed.period === undefined || String(play.period) === String(parsed.period)));
  const options = own(parsed, 'asOf') ? { asOf: parsed.asOf } : {};
  let rows = rankPossessions(scope, options);
  if (intent === 'metric' && parsed.metric) {
    const visible = rows.filter(row => row.analysis.metrics[parsed.metric].available);
    const signatures = unique(visible.map(row => {
      const metric = row.analysis.metrics[parsed.metric];
      return parsed.comparison === 'difficulty' && parsed.metric === 'difficulty' ? metric.signature : `${metric.semantics}:${metric.unit}:${metric.definition}:${metric.dictionaryId || ''}:${metric.dictionaryVersion || ''}:${metric.version || ''}:${metric.scope?.granularity || ''}:${metric.ballState || ''}`;
    }));
    const contexts = rows.some(row => row.analysis.scopedMetrics.some(record => record.role === parsed.metric && record.contextOnly));
    if (contexts) warnings.push('球员／赛季统计仅作范围背景，不参与回合高低排序或瞬时动态判断。');
    if (signatures.length > 1) warnings.push('指标定义或单位不一致；返回原读数与来源，不给统一高低排行。');
    else rows.sort((a, b) => {
      const av = parsed.comparison === 'difficulty' && parsed.metric === 'difficulty' ? a.analysis.metrics[parsed.metric].normalized : a.analysis.metrics[parsed.metric].value;
      const bv = parsed.comparison === 'difficulty' && parsed.metric === 'difficulty' ? b.analysis.metrics[parsed.metric].normalized : b.analysis.metrics[parsed.metric].value;
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      return parsed.order === 'asc' ? av - bv : bv - av;
    });
  }
  rows = rows.slice(0, parsed.limit || 10);
  const selectedEvidence = new Map();
  const matches = rows.map(row => {
    const analysis = row.analysis;
    const windows = analysis.temporal.opportunityWindows.slice(0, 8);
    const contraction = analysis.temporal.contraction.slice(-8);
    const alternatives = analysis.tactical.alternatives.slice(0, 8);
    const requestedIds = new Set();
    if (intent === 'metric' && parsed.metric) { requestedIds.add(analysis.metrics[parsed.metric].evidenceId); analysis.scopedMetrics.filter(record => record.role === parsed.metric).forEach(record => requestedIds.add(record.evidenceId)); }
    else if (intent === 'opportunities') windows.forEach(item => { requestedIds.add(item.evidenceId); requestedIds.add(item.firstEvidenceId); });
    else if (intent === 'contraction') contraction.forEach(item => requestedIds.add(item.evidenceId));
    else if (intent === 'alternatives') alternatives.forEach(item => requestedIds.add(item.evidenceId));
    else if (intent === 'shot-context' && analysis.tactical.shotContext) requestedIds.add(analysis.tactical.shotContext.evidenceId);
    else if (intent === 'rank') { requestedIds.add(`${row.id}:rank`); analysis.rank.components.flatMap(component => component.evidenceIds).forEach(id => requestedIds.add(id)); }
    else if (intent === 'summary') { Object.values(analysis.metrics).forEach(item => requestedIds.add(item.evidenceId)); (analysis.scopedMetrics || []).forEach(item => requestedIds.add(item.evidenceId)); requestedIds.add(`${row.id}:outcome`); requestedIds.add(`${row.id}:event`); }
    const relevant = analysis.evidence.filter(item => intent === 'evidence' || requestedIds.has(item.id)).slice(0, 48);
    const visibleEvidenceIds = new Set(relevant.map(item => item.id));
    const scopedSummary = analysis.scopedMetrics.filter(item => visibleEvidenceIds.has(item.evidenceId)).slice(0, 16);
    const historySummary = analysis.metricHistory.filter(item => visibleEvidenceIds.has(item.evidenceId)).slice(0, 16);
    relevant.forEach(item => selectedEvidence.set(item.id, item));
    return { playId: row.id, rank: row.rank, analysis: { ...analysis, evidence: relevant,
      scopedMetrics: scopedSummary, metricContext: scopedSummary.filter(item => item.contextOnly), metricHistory: historySummary, metricAvailability: analysis.metricAvailability.slice(0, 16),
      temporal: { ...analysis.temporal, samples: [], opportunityWindows: windows, contraction },
      tactical: { ...analysis.tactical, alternatives },
      outputTruncated: { samplesOmitted: analysis.temporal.samples.length, opportunityWindowsOmitted: analysis.temporal.opportunityWindows.length - windows.length, contractionsOmitted: analysis.temporal.contraction.length - contraction.length, alternativesOmitted: analysis.tactical.alternatives.length - alternatives.length,
        evidenceOmittedFromFullAnalysis: analysis.evidence.length - relevant.length, scopedMetricsOmitted: analysis.scopedMetrics.length - scopedSummary.length, metricHistoryOmitted: analysis.metricHistory.length - historySummary.length,
        reason: 'Agent 检索返回有界摘要；完整逐帧分析由 analyzePossession 单独获取。' },
    } };
  });
  const evidence = [...selectedEvidence.values()];
  const lines = rows.map(row => {
    const analysis = row.analysis;
    if (intent === 'metric' && parsed.metric) {
      const metric = analysis.metrics[parsed.metric];
      const scoped = analysis.scopedMetrics.filter(record => record.role === parsed.metric && record.evidenceId !== metric.evidenceId).slice(0, 12);
      const difficultyLabel = parsed.comparison === 'difficulty' && parsed.metric === 'difficulty' ? metric.normalized === null ? '缺少可比难度尺度；' : `${metric.transformed ? '编辑难度 1−xFG' : '来源难度'} ${round(metric.normalized, 3)}；` : '';
      return `${row.id}：${difficultyLabel}${formatMetric(metric)} [${metric.evidenceId}]。${scoped.map(record => `${formatScopedMetric(record)} [${record.evidenceId}]${record.contextOnly ? '；范围统计不代表回合瞬时变化' : ''}。`).join('')}`;
    }
    if (intent === 'opportunities') return `${row.id}：${analysis.temporal.opportunityWindows.length ? analysis.temporal.opportunityWindows.slice(0, 8).map(window => `${window.playerName} ${window.start}–${window.end}s，采样近防距离 ≥${window.thresholdFt}ft [${window.evidenceId}]`).join('；') : '没有在完整防守名单与连续采样中确认空间窗；不等于实际没有空位'}。${analysis.temporal.opportunityWindows.length > 8 ? '仅列前 8 个窗口，可缩小回合范围继续查看。' : ''}`;
    if (intent === 'contraction') return `${row.id}：${analysis.temporal.contraction.length ? analysis.temporal.contraction.slice(-8).map(item => `${item.start}–${item.end}s 防守凸包面积变化 ${item.areaChangePct}% [${item.evidenceId}]`).join('；') : '没有可确认的阵形面积收缩样本'}。${analysis.temporal.contraction.length > 8 ? '仅列最后 8 个变化。' : ''}`;
    if (intent === 'alternatives') return `${row.id}：${analysis.tactical.alternatives.length ? analysis.tactical.alternatives.slice(0, 8).map(item => `${item.playerName} 静态传球线间距 ${item.laneClearanceFt ?? '缺失'}ft [${item.evidenceId}]`).join('；') : '缺少出手附近可核对的球场坐标'}。不能预测传球成功或替代选择收益。`;
    if (intent === 'shot-context') return `${row.id}：${analysis.tactical.shotContext?.nearestDefender ? `在 ${analysis.tactical.shotContext.t}s 输入样本中，近防距离 ${analysis.tactical.shotContext.nearestDefender.distanceFt}ft [${analysis.tactical.shotContext.evidenceId}]` : '出手附近没有可用球场样本'}。`;
    if (intent === 'evidence') return `${row.id}：${analysis.evidence.slice(0, 48).filter(item => item.available !== false && item.value !== null).map(item => `${item.field} [${item.id}]`).join('；') || '暂无可用证据'}。${analysis.evidence.length > 48 ? '仅列前 48 条证据。' : ''}`;
    if (intent === 'rank') return `${row.id}：编辑优先级 ${row.rank.priorityScore ?? '无法计算'}，已知权重覆盖 ${round(row.rank.coverage * 100, 1)}%，描述分范围 ${row.rank.scoreInterval.join('–')}。${row.rank.incompatibleFields.length ? '不兼容字段已排除。' : ''}`;
    const bound = new Set(Object.values(analysis.metrics).map(metric => metric.evidenceId));
    return `${row.id}：${formatMetric(analysis.metrics.difficulty)}；${formatMetric(analysis.metrics.gravity)}；${formatMetric(analysis.metrics.leverage)}。${analysis.scopedMetrics.filter(record => !bound.has(record.evidenceId)).slice(0, 8).map(record => `${formatScopedMetric(record)} [${record.evidenceId}]。`).join('')}`;
  });
  if (parsed.causal) warnings.push('输入观测与指标不能证明战术或胜负因果；以下只提供可核对描述。');
  trace.push({ tool: `query_${intent}`, status: 'ok', detail: `返回 ${rows.length} 个回合；每项可追溯到视频绝对秒、输入字段与数据类型。` });
  return { intent, answer: `${parsed.causal ? '这些证据不能证明因果。' : ''}${lines.join('\n') || '指定范围没有匹配回合。'}`, matches, evidence, evidenceIds: evidence.map(item => item.id), warnings, trace,
    output: { trackingSamplesIncluded: 0, spatialEventsPerPlayLimit: 8, evidencePerPlayLimit: 48, returnedEvidence: evidence.length, returnedMatches: matches.length } };
}
