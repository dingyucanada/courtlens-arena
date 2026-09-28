/** Browser-only domain model. Imported values are data, never markup or code. */
export const MAX_PLAYS = 2000;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const FIELDS = ['id','start','end','shooter','team','points','made','shotTime','resultTime','tag','notes','xfg','x','y','source'];
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const has = (value, key) => Object.hasOwn(value, key);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const issue = (severity, code, message, playId) => ({ severity, code, message, ...(playId ? {playId} : {}) });
const now = () => new Date().toISOString();
let sequence = 0;
export function id(prefix = 'id') {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${token}`;
}

/** Reject non-JSON objects, accessors, cycles, dangerous keys, and excessive nesting. */
function assertData(value, path = 'data', ancestors = new Set(), depth = 0) {
  if (value === null || ['string','boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || depth > 40 || (!Array.isArray(value) && !record(value))) throw new Error(`${path}: expected plain JSON data.`);
  if (ancestors.has(value)) throw new Error(`${path}: circular data is not supported.`);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Object.keys(value).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error(`${path}: sparse arrays or extra array properties are not supported.`);
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN.has(key)) throw new Error(`${path}: unsafe property name.`);
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !has(descriptor, 'value')) throw new Error(`${path}: accessor properties are not supported.`);
    assertData(descriptor.value, `${path}.${key}`, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
function fail(issues, label = 'Invalid data') {
  const errors = issues.filter(item => item.severity === 'error');
  if (errors.length) {
    const error = new Error(`${label}: ${errors.slice(0, 4).map(item => item.message).join(' ')}${errors.length > 4 ? ` (${errors.length} errors total)` : ''}`);
    error.code = 'VALIDATION'; error.issues = issues; throw error;
  }
}
function readJSON(text, limit = MAX_IMPORT_BYTES, wrapperDepth = 0) {
  checkText(text, limit);
  let result;
  try { result = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Invalid JSON: ${error.message}`); }
  assertData(result, 'data', new Set(), -wrapperDepth);
  return result;
}
function checkText(text, limit = MAX_IMPORT_BYTES) {
  if (typeof text !== 'string') throw new Error('Import must be text.');
  if (new TextEncoder().encode(text).length > limit) throw new Error(`Import exceeds the ${limit / 1024 / 1024} MiB limit.`);
  if (!text.trim()) throw new Error('Import is empty.');
}
function string(value, field, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  if (value.length > 100000) throw new Error(`${field} exceeds 100,000 characters.`);
  return value;
}
export function createProject({ name, scenario = 'coach', source = '', opponent = '', date = '' } = {}) {
  const timestamp = now();
  const project = { schemaVersion: 1, id: id('project'), name: string(name, 'name', 'Untitled project').trim() || 'Untitled project', scenario, opponent: string(opponent, 'opponent'), date: string(date, 'date'), source: string(source, 'source'), createdAt: timestamp, updatedAt: timestamp, revision: 0, status: 'draft', video: null, plays: [], playlist: [], activity: [] };
  fail(validateProject(project), 'Cannot create project');
  return project;
}

