/** Local, provider-neutral metric adapter. A source declaration is not certification. */
export const METRICS_SCHEMA = 'courtlens-metrics/2';
export const METRICS_LIMITS = Object.freeze({ records: 20000, perPlay: 1000, dictionary: 200, associations: 40000 });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => object(v) && Object.prototype.hasOwnProperty.call(v, k);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const clone = v => structuredClone(v);
const text = v => typeof v === 'string' && !!v.trim() && v.length <= 1200;
const GRANULARITIES = new Set(['shot', 'event', 'player', 'possession', 'season']);
const ROLES = new Set(['difficulty', 'gravity', 'leverage', 'context']);
const MAKE = new Set(['shot_make_probability', 'official_xfg', 'xfg_probability']);
const DIFFICULTY = new Set(['shot_difficulty', 'shot_difficulty_probability']);
const LEVERAGE = 'possession_win_probability_opportunity';
const CONTEXT = new Set(['season', 'player']);
const fail = message => { throw new Error(`指标 v2：${message}`); };
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : object(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);
const same = (a, b) => stable(a) === stable(b);

function provenance(v, label) {
  if (!object(v) || !text(v.kind) || !text(v.source)) fail(`${label} 必须声明 provenance.kind 与 source；来源标签不代表已认证。`);
}

function dictionaryEntry(entry, key) {
  if (!object(entry)) fail(`${key} 字典项须为对象。`);
  for (const field of ['version', 'label', 'semantics', 'unit', 'definition']) if (!text(entry[field])) fail(`${key} 缺少 ${field}。`);
  if (!GRANULARITIES.has(entry.granularity) || !ROLES.has(entry.role)) fail(`${key} 的 granularity 或 role 无效。`);
  if (entry.role === 'gravity' && !['on-ball', 'off-ball', 'combined', 'unknown'].includes(entry.ballState)) fail(`${key} 须声明 Gravity 的 ballState。`);
  if (entry.role === 'gravity' && /nearest[_-]?defender|defender[_-]?distance|shot[_-]?distance|distance_to/i.test(entry.semantics)) fail(`${key} 距离语义不可绑定为 Gravity。`);
  if (MAKE.has(entry.semantics) && !['probability', 'percent'].includes(entry.unit)) fail(`${key} 命中概率单位须为 probability 或 percent。`);
  if ((DIFFICULTY.has(entry.semantics) || entry.semantics === LEVERAGE) && entry.unit !== 'probability') fail(`${key} 0–1 口径须声明 probability 单位。`);
  if (entry.range !== undefined && (!Array.isArray(entry.range) || entry.range.length !== 2 || !entry.range.every(finite) || !(entry.range[1] > entry.range[0]) || !finite(entry.range[1] - entry.range[0]))) fail(`${key} range 须为可计算的递增有限区间。`);
  if (entry.provenance !== undefined) provenance(entry.provenance, key);
  const transforms = entry.transforms;
  if (transforms !== undefined && !object(transforms)) fail(`${key} transforms 须为对象。`);
  for (const field of Object.keys(transforms || {})) if (!['probability', 'editorial'].includes(field)) fail(`${key} 未知转换 ${field}。`);
  if (transforms?.probability !== undefined && !(transforms.probability === 'percent-to-probability' && entry.unit === 'percent' && MAKE.has(entry.semantics))) fail(`${key} 百分数转换必须明确来自命中概率 percent。`);
  if (transforms?.editorial !== undefined) {
    const conversion = transforms.editorial;
    const probabilityKnown = entry.unit === 'probability' || transforms.probability === 'percent-to-probability';
    const valid = conversion === 'one-minus-probability' && entry.role === 'difficulty' && MAKE.has(entry.semantics) && probabilityKnown
      || conversion === 'identity-0-1' && probabilityKnown && (entry.role === 'difficulty' && DIFFICULTY.has(entry.semantics) || entry.role === 'leverage' && entry.semantics === LEVERAGE)
      || conversion === 'declared-range' && entry.role === 'gravity' && Array.isArray(entry.range) && entry.higherIs === 'more' && !CONTEXT.has(entry.granularity);
    if (!valid) fail(`${key} 无法按该定义执行 editorial 转换；未知 Leverage 不可归一化。`);
    if (CONTEXT.has(entry.granularity)) fail(`${key} 球员／赛季汇总不能作为瞬时回合排序分量。`);
  }
}