function validatePlays(plays, duration = null) {
  const issues = [];
  if (!Array.isArray(plays)) return [issue('error', 'PLAYS_TYPE', 'Plays must be an array.')];
  if (plays.length > MAX_PLAYS) issues.push(issue('error', 'PLAY_LIMIT', `At most ${MAX_PLAYS} plays are supported.`));
  const ids = new Set();
  plays.forEach((play, index) => {
    const context = `Play ${index + 1}`;
    if (!record(play)) { issues.push(issue('error', 'PLAY_TYPE', `${context} must be an object.`)); return; }
    const playId = typeof play.id === 'string' ? play.id : undefined;
    const add = (severity, code, message) => issues.push(issue(severity, code, `${context}: ${message}`, playId));
    if (!nonempty(play.id) || play.id.length > 200) add('error', 'PLAY_ID', 'a nonempty ID of at most 200 characters is required.');
    else if (ids.has(play.id)) add('error', 'DUPLICATE_PLAY_ID', `duplicate ID ${play.id}.`);
    else ids.add(play.id);
    for (const field of ['shooter','team','tag','notes','source']) if (typeof play[field] !== 'string' || play[field].length > 100000) add('error', 'PLAY_TEXT', `${field} must be text of at most 100,000 characters.`);
    for (const field of ['start','end','shotTime','resultTime']) if (!finite(play[field]) || play[field] < 0) add('error', 'PLAY_TIME', `${field} must be a finite, nonnegative number of video seconds.`);
    if (finite(play.start) && finite(play.end) && play.end <= play.start) add('error', 'PLAY_RANGE', 'end must be after start.');
    if (finite(duration) && finite(play.end) && play.end > duration + 0.001) add('error', 'VIDEO_BOUNDS', 'end exceeds the bound video duration.');
    if (finite(play.shotTime) && (play.shotTime < play.start || play.shotTime > play.end)) add('error', 'SHOT_TIME', 'shotTime must be inside the play.');
    if (finite(play.resultTime) && (play.resultTime < play.shotTime || play.resultTime > play.end)) add('error', 'RESULT_TIME', 'resultTime must be on/after shotTime and inside the play.');
    if (![2,3].includes(play.points)) add('error', 'POINTS', 'points must be the shot value 2 or 3, including misses.');
    if (![true,false,null].includes(play.made)) add('error', 'RESULT', 'made must be true, false, or null (unknown).');
    else if (play.made === null) add('warning', 'UNKNOWN_RESULT', 'outcome is unknown and excluded from shooting percentages.');
    if (typeof play.reviewed !== 'boolean') add('error', 'REVIEW_STATE', 'reviewed must be a boolean.');
    if (has(play,'sourceEvidence') && (!record(play.sourceEvidence) || !record(play.sourceEvidence.record) || !record(play.sourceEvidence.metricSemantics))) add('error','SOURCE_EVIDENCE','sourceEvidence must contain a raw record and metricSemantics objects.');
    if (play.xfg !== null && (!finite(play.xfg) || play.xfg < 0 || play.xfg > 1)) add('error', 'XFG', 'xfg must be null or a probability between 0 and 1.');
    const xAbsent = play.x === null, yAbsent = play.y === null;
    if (xAbsent !== yAbsent) add('error', 'COORDINATE_PAIR', 'x and y must both be supplied or both be null.');
    if (!xAbsent && (!finite(play.x) || play.x < 0 || play.x > 1)) add('error', 'COORDINATE', 'x must be null or between 0 and 1.');
    if (!yAbsent && (!finite(play.y) || play.y < 0 || play.y > 1)) add('error', 'COORDINATE', 'y must be null or between 0 and 1.');
    if (!nonempty(play.source)) add('warning', 'PLAY_SOURCE', 'no per-play source is recorded.');
  });
  return issues;
}
export function validateProject(project) {
  const issues = [];
  try { assertData(project); }
  catch (error) { return [issue('error', 'UNSAFE_DATA', error.message)]; }
  if (!record(project)) return [issue('error', 'PROJECT_TYPE', 'Project must be an object.')];
  // Keep every valid saved project small enough for a portable, re-importable backup.
  if (new TextEncoder().encode(JSON.stringify(project)).length > MAX_BACKUP_BYTES / 2) return [issue('error','PROJECT_SIZE','Project data exceeds 32 MiB; split it into smaller projects.')];
  const add = (severity, code, message) => issues.push(issue(severity, code, message));
  if (project.schemaVersion !== 1) add('error', 'SCHEMA_VERSION', 'Unsupported project schemaVersion; expected 1.');
  if (!nonempty(project.id) || project.id.length > 200) add('error', 'PROJECT_ID', 'A project ID of at most 200 characters is required.');
  if (!nonempty(project.name) || project.name.length > 500) add('error', 'PROJECT_NAME', 'A project name of 1–500 characters is required.');
  if (!['coach','editor'].includes(project.scenario)) add('error', 'SCENARIO', 'Scenario must be coach or editor.');
  if (!['draft','review','approved'].includes(project.status)) add('error', 'STATUS', 'Status must be draft, review, or approved.');
  for (const field of ['source','opponent','date']) if (typeof project[field] !== 'string' || project[field].length > 100000) add('error', 'PROJECT_TEXT', `${field} must be text of at most 100,000 characters.`);
  for (const field of ['createdAt','updatedAt']) if (typeof project[field] !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(project[field]) || !Number.isFinite(Date.parse(project[field]))) add('error', 'PROJECT_DATE', `${field} must be an ISO timestamp.`);
  if (!Number.isSafeInteger(project.revision) || project.revision < 0) add('error', 'REVISION', 'Revision must be a nonnegative integer.');
  if (has(project, 'archived') && typeof project.archived !== 'boolean') add('error', 'ARCHIVED', 'archived must be a boolean.');
  const approvalLevel = project.status === 'approved' ? 'error' : 'warning';
  if (!nonempty(project.source)) add(approvalLevel, 'SOURCE_REQUIRED', 'Record the project source before approval.');
  let duration = null;
  if (project.video === null) add(approvalLevel, 'VIDEO_REQUIRED', 'Bind a video before approval.');
  else if (!record(project.video)) add('error', 'VIDEO_TYPE', 'Video must be null or a metadata object.');
  else {
    const video = project.video;
    if (!nonempty(video.id) || video.id.length > 200) add('error', 'VIDEO_ID', 'Video requires a nonempty media ID of at most 200 characters.');
    if (!nonempty(video.name)) add('error', 'VIDEO_NAME', 'Video requires a filename.');
    if (!Number.isSafeInteger(video.size) || video.size < 0) add('error', 'VIDEO_SIZE', 'Video size must be a nonnegative integer.');
    if (!finite(video.duration) || video.duration <= 0) add('error', 'VIDEO_DURATION', 'Video duration must be a finite positive number.');
    else duration = video.duration;
    for (const field of ['width','height']) if (!Number.isSafeInteger(video[field]) || video[field] <= 0) add('error', 'VIDEO_DIMENSIONS', `Video ${field} must be a positive integer.`);
    if (typeof video.sha256 !== 'string' || (video.sha256 !== '' && !/^[a-f\d]{64}$/i.test(video.sha256))) add('error', 'VIDEO_HASH', 'Video sha256 must be empty or 64 hexadecimal characters.');
    if (has(video, 'url') && video.url !== 'media/demo.mp4') add('error', 'VIDEO_URL', 'Only the bundled relative demo URL is supported; attach other videos locally.');
    if (has(video, 'needsReattach') && typeof video.needsReattach !== 'boolean') add('error', 'VIDEO_REATTACH', 'Video needsReattach must be a boolean.');
    if (video.needsReattach) add(approvalLevel, 'VIDEO_REATTACH_REQUIRED', 'Reattach this imported video before approval.');
  }
  issues.push(...validatePlays(project.plays, duration));
  if (Array.isArray(project.plays) && !project.plays.length) add(approvalLevel, 'PLAYS_REQUIRED', 'Add at least one play before approval.');
  if (project.status === 'approved' && Array.isArray(project.plays) && project.plays.some(play => play?.reviewed !== true)) add('error', 'REVIEW_REQUIRED', 'Every play must be reviewed before approval.');
  if (!Array.isArray(project.playlist)) add('error', 'PLAYLIST_TYPE', 'Playlist must be an array.');
  else {
    if (project.playlist.length > MAX_PLAYS) add('error', 'PLAYLIST_LIMIT', `At most ${MAX_PLAYS} playlist items are supported.`);
    const playMap = new Map((Array.isArray(project.plays) ? project.plays : []).filter(record).map(play => [play.id, play]));
    const ids = new Set();
    project.playlist.forEach((item, index) => {
      if (!record(item)) { add('error', 'CLIP_TYPE', `Clip ${index + 1} must be an object.`); return; }
      if (!nonempty(item.id) || item.id.length > 200 || ids.has(item.id)) add('error', 'CLIP_ID', `Clip ${index + 1} requires a unique ID of at most 200 characters.`);
      ids.add(item.id);
      if (typeof item.title !== 'string' || item.title.length > 100000) add('error', 'CLIP_TITLE', `Clip ${index + 1} title must be text.`);
      const play = playMap.get(item.playId);
      if (!play) add('error', 'CLIP_PLAY', `Clip ${index + 1} references a missing play.`);
      if (!finite(item.in) || !finite(item.out) || item.in < 0 || item.out <= item.in || (play && (item.in < play.start || item.out > play.end))) add('error', 'CLIP_BOUNDS', `Clip ${index + 1} must have positive duration inside its referenced play.`);
    });
  }
  if (!Array.isArray(project.activity) || project.activity.length > 10000) add('error', 'ACTIVITY', 'Activity must be an array of at most 10,000 entries.');
  return issues;
}

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; };
  const finishRow = () => { finishCell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > MAX_PLAYS + 1) throw new Error(`At most ${MAX_PLAYS} plays are supported.`); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += ch; continue; }
    if (ch === ',') { finishCell(); continue; }
    if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; finishRow(); continue; }
    if (closed) { if (ch === ' ' || ch === '\t') continue; throw new Error(`Invalid CSV: unexpected character after a closing quote at position ${i + 1}.`); }
    if (ch === '"') { if (cell.length) throw new Error(`Invalid CSV: quote inside an unquoted field at position ${i + 1}.`); quoted = true; }
    else cell += ch;
  }
  if (quoted) throw new Error('Invalid CSV: an opening quote has no closing quote.');
  if (cell.length || row.length || closed) finishRow();
  if (rows.length < 2) throw new Error('CSV needs a header and at least one play.');
  const aliases = { shot_time:'shotTime', result_time:'resultTime' };
  const headers = rows.shift().map(header => has(aliases, header.trim()) ? aliases[header.trim()] : header.trim());
  const known = new Set([...FIELDS, 'reviewed']);
  if (headers.some(header => !header || FORBIDDEN.has(header))) throw new Error('CSV contains an empty or unsafe header.');
  if (new Set(headers).size !== headers.length) throw new Error('CSV contains duplicate headers (including time aliases).');
  for (const field of ['start','end','points']) if (!headers.includes(field)) throw new Error(`CSV is missing required column ${field}.`);
  return {rows:rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${values.length} fields; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  }), unknown:headers.filter(header => !known.has(header))};
}
function numeric(value, field, optional = false) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (optional) return null;
    throw new Error(`${field} is required and must be a number.`);
  }
  if (typeof value === 'string') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) throw new Error(`${field} must be a finite decimal number.`);
    value = Number(value.trim());
  }
  if (!finite(value)) throw new Error(`${field} must be a finite number.`);
  return value;
}
function result(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (['true','1','made','make','yes','命中'].includes(token)) return true;
    if (['false','0','missed','miss','no','未中'].includes(token)) return false;
    if (['','null','unknown','pending','未知'].includes(token)) return null;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error('made/result must be true, false, made, missed, or unknown/null.');
}
export function parseImport(text, { format = 'json', duration = null, source = '' } = {}) {
  checkText(text);
  if (duration !== null && (!finite(duration) || duration <= 0)) throw new Error('duration must be null or a positive number.');
  source = string(source, 'source');
  let rows, dataset = null; const issues = [];
  if (format === 'csv') {
    const csv = parseCSV(text); rows = csv.rows;
    if (csv.unknown.length) issues.push(issue('warning','IGNORED_COLUMNS', `Unrecognized CSV columns were ignored: ${csv.unknown.join(', ')}.`));
  } else if (format === 'json') {
    const data = readJSON(text);
    if (Array.isArray(data)) rows = data;
    else if (record(data) && Array.isArray(data.plays)) rows = data.plays;
    else if (record(data) && Array.isArray(data.possessions)) {
      rows = data.possessions; dataset = data;
      issues.push(issue('warning','EVIDENCE_ARCHIVED','Original per-play records, including Gravity, Leverage, tracks and annotations, are retained as source evidence with metric semantics. Studio statistics and WebM do not render or recompute these advanced fields. Keep the original file for full dataset context and the original evidence workbench.'));
    }
    else throw new Error('JSON must contain a plays array, a possessions array, or be an array of plays.');
  } else throw new Error('Import format must be csv or json.');
  if (!rows.length || rows.length > MAX_PLAYS) throw new Error(`Import must contain 1–${MAX_PLAYS} plays.`);
  if (dataset) {
    if (dataset.metric_semantics !== undefined && !record(dataset.metric_semantics)) throw new Error('metric_semantics must be an object.');
    // Budget repeated metadata before cloning it, not after the expanded project exists.
    const encoder = new TextEncoder();
    const projectedBytes = 2 * encoder.encode(text).length + rows.length * encoder.encode(JSON.stringify(dataset.metric_semantics || {})).length;
    if (projectedBytes > MAX_BACKUP_BYTES / 4) throw new Error('Expanded source evidence exceeds the 16 MiB import budget. Split the dataset into smaller files.');
  }
  const datasetSource = dataset?.provenance?.source === undefined ? '' : string(dataset.provenance.source, 'provenance.source');
  const plays = rows.map((row, index) => {
    try {
      if (!record(row)) throw new Error('play must be an object.');
      const playId = string(row.id, 'id').trim() || id('play');
      const start = numeric(row.start, 'start'), end = numeric(row.end, 'end');
      if (has(row,'shotTime') && has(row,'shot_time') && numeric(row.shotTime,'shotTime') !== numeric(row.shot_time,'shot_time')) throw new Error('Conflicting shotTime and shot_time values.');
      if (has(row,'resultTime') && has(row,'result_time') && numeric(row.resultTime,'resultTime') !== numeric(row.result_time,'result_time')) throw new Error('Conflicting resultTime and result_time values.');
      if (has(row,'made') && has(row,'result') && result(row.made) !== result(row.result)) throw new Error('Conflicting made and result values.');
      const shotValue = row.shotTime ?? row.shot_time;
      const resultValue = row.resultTime ?? row.result_time;
      const missingShot = shotValue === undefined || shotValue === null || shotValue === '';
      const missingResult = resultValue === undefined || resultValue === null || resultValue === '';
      if (missingShot || missingResult) issues.push(issue('warning','ASSUMED_TIMING','Missing shot/result timing defaults to the play end; verify against the video.',playId));
      const xfg = has(row,'xfg') ? row.xfg : (dataset ? row.metrics?.xfg_pct : null);
      if (dataset && !has(row,'xfg') && xfg !== undefined && xfg !== null && dataset.metric_semantics?.xfg_pct !== undefined && dataset.metric_semantics.xfg_pct !== 'shot_make_probability') throw new Error('Dataset xfg_pct semantics are not shot_make_probability.');
      const refs = dataset && row.source_refs !== undefined ? row.source_refs : [];
      if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) throw new Error('source_refs must be an array of strings.');
      const inheritedSource = [source || datasetSource, ...refs].filter(Boolean).join(' · ');
      const notes = dataset && Array.isArray(row.notes) ? row.notes.map(note => string(note, 'notes')).join('\n') : string(row.notes, 'notes');
      const play = {id:playId,start,end,shotTime:missingShot ? end : numeric(shotValue,'shotTime'),resultTime:missingResult ? end : numeric(resultValue,'resultTime'),shooter:string(row.shooter,'shooter'),team:string(row.team ?? (dataset ? row.offense : undefined),'team'),points:numeric(row.points,'points'),made:result(has(row,'made') ? row.made : row.result),tag:string(row.tag ?? (dataset ? row.title : undefined),'tag'),notes,reviewed:false,xfg:numeric(xfg,'xfg',true),x:numeric(row.x,'x',true),y:numeric(row.y,'y',true),source:string(row.source,'source').trim() || inheritedSource};
      if (dataset) play.sourceEvidence = {record:structuredClone(row),metricSemantics:structuredClone(dataset.metric_semantics || {})};
      else if (has(row,'sourceEvidence')) play.sourceEvidence = structuredClone(row.sourceEvidence);
      const known = new Set([...FIELDS,'shot_time','result_time','result','reviewed','sourceEvidence']);
      const unknown = dataset ? [] : Object.keys(row).filter(key=>!known.has(key));
      if (unknown.length) issues.push(issue('warning','IGNORED_FIELDS',`Unrecognized JSON fields were not imported: ${unknown.join(', ')}.`,playId));
      if (play.xfg === null) issues.push(issue('warning','MISSING_XFG','No xFG probability supplied; excluded from expected-points totals.',playId));
      return play;
    } catch (error) { issues.push(issue('error','IMPORT_ROW',`Row ${index + 1}: ${error.message}`)); return null; }
  });
  issues.push(...validatePlays(plays.filter(Boolean), duration));
  fail(issues, 'Import rejected');
  return {plays,issues};
}

export function playerKey(play) { return JSON.stringify([play.team || '', play.shooter || '']); }

export function summarize(plays) {
  const summary = {total:0,attempts:0,made:0,points:0,fgPct:null,efgPct:null,expectedPoints:null,xfgCount:0,reviewed:0,players:[],tags:[]};
  const players = new Map(), tags = new Map(); let threes = 0, expected = 0;
  for (const play of Array.isArray(plays) ? plays : []) {
    if (!record(play)) continue;
    summary.total++;
    const name = typeof play.shooter === 'string' && play.shooter.trim() ? play.shooter : 'Unknown player';
    const key = playerKey(play);
    const player = players.get(key) || {name,team:play.team || '',attempts:0,made:0,points:0,fgPct:null};
    if (play.made === true || play.made === false) { summary.attempts++; player.attempts++; }
    if (play.made === true) { summary.made++; player.made++; if ([2,3].includes(play.points)) { summary.points += play.points; player.points += play.points; } if (play.points === 3) threes++; }
    if (play.reviewed === true) summary.reviewed++;
    if (finite(play.xfg) && play.xfg >= 0 && play.xfg <= 1 && [2,3].includes(play.points)) { summary.xfgCount++; expected += play.xfg * play.points; }
    players.set(key,player);
    if (typeof play.tag === 'string' && play.tag.trim()) tags.set(play.tag,(tags.get(play.tag) || 0) + 1);
  }
  if (summary.attempts) { summary.fgPct = summary.made / summary.attempts; summary.efgPct = (summary.made + .5 * threes) / summary.attempts; }
  if (summary.xfgCount) summary.expectedPoints = expected;
  summary.players = [...players.values()].map(player => ({...player,fgPct:player.attempts ? player.made / player.attempts : null})).sort((a,b) => b.attempts - a.attempts || a.name.localeCompare(b.name));
  summary.tags = [...tags].map(([name,count]) => ({name,count})).sort((a,b) => b.count - a.count || a.name.localeCompare(b.name));
  return summary;
}
export function toCSV(plays) {
  const quote = value => {
    let cell = value === null || value === undefined ? '' : String(value);
    if (/^[\s\uFEFF]*[=+\-@]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replaceAll('"','""')}"`;
  };
  return '\uFEFF' + [FIELDS.map(quote).join(','), ...plays.map(play => FIELDS.map(field => quote(play[field])).join(','))].join('\r\n') + '\r\n';
}
export function demoProject(dataset) {
  assertData(dataset);
  const project = createProject({name:`${dataset.game?.title || 'CourtLens demo'} · 合成演练`,source:`纯合成功能演练；非真实 NBA 数据。${dataset.provenance?.source || ''}`,opponent:dataset.game?.away || ''});
  const video = dataset.video;
  if (!record(video)) throw new Error('Demo dataset has no video metadata.');
  project.video = {id:'bundled-demo-v1',name:'demo.mp4',size:0,duration:video.duration,width:video.width,height:video.height,sha256:video.sha256 || '',url:'media/demo.mp4'};
  project.plays = parseImport(JSON.stringify(dataset),{format:'json',duration:video.duration,source:project.source}).plays;
  project.playlist = project.plays.map(play => ({id:id('clip'),playId:play.id,in:play.start,out:play.end,title:play.tag || play.shooter}));
  fail(validateProject(project),'Invalid demo');
  return project;
}
function portableProject(project) {
  // Explicit field selection keeps future runtime handles and private blobs out of backups.
  const out = Object.fromEntries(['schemaVersion','id','name','scenario','opponent','date','source','createdAt','updatedAt','revision','status','plays','playlist','activity'].map(key => [key,project[key]]));
  if (has(project,'archived')) out.archived = project.archived;
  out.video = project.video === null ? null : Object.fromEntries(['id','name','size','duration','width','height','sha256'].map(key => [key,project.video[key]]));
  if (out.video) {
    if (project.video.url === 'media/demo.mp4') out.video.url = 'media/demo.mp4';
    else { out.video.needsReattach = true; out.status = 'draft'; }
  }
  return JSON.parse(JSON.stringify(out));
}
export function projectBackup(project) {
  fail(validateProject(project),'Cannot back up invalid project');
  return {kind:'courtlens-project',schemaVersion:1,project:portableProject(project)};
}
export function readBackup(text) {
  const backup = readJSON(text, MAX_BACKUP_BYTES, 1);
  if (!record(backup) || backup.kind !== 'courtlens-project' || backup.schemaVersion !== 1 || !record(backup.project)) throw new Error('Not a supported CourtLens project backup (schemaVersion 1).');
  // Validate the supplied revision before generating replacement identity or clearing approval.
  fail(validateProject(backup.project),'Invalid backup');
  const project = portableProject(backup.project);
  project.id = id('project'); project.revision = 0; project.createdAt = now(); project.updatedAt = project.createdAt; project.status = 'draft'; project.archived = false;
  if (project.video && project.video.url !== 'media/demo.mp4') { project.video.id = id('media'); project.video.needsReattach = true; }
  project.plays = project.plays.map(play => ({...play,reviewed:false}));
  project.activity = [{at:project.createdAt,type:'import',message:'Imported portable backup; review and local video binding must be verified.'}];
  fail(validateProject(project),'Invalid restored project');
  return project;
}