function recordCheck(record, dictionary, plays, ids, slots) {
  if (!object(record) || !text(record.id) || ids.has(record.id)) fail('记录 id 须非空且唯一。');
  ids.add(record.id);
  const entry = own(dictionary.metrics, record.metricId) ? dictionary.metrics[record.metricId] : null;
  if (!entry) fail(`${record.id} 引用了不存在的 metricId。`);
  if (!own(record, 'value') || record.value !== null && !finite(record.value)) fail(`${record.id} value 须为有限数字或 null，不能用空白／布尔值代替。`);
  for (const field of ['unit', 'semantics', 'version', 'granularity', 'ballState', 'definition']) if (own(record, field) && !same(record[field], entry[field])) fail(`${record.id} 的 ${field} 与字典冲突。`);
  if (record.dictionaryVersion !== undefined && record.dictionaryVersion !== dictionary.version) fail(`${record.id} 字典版本冲突。`);
  const scope = record.scope;
  if (!object(scope) || scope.granularity !== entry.granularity) fail(`${record.id} scope.granularity 与字典不符。`);
  for (const field of ['playId', 'playerId', 'teamId', 'seasonId', 'shotId', 'eventId']) if (own(scope, field) && !text(scope[field])) fail(`${record.id} scope.${field} 无效。`);
  if (!CONTEXT.has(scope.granularity) && !text(scope.playId)) fail(`${record.id} 逐回合／出手／事件记录须指明 playId。`);
  if (scope.playId && !plays.has(scope.playId)) fail(`${record.id} 引用了不存在的回合。`);
  if (scope.granularity === 'shot' && !text(scope.shotId) || scope.granularity === 'event' && !text(scope.eventId)) fail(`${record.id} 须声明出手／事件 ID。`);
  if (scope.granularity === 'player' && !text(scope.playerId)) fail(`${record.id} 球员汇总须声明 playerId。`);
  if (scope.granularity === 'season' && (!text(scope.seasonId) || !text(scope.playerId) && !text(scope.teamId))) fail(`${record.id} 赛季汇总须声明 seasonId 与球员或球队。`);
  if (CONTEXT.has(scope.granularity) && (!object(record.aggregation) || !text(record.aggregation.start) || !text(record.aggregation.end) || !text(record.aggregation.label))) fail(`${record.id} 球员／赛季记录须保存 aggregation 的起止和范围说明。`);
  const timing = record.time;
  if (!object(timing) || timing.timeBase !== 'video' || !own(timing, 'observedAt') || !own(timing, 'availableAt')) fail(`${record.id} 须明确 video 时钟以及 observedAt / availableAt；未知用 null。`);
  for (const field of ['observedAt', 'availableAt', 'validFrom', 'validTo']) if (own(timing, field) && timing[field] !== null && (!finite(timing[field]) || timing[field] < 0)) fail(`${record.id} time.${field} 须为非负视频秒或 null。`);
  if (finite(timing.validFrom) && finite(timing.validTo) && timing.validTo <= timing.validFrom) fail(`${record.id} 有效区间倒置。`);
  const play = scope.playId ? plays.get(scope.playId) : null;
  if (play && finite(timing.observedAt) && (timing.observedAt < play.start || timing.observedAt > play.end)) fail(`${record.id} 观察时刻不在所属回合内。`);
  if (scope.granularity === 'shot' && play?.shotId && play.shotId !== scope.shotId) fail(`${record.id} 出手身份与回合冲突。`);
  if (scope.granularity === 'shot' && scope.playerId && (play?.playerId || play?.player) && scope.playerId !== (play.playerId || play.player)) fail(`${record.id} 出手球员与回合冲突。`);
  if (play && scope.seasonId && play.seasonId && scope.seasonId !== play.seasonId) fail(`${record.id} 赛季身份与所属回合冲突。`);
  if (play && ['shot', 'possession'].includes(scope.granularity) && scope.teamId && (play.team || play.offense) && scope.teamId !== (play.team || play.offense)) fail(`${record.id} 进攻球队与所属回合冲突。`);
  if (scope.granularity === 'shot' && finite(play?.shotTime) && finite(timing.observedAt) && timing.observedAt !== play.shotTime) fail(`${record.id} 出手观察时刻与 shotTime 冲突。`);
  if (record.provenance !== undefined) provenance(record.provenance, record.id);
  if (record.value !== null) {
    if (entry.range && (record.value < entry.range[0] || record.value > entry.range[1])) fail(`${record.id} 读数超出声明范围。`);
    if ((MAKE.has(entry.semantics) || DIFFICULTY.has(entry.semantics) || entry.semantics === LEVERAGE) && (record.value < 0 || record.value > (entry.unit === 'percent' ? 100 : 1))) fail(`${record.id} 读数超出明确概率尺度；不猜测单位。`);
  }
  const slot = stable([record.metricId, scope, timing.observedAt, timing.validFrom ?? null, timing.validTo ?? null]);
  if (slots.has(slot)) fail(`${record.id} 与 ${slots.get(slot)} 在相同指标／粒度／时刻冲突，请先消解重复记录。`);
  slots.set(slot, record.id);
}

export function validateMetricBundle(bundle) {
  if (!object(bundle) || bundle.schema !== METRICS_SCHEMA) fail('不支持的 schema；需要 courtlens-metrics/2。');
  const dictionary = bundle.dictionary;
  if (!object(dictionary) || !text(dictionary.id) || !text(dictionary.version) || !object(dictionary.metrics)) fail('需要带 id、version、metrics 的数据字典。');
  provenance(dictionary.provenance, '字典');
  if (bundle.provenance !== undefined) provenance(bundle.provenance, '数据集');
  const entries = Object.entries(dictionary.metrics);
  if (!entries.length || entries.length > METRICS_LIMITS.dictionary) fail('字典数量须为 1–200。');
  for (const [key, entry] of entries) { if (!text(key)) fail('字典指标 ID 无效。'); dictionaryEntry(entry, key); }
  if (!object(bundle.bindings)) fail('bindings 须为对象；用空对象表示不绑定排序字段。');
  for (const [role, metricId] of Object.entries(bundle.bindings)) if (!['difficulty', 'gravity', 'leverage'].includes(role) || !text(metricId) || !own(dictionary.metrics, metricId) || dictionary.metrics[metricId]?.role !== role) fail(`bindings.${role} 引用或角色冲突。`);
  if (!Array.isArray(bundle.plays) || !bundle.plays.length || bundle.plays.length > 2000) fail('需要最多 2000 条的 plays 数组。');
  const plays = new Map();
  for (const play of bundle.plays) {
    if (!object(play) || !text(play.id) || plays.has(play.id) || !finite(play.start) || !finite(play.end) || play.start < 0 || play.end <= play.start) fail('回合 ID／时间无效。');
    if (play.metrics !== undefined && (!object(play.metrics) || Object.keys(play.metrics).length)) fail(`${play.id} v2 不同时接收旧 metrics；避免两个冲突的数据来源。`);
    plays.set(play.id, play);
  }
  if (!Array.isArray(bundle.records) || bundle.records.length > METRICS_LIMITS.records) fail('records 须为最多 20000 条的数组。');
  const ids = new Set(), slots = new Map();
  for (const record of bundle.records) recordCheck(record, dictionary, plays, ids, slots);
  return true;
}

function applies(scope, play) {
  if (scope.playId && scope.playId !== play.id) return false;
  if (scope.playId && !CONTEXT.has(scope.granularity)) return true;
  if (scope.playerId && scope.playerId !== (play.playerId || play.player || play.shooter)) return false;
  if (scope.teamId && scope.teamId !== (play.team || play.offense)) return false;
  if (scope.seasonId && scope.seasonId !== play.seasonId) return false;
  return true;
}

function expand(record, dictionary) {
  const entry = dictionary.metrics[record.metricId];
  return { ...clone(entry), ...clone(record), schema: METRICS_SCHEMA, dictionaryId: dictionary.id, dictionaryVersion: dictionary.version,
    provenance: clone(record.provenance || entry.provenance || dictionary.provenance), sourceRecord: clone(record) };
}

export function adaptMetricBundle(bundle) {
  validateMetricBundle(bundle);
  const metricAdapter = { schema: METRICS_SCHEMA, dictionary: clone(bundle.dictionary), bindings: clone(bundle.bindings), records: clone(bundle.records), provenance: clone(bundle.provenance || bundle.dictionary.provenance) };
  let associations = 0;
  const plays = bundle.plays.map(play => {
    const related = bundle.records.filter(record => applies(record.scope, play));
    associations += related.length;
    if (related.length > METRICS_LIMITS.perPlay || associations > METRICS_LIMITS.associations) fail(`${play.id} 关联指标超过单回合 1000 条或项目 40000 条，请分段导入。`);
    const metricRecords = related.map(record => expand(record, bundle.dictionary));
    const adapted = { ...clone(play), metrics: {}, metricRecords, metricBindings: clone(bundle.bindings), sourceRecord: clone(play) };
    for (const role of ['difficulty', 'gravity', 'leverage']) {
      const selected = selectBoundMetric(adapted, role, play.end);
      if (selected.record) adapted.metrics[role] = clone(selected.record);
    }
    return adapted;
  });
  return { input: { ...clone(bundle), schema: undefined, plays, provenance: clone(bundle.provenance || bundle.dictionary.provenance) }, metricAdapter };
}

export function validateAdaptedMetrics(project) {
  if (project.metricAdapter === undefined) {
    if (project.plays.some(play => play.metricRecords !== undefined || play.metricBindings !== undefined)) fail('metricRecords 缺少项目级版本字典。');
    return true;
  }
  const adapter = project.metricAdapter;
  const plays = project.plays.map(play => ({ ...play, metrics: {} }));
  const { input } = adaptMetricBundle({ ...adapter, plays });
  for (let i = 0; i < project.plays.length; i++) {
    if (!same(project.plays[i].metricRecords, input.plays[i].metricRecords) || !same(project.plays[i].metricBindings, adapter.bindings)) fail(`${project.plays[i].id} 指标记录与保存的来源／字典冲突。`);
  }
  return true;
}

/** v2 is already video-aligned. Applying a global source-clock offset is ambiguous. */
export function metricTimeSyncPolicy(project) {
  if (!project?.metricAdapter) return { allowed: true, code: null, reason: '' };
  return { allowed: false, code: 'metric-v2-video-axis-fixed',
    reason: '指标 v2 已明确使用视频绝对秒；不能再次对整份项目应用来源轴偏移。请保留当前数据，用时间锚核对；若需换时间轴，请把回合、指标的观察／可用／有效区间与轨迹明确映射到同一新视频秒后重新导入 v2 文件。' };
}

export function assertMetricTimeSyncAllowed(project) {
  const policy = metricTimeSyncPolicy(project);
  if (!policy.allowed) {
    const error = new Error(policy.reason);
    error.code = policy.code;
    throw error;
  }
  return true;
}

function availability(record, asOf) {
  if (!finite(asOf) || asOf < 0) fail('asOf 须为非负有限视频秒。');
  const timing = record.time;
  if (!object(timing) || timing.timeBase !== 'video') return 'invalid-time';
  if (!finite(timing.availableAt)) return 'missing-availability';
  if (!CONTEXT.has(record.scope?.granularity) && !finite(timing.observedAt)) return 'missing-observation-time';
  if (timing.availableAt > asOf || finite(timing.observedAt) && timing.observedAt > asOf || finite(timing.validFrom) && timing.validFrom > asOf) return 'future';
  if (finite(timing.validTo) && asOf >= timing.validTo) return 'expired';
  return record.value === null ? 'missing' : null;
}

/** Latest time-valid version per metric + exact statistical scope; null masks older data. */
export function selectMetricRecords(play, { asOf = play.end } = {}) {
  if (!finite(asOf) || asOf < 0) fail('asOf 须为非负有限视频秒。');
  if (asOf < play.start) return { selected: [], unavailable: (play.metricRecords || []).map(record => ({id:record.id, metricId:record.metricId, reason:'play-not-started'})) };
  const groups = new Map(), unavailable = [];
  for (const record of play.metricRecords || []) {
    const reason = availability(record, asOf);
    if (reason && reason !== 'missing') { unavailable.push({ id: record.id, metricId: record.metricId, reason }); continue; }
    const group = stable([record.metricId, record.scope]);
    const old = groups.get(group);
    const order = record.time.observedAt ?? record.time.validFrom ?? record.time.availableAt;
    const oldOrder = old ? old.time.observedAt ?? old.time.validFrom ?? old.time.availableAt : -1;
    if (!old || order > oldOrder || order === oldOrder && record.time.availableAt > old.time.availableAt) groups.set(group, record);
  }
  const selected = [...groups.values()].map(record => ({ ...clone(record), available: record.value !== null, reason: record.value === null ? 'missing' : null,
    availableAt: Math.max(play.start, record.time.availableAt, record.time.observedAt ?? 0, record.time.validFrom ?? 0), contextOnly: CONTEXT.has(record.scope.granularity), evidenceId: `${play.id}:metric-v2:${record.id}` }));
  return { selected, unavailable };
}

/** Historical evidence stays at its first valid video time, never a current reading. */
export function metricHistory(play, { asOf = play.end } = {}) {
  if (!finite(asOf) || asOf < 0) fail('asOf 须为非负有限视频秒。');
  if (asOf < play.start) return [];
  const current = new Set(selectMetricRecords(play, { asOf }).selected.map(record => record.id));
  const history = (play.metricRecords || []).flatMap(record => {
    if (!finite(record.time?.availableAt)) return [];
    const anchor = Math.max(play.start, record.time.availableAt, record.time.observedAt ?? 0, record.time.validFrom ?? 0);
    if (anchor > asOf || anchor > play.end) return [];
    const reason = availability(record, anchor);
    if (reason && reason !== 'missing') return [];
    return [{ ...clone(record), availableAt: anchor, available: record.value !== null, reason: record.value === null ? 'missing' : null,
      contextOnly: CONTEXT.has(record.scope.granularity), historical: !current.has(record.id), availableNow: current.has(record.id), evidenceId: `${play.id}:metric-v2:${record.id}` }];
  }).sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id));
  const grouped = new Map();
  for (const record of history) {
    const scope = stable([record.metricId, record.scope]);
    const records = grouped.get(scope) || [];
    records.push(record); grouped.set(scope, records);
  }
  for (const records of grouped.values()) for (let i = 0; i < records.length; i++) {
    const limits = [records[i].time.validTo, records[i + 1]?.availableAt].filter(finite);
    records[i].displayUntil = limits.length ? Math.min(...limits) : null;
  }
  return history;
}

export function selectBoundMetric(play, role, asOf = play.end) {
  const metricId = play.metricBindings?.[role];
  if (!metricId) return { record: null, reason: 'unbound' };
  const selection = selectMetricRecords(play, { asOf });
  const all = selection.selected.filter(record => record.metricId === metricId);
  let candidates = all.filter(record => !record.contextOnly && (role !== 'difficulty' || record.scope.granularity === 'shot') && (role !== 'leverage' || record.scope.granularity === 'possession'));
  const player = play.playerId || play.player || play.shooter;
  const matchingPlayer = candidates.filter(record => record.scope.playerId === player);
  if (matchingPlayer.length) candidates = matchingPlayer;
  if (candidates.length > 1) {
    const latest = Math.max(...candidates.map(record => record.time.observedAt ?? -1));
    candidates = candidates.filter(record => record.time.observedAt === latest);
  }
  if (candidates.length > 1) return { record: null, reason: 'ambiguous-scope' };
  if (candidates.length) return { record: candidates[0], reason: candidates[0].reason };
  return { record: null, reason: all.length ? 'context-only-or-incompatible-granularity' : selection.unavailable.find(record => record.metricId === metricId)?.reason || 'missing' };
}

export function metricTransforms(record) {
  const probability = MAKE.has(record.semantics) && record.unit === 'probability' ? record.value
    : record.transforms?.probability === 'percent-to-probability' ? record.value === null ? null : record.value / 100 : null;
  let normalized = null;
  if (!CONTEXT.has(record.scope?.granularity) && !record.contextOnly && record.value !== null) {
    if (record.transforms?.editorial === 'one-minus-probability' && probability !== null) normalized = 1 - probability;
    if (record.transforms?.editorial === 'identity-0-1') normalized = record.value;
    if (record.transforms?.editorial === 'declared-range') normalized = (record.value - record.range[0]) / (record.range[1] - record.range[0]);
  }
  return { probability, normalized, transformed: normalized !== null && normalized !== record.value,
    signature: normalized === null ? null : stable([record.dictionaryId, record.dictionaryVersion, record.metricId, record.version, record.unit, record.semantics, record.definition, record.scope.granularity, record.ballState ?? null, record.range ?? null, record.higherIs ?? null, record.transforms]) };
}

export function metricRecordEvidence(playId, record) {
  return { id: record.evidenceId || `${playId}:metric-v2:${record.id}`, playId, t: record.availableAt,
    field: `metricRecords.${record.id}`, value: record.available ? record.value : null, available: record.available, reason: record.reason,
    kind: record.provenance.kind, source: record.provenance.source, provenance: clone(record.provenance), unit: record.unit, semantics: record.semantics, definition: record.definition,
    dictionaryId: record.dictionaryId, dictionaryVersion: record.dictionaryVersion, metricVersion: record.version, metricId: record.metricId,
    scope: clone(record.scope), time: clone(record.time), ballState: record.ballState ?? null, aggregation: clone(record.aggregation ?? null), contextOnly: record.contextOnly,
    ...(own(record, 'historical') ? {historical:record.historical, availableNow:record.availableNow, displayUntil:record.displayUntil} : {}) };
}

/** Display source units unchanged; statistical scope is always visible. */
export function formatScopedMetric(record) {
  const granularity = { shot: '单次出手', event: '事件', possession: '本回合', player: '球员汇总', season: '赛季汇总' }[record.scope?.granularity] || '未知粒度';
  const ball = { 'on-ball': '有球', 'off-ball': '无球', combined: '有球＋无球', unknown: '有球／无球未分' }[record.ballState];
  const identity = record.scope?.playerId ? `，球员 ${record.scope.playerId}` : record.scope?.teamId ? `，球队 ${record.scope.teamId}` : '';
  const observed = ['event', 'shot'].includes(record.scope?.granularity) && finite(record.time?.observedAt) ? ` ${record.time.observedAt}s` : '';
  const value = record.available === false || record.value === null ? '未提供' : `${record.value}${record.unit === 'percent' ? '%' : ` ${record.unit}`}`;
  const period = record.aggregation ? `，${record.aggregation.label}（${record.aggregation.start}–${record.aggregation.end}）` : '';
  return `${record.label} ${value}（${granularity}${observed}${identity}${ball ? `，${ball}` : ''}${period}）`;
}
