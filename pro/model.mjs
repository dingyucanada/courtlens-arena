/** Browser data contract. Supplied values keep their definitions and missingness. */
import { METRICS_SCHEMA, adaptMetricBundle, validateAdaptedMetrics } from './metrics-v2.mjs';
export const VERSION = 'courtlens-arena/1';
export const LIMITS = Object.freeze({bytes:16*1024*1024,plays:2000,frames:120000,framesPerPlay:10000,players:20,playSeconds:600,video:512*1024*1024});
const number = value => typeof value==='number' && Number.isFinite(value);
const object = value => value!==null && typeof value==='object' && !Array.isArray(value);
const own = (value,key) => value!==null && typeof value==='object' && Object.prototype.hasOwnProperty.call(value,key);
const copy = value => structuredClone(value);
const text = (value,fallback='') => String(value??fallback).slice(0,1200);
const id = () => globalThis.crypto?.randomUUID?.() || `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const DEFAULT_SOURCE = Object.freeze({kind:'user',label:'用户提供素材',source:''});

export function newProject(name='未命名比赛') {
  return {schema:VERSION,id:id(),name:text(name),revision:0,provenance:{...DEFAULT_SOURCE},video:null,plays:[],calibrations:[],playlist:[],notes:[],activity:[],updatedAt:new Date().toISOString()};
}

export function normalizeMetric(raw,key,source={},definitions={}) {
  if(raw===null || raw===undefined || raw==='') return null;
  // A provider record is copied, including a null value and unknown metadata.
  if(object(raw)) return copy(raw);
  if(!number(raw)) throw new Error(`${key} 必须是有限数字或带口径的指标对象。`);
  const known={xfg_pct:'shot_make_probability',gravity:'supplied_metric',leverage:'unknown'};
  const semantic=own(known,key)?known[key]:'unknown';
  return {value:raw,semantics:own(definitions.semantics,key)?definitions.semantics[key]:semantic,unit:key==='xfg_pct'?'probability':'source unit',definition:own(definitions.labels,key)?definitions.labels[key]:'',provenance:{kind:source.kind||'user',source:source.source||'用户导入'}};
}

function optionalArray(value,label) {
  if(value!==undefined && !Array.isArray(value)) throw new Error(`${label} 须为数组。`);
}
function validateVideo(video) {
  if(video===null || video===undefined) return;
  if(!object(video)) throw new Error('视频信息须为对象。');
  if(own(video,'duration') && (!number(video.duration)||video.duration<=0)) throw new Error('视频时长须为正的有限秒数。');
  for(const key of ['width','height']) if(own(video,key) && (!number(video[key])||video[key]<=0)) throw new Error('视频尺寸须为正的有限数字。');
  if(own(video,'size') && (!number(video.size)||video.size<=0||video.size>LIMITS.video)) throw new Error('视频文件大小无效或超过 512 MiB。');
}

/** The editor and renderer share one clock; only explicitly relative tracks convert. */
function toVideoClock(play) {
  const base=play.tracking?.timeBase;
  if(base===undefined||base==='video') return play;
  if(base!=='possession') throw new Error(`${play.id} 轨迹时间基准未知，请先映射为视频秒。`);
  if(!number(play.start)||!number(play.end)) throw new Error(`${play.id} 的起止秒数无效。`);
  // tracking.timeBase describes court tracks; screenTracks always have their own video clock.
  for(const key of ['tracks']) if(Array.isArray(play[key])) play[key]=play[key].map(frame=>{
    if(!object(frame)||!number(frame.t)||frame.t<0||frame.t>play.end-play.start) throw new Error(`${play.id} 回合相对轨迹时间无效。`);
    return {...frame,t:play.start+frame.t};
  });
  play.tracking={...play.tracking,timeBase:'video',sourceTimeBase:'possession'};
  return play;
}

export function validateProject(project) {
  if(!object(project) || project.schema!==VERSION || !Array.isArray(project.plays)) throw new Error('不是 CourtLens Arena 项目。');
  if(typeof project.id!=='string'||!project.id.trim()||project.id.length>500) throw new Error('项目 ID 须为 1–500 字符。');
  if(typeof project.name!=='string'||!project.name.trim()||project.name.length>300) throw new Error('比赛名称须为 1–300 字。');
  if(!Number.isSafeInteger(project.revision)||project.revision<0) throw new Error('项目修订号须为非负整数。');
  for(const key of ['calibrations','playlist','notes','activity']) optionalArray(project[key],key);
  if(project.provenance!==undefined && !object(project.provenance)) throw new Error('项目来源须为对象。');
  validateVideo(project.video);
  if(project.plays.length>LIMITS.plays) throw new Error(`回合数量超过 ${LIMITS.plays}。`);
  let frames=0; const ids=new Set(),playsById=new Map();
  for(const p of project.plays) {
    if(!object(p)||typeof p.id!=='string'||!p.id.trim()||p.id.length>120||ids.has(p.id)) throw new Error('回合 ID 须为 1–120 字符且唯一。');
    ids.add(p.id); playsById.set(p.id,p);
    if(!number(p.start)||!number(p.end)||p.start<0||p.end<=p.start||p.end-p.start>LIMITS.playSeconds) throw new Error(`${p.id} 的起止秒数无效，单回合最多 600 秒。`);
    if(number(project.video?.duration) && p.end>project.video.duration+0.05) throw new Error(`${p.id} 超出视频时长。`);
    if(p.shotTime!=null && (!number(p.shotTime)||p.shotTime<p.start||p.shotTime>p.end)) throw new Error(`${p.id} 出手时间不在回合内。`);
    if(p.resultTime!=null && (!number(p.resultTime)||p.resultTime<p.start||p.resultTime>p.end||(p.shotTime!=null&&p.resultTime<p.shotTime))) throw new Error(`${p.id} 结果时间无效。`);
    for(const [canonical,alias] of [['shotTime','shot_time'],['resultTime','result_time']]) if(own(p,alias)) {
      if(p[alias]!=null&&(!number(p[alias])||p[alias]<p.start||p[alias]>p.end)) throw new Error(`${p.id} ${alias} 时间无效。`);
      if(own(p,canonical)&&p[canonical]!==p[alias]) throw new Error(`${p.id} ${canonical} 与旧字段 ${alias} 冲突，请先统一时间。`);
    }
    if(p.shotValue!=null && ![2,3].includes(p.shotValue)) throw new Error(`${p.id} 投篮分值仅支持 2 或 3。`);
    if(!['made','missed','unknown'].includes(p.outcome)) throw new Error(`${p.id} 结果须为 made、missed 或 unknown。`);
    if(p.metrics!==undefined && !object(p.metrics)) throw new Error(`${p.id} 指标须为对象。`);
    if(p.tracking!==undefined&&!object(p.tracking)) throw new Error(`${p.id} 轨迹口径须为对象。`);
    if(p.tracking?.timeBase!==undefined&&!['video','possession'].includes(p.tracking.timeBase)) throw new Error(`${p.id} 轨迹须声明视频秒或回合经过秒。`);
    for(const v of Object.values(p.metrics||{})) {
      if(v===null) continue;
      if(!object(v)||!own(v,'value')||(v.value!==null&&!number(v.value))||typeof v.semantics!=='string'||!v.semantics.trim()) throw new Error(`${p.id} 指标须包含有限数字或 null 的 value 与 semantics。`);
      for(const key of ['availableAt','time','t']) if(!(key==='time'&&project.metricAdapter&&v.schema===METRICS_SCHEMA)&&v[key]!=null && (!number(v[key])||v[key]<0)) throw new Error(`${p.id} 指标的提供时间无效。`);
    }
    for(const key of ['annotations','cameraSegments','sourceRefs','notes']) optionalArray(p[key],`${p.id} ${key}`);
    for(const list of [p.tracks,p.screenTracks]) {
      if(list===undefined) continue;
      if(!Array.isArray(list)) throw new Error(`${p.id} 轨迹须为数组。`);
      if(list.length>LIMITS.framesPerPlay) throw new Error(`${p.id} 单回合轨迹超过 10000 帧，请先重采样。`);
      frames+=list.length;
      if(frames>LIMITS.frames) throw new Error('轨迹采样超出容量；请按单场分段导入。');
      for(const f of list) {
        if(!object(f)||!number(f.t)||f.t<0||!Array.isArray(f.players)||f.players.length>LIMITS.players||f.players.some(r=>!object(r)||typeof r.id!=='string'||!r.id.trim()||r.id.length>120||!number(r.x)||!number(r.y))) throw new Error(`${p.id} 轨迹记录无效。`);
      }
    }
  }
  for(const item of project.playlist||[]) {
    const p=object(item)&&playsById.get(item.playId);
    if(!p) throw new Error('片单包含不存在的回合。');
    const start=item.start??p.start,end=item.end??p.end;
    if(!number(start)||!number(end)||start<p.start||end>p.end||end<=start) throw new Error(`${p.id} 片段范围无效。`);
  }
  validateAdaptedMetrics(project);
  return true;
}

export function fromLegacy(data) {
  if(!object(data)||!Array.isArray(data.possessions)) throw new Error('比赛数据需要 possessions 数组。');
  const project=newProject(data.game?.title||'导入的比赛');
  project.provenance=copy(data.provenance||{kind:'user',label:'用户导入',source:''});
  project.video=data.video?copy(data.video):null;
  if(typeof project.video?.url==='string') project.video.url=project.video.url.replace(/^\//,'');
  project.metricDictionary=copy(data.metric_definitions||{});
  project.metricSemantics=copy(data.metric_semantics||{});
  project.sourceGame=copy(data.game||{});
  project.plays=data.possessions.map(p=>{
    if(!object(p)) throw new Error('逐回合记录须为对象。');
    if(p.metrics!==undefined&&!object(p.metrics)) throw new Error('回合指标须为对象。');
    if(p.metric_records!==undefined&&!object(p.metric_records)) throw new Error('指标口径记录须为对象。');
    const supplied={...p.metrics,...p.metric_records};
    return toVideoClock({id:p.id,title:text(p.title,p.id),start:p.start,end:p.end,shotTime:p.shot_time??null,resultTime:p.result_time??null,clock:text(p.clock),team:text(p.offense),player:text(p.shooter),shotValue:p.points??null,outcome:['made','missed'].includes(p.result)?p.result:'unknown',
      metrics:Object.fromEntries(Object.entries(supplied).map(([key,v])=>[key,normalizeMetric(v,key,project.provenance,{semantics:project.metricSemantics,labels:project.metricDictionary})])),
      tracking:copy(p.tracking||{kind:'unverified',units:'normalized',coordinateSystem:'image',timeBase:'video',maxGap:0.75}),tracks:copy(p.court_tracks??[]),screenTracks:copy(p.tracks??[]),annotations:copy(p.annotations??[]),cameraSegments:copy(p.camera_segments??[]),sourceRefs:copy(p.source_refs??[]),notes:copy(p.notes??[]),sourceRecord:copy(p),reviewed:false,
      ...(own(p,'calibration')?{calibration:copy(p.calibration)}:{}),...(own(p,'provenance')?{provenance:copy(p.provenance)}:{})});
  });
  validateProject(project); return project;
}

/** Only the self-generated fixture has a known invertible renderer, not arbitrary footage. */
export function rehearsalProject(data) {
  const project=fromLegacy(data); project.id='arena-rehearsal'; project.name='HOU × DAL · 观赛演练';
  project.video={...project.video,url:'media/demo.mp4'};
  project.plays.forEach((p,i)=>{
    p.title=['一次不容易的三分选择','好机会，为什么仍会投丢？','无球移动值得怎样被看见？'][i]||p.title;
    p.tracking={kind:'schematic',units:'ft',coordinateSystem:'court',timeBase:'video',court:{length:47,width:50},basket:{x:25,y:41.125},maxGap:0.75,source:'自行生成的球场示意坐标，非 NBA 测量'};
    p.tracks=p.screenTracks.map(f=>({t:f.t,players:f.players.map(r=>{const v=(r.y-.2)/.64;return {...r,name:r.id,x:((r.x-.5)/(.44+.36*v)+.5)*50,y:(1-v)*47};}),ball:null}));
    p.reviewed=false;
    Object.values(p.metrics).forEach(m=>{if(m)m.availableAt=p.shotTime;});
  });
  validateProject(project); return project;
}

function csvRows(input) {
  const rows=[]; let row=[],field='',quoted=false,closed=false;
  const finishField=()=>{row.push(field);field='';closed=false;};
  const finishRow=()=>{finishField();if(row.some(v=>v.trim()))rows.push(row);row=[];};
  input=input.replace(/^\uFEFF/,'');
  for(let i=0;i<input.length;i++) {
    const c=input[i];
    if(quoted) {
      if(c==='"') {if(input[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}
      else field+=c;
    } else if(c===',') finishField();
    else if(c==='\n'||c==='\r') {if(c==='\r'&&input[i+1]==='\n')i++;finishRow();}
    else if(closed) throw new Error('CSV 已闭合引号后只能接逗号或换行。');
    else if(c==='"') {if(field.length)throw new Error('CSV 引号须位于字段开头。');quoted=true;}
    else field+=c;
  }
  if(quoted) throw new Error('CSV 引号未闭合。');
  finishRow(); return rows;
}

function toNumber(value) {
  if(value===null||value===undefined||typeof value==='string'&&!value.trim()) return null;
  if(number(value)) return value;
  if(typeof value==='string'&&/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) {
    const result=Number(value); if(number(result)) return result;
  }
  throw new Error('秒数与指标必须是有限数字；布尔值不是测量值。');
}

/** Fill only absent editor containers; malformed present fields still fail validation. */
function normalizeBackup(parsed) {
  const project=copy(parsed);
  for(const key of ['calibrations','playlist','notes','activity']) if(!own(project,key)) project[key]=[];
  if(!own(project,'revision')) project.revision=0;
  if(!own(project,'video')) project.video=null;
  if(!own(project,'provenance')) project.provenance={...DEFAULT_SOURCE};
  if(object(project.provenance)) project.provenance={...DEFAULT_SOURCE,...project.provenance};
  if(!own(project,'updatedAt')) project.updatedAt=new Date().toISOString();
  if(Array.isArray(project.plays)) project.plays=project.plays.map(p=>{
    if(!object(p)) return p;
    const play=copy(p);
    for(const [canonical,alias] of [['shotTime','shot_time'],['resultTime','result_time']]) if(own(play,alias)) {
      if(!own(play,'sourceRecord')) play.sourceRecord=copy(p);
      if(!own(play,canonical)) play[canonical]=toNumber(play[alias]);
      delete play[alias];
    }
    for(const key of ['tracks','screenTracks','annotations','cameraSegments','sourceRefs','notes']) if(!own(play,key)) play[key]=[];
    if(!own(play,'metrics')) play.metrics={};
    if(!own(play,'tracking')) play.tracking={kind:'unverified',coordinateSystem:'unknown'};
    if(!own(play,'reviewed')) play.reviewed=false;
    if(play.tracking?.timeBase==='possession'&&!own(play,'sourceRecord')) play.sourceRecord=copy(p);
    return toVideoClock(play);
  });
  validateProject(project); return project;
}

export function parseInput(input,filename='',mapping={}) {
  if(typeof input!=='string') throw new Error('数据文件须为文本。');
  if(new TextEncoder().encode(input).length>LIMITS.bytes) throw new Error('数据文件超过 16 MiB。');
  let parsed;
  if(/\.csv$/i.test(filename)) {
    const rows=csvRows(input);if(rows.length<2)throw new Error('CSV 需要表头与记录。');const headers=rows.shift().map(s=>s.trim());
    if(headers.some(h=>!h)||new Set(headers).size!==headers.length)throw new Error('CSV 表头不可空或重复。');
    parsed={plays:rows.map((row,index)=>{if(row.length!==headers.length)throw new Error(`CSV 第 ${index+2} 条记录列数不一致。`);return Object.fromEntries(headers.map((h,i)=>[h,row[i]]));})};
  } else {try{parsed=JSON.parse(input);}catch{throw new Error('无法解析 JSON。');}}
  if(!object(parsed)&&!Array.isArray(parsed)) throw new Error('JSON 需要 plays 或 possessions 数组。');
  if(parsed.schema===VERSION){const project=normalizeBackup(parsed);return {project,kind:'backup',summary:summarize(project)};}
  let metricAdapter=null;
  if(parsed.schema===METRICS_SCHEMA){const adapted=adaptMetricBundle(parsed);parsed=adapted.input;metricAdapter=adapted.metricAdapter;}
  else if(typeof parsed.schema==='string'&&parsed.schema.startsWith('courtlens-metrics/')) throw new Error('不支持的指标适配版本；需要 courtlens-metrics/2。');
  if(Array.isArray(parsed.possessions)){const project=fromLegacy(parsed);return {project,kind:'legacy',summary:summarize(project)};}
  if(parsed.schemaVersion && Array.isArray(parsed.plays) && parsed.sourceEvidence) throw new Error('请使用原始逐回合 JSON；Studio 的备份格式请在 Studio v3 打开。');
  const records=Array.isArray(parsed)?parsed:parsed.plays;
  if(!Array.isArray(records))throw new Error('JSON 需要 plays 或 possessions 数组。');
  if(!records.length)throw new Error('没有回合记录。');if(records.length>LIMITS.plays)throw new Error('回合数量超过容量。');
  const project=newProject(parsed.name||filename.replace(/\.[^.]+$/,'')||'导入比赛');
  project.provenance={kind:'user',label:'用户提供数据',source:filename,...copy(parsed.provenance||{})};
  project.metricSemantics=copy(parsed.metricSemantics??parsed.metric_semantics??{});
  project.metricDictionary=copy(parsed.metricDictionary??parsed.metric_definitions??{});
  if(metricAdapter)project.metricAdapter=metricAdapter;
  project.plays=records.map((r,index)=>{
    if(!object(r)) throw new Error(`第 ${index+1} 条回合记录须为对象。`);
    // Presence, rather than truthiness, selects a field. Explicit null is final.
    const get=(key,...aliases)=>{for(const name of [...new Set([mapping[key],key,...aliases].filter(Boolean))])if(own(r,name))return r[name];return undefined;};
    if(r.metrics!==undefined&&!object(r.metrics)) throw new Error('回合指标须为对象。');
    const rawMetrics=r.metrics||{},entries=Object.entries(rawMetrics);
    for(const key of ['xfg_pct','difficulty','gravity','leverage'])if(!own(rawMetrics,key)){const v=get(key);if(v!==undefined)entries.push([key,v]);}
    const metrics=Object.fromEntries(entries.map(([key,v])=>[key,normalizeMetric(object(v)?v:toNumber(v),key,project.provenance,{semantics:project.metricSemantics,labels:project.metricDictionary})]));
    const result=get('outcome','result');
    const play={id:text(get('id')||`p${index+1}`),title:text(get('title')||`回合 ${index+1}`),start:toNumber(get('start','start_seconds')),end:toNumber(get('end','end_seconds')),shotTime:toNumber(get('shotTime','shot_time')),resultTime:toNumber(get('resultTime','result_time')),clock:text(get('clock')),team:text(get('team','offense')),player:text(get('player','shooter')),shotValue:toNumber(get('shotValue','points')),outcome:['made','missed'].includes(result)?result:'unknown',metrics,
      tracking:copy(r.tracking??parsed.tracking??{kind:'unverified',coordinateSystem:'unknown'}),tracks:copy(r.tracks??[]),screenTracks:copy(r.screenTracks??r.screen_tracks??[]),annotations:copy(r.annotations??[]),cameraSegments:copy(r.cameraSegments??r.camera_segments??[]),sourceRefs:copy(r.sourceRefs??r.source_refs??[filename]),notes:copy(r.notes??[]),sourceRecord:copy(metricAdapter?r.sourceRecord??r:r),reviewed:false};
    for(const key of ['calibration','provenance','playerId','period','seasonId','shotId','eventIds','metricProvenance','metricUnits','metricRecords','metricBindings']) if(own(r,key)) play[key]=copy(r[key]);
    return toVideoClock(play);
  });
  project.video=parsed.video?copy(parsed.video):null;validateProject(project);return {project,kind:metricAdapter?'metrics-v2':'records',summary:summarize(project)};
}

export function summarize(project) {
  return {plays:project.plays.length,unknown:project.plays.filter(p=>p.outcome==='unknown').length,tracking:project.plays.filter(p=>p.tracks?.length).length,metrics:project.plays.filter(p=>Object.values(p.metrics||{}).some(m=>number(m?.value))||p.metricRecords?.some(m=>number(m.value))).length,duration:Math.max(0,...project.plays.map(p=>p.end))};
}

export function datasetForLegacy(project) {
  validateProject(project);
  if(project.metricAdapter)throw new Error('指标 v2 包含多粒度／时序字典，旧格式无法完整表达；请导出 Arena 项目备份。');
  const semantics=copy(project.metricSemantics||{}),definitions=copy(project.metricDictionary||{});
  for(const p of project.plays) for(const [key,record] of Object.entries(p.metrics||{})) {
    if(record===null) continue;
    if(own(semantics,key)&&semantics[key]!==record.semantics) throw new Error(`${key} 的口径不同，不能合并为同一个旧版字段；请导出 Arena 项目。`);
    semantics[key]=record.semantics;
    if(!own(definitions,key)&&record.definition) definitions[key]=copy(record.definition);
  }
  return {schema_version:'1.0',provenance:copy(project.provenance),game:{...copy(project.sourceGame||{}),title:project.name},video:copy(project.video),metric_semantics:semantics,metric_definitions:definitions,
    possessions:project.plays.map(p=>({...copy(p.sourceRecord||{}),id:p.id,title:p.title,start:p.start,end:p.end,shot_time:p.shotTime??null,result_time:p.resultTime??null,clock:p.clock,offense:p.team,shooter:p.player,result:p.outcome,points:p.shotValue??null,
      metrics:Object.fromEntries(Object.entries(p.metrics||{}).map(([key,v])=>[key,v?.value??null])),metric_records:copy(p.metrics||{}),tracks:copy(p.screenTracks||[]),court_tracks:copy(p.tracks||[]),tracking:copy(p.tracking),annotations:copy(p.annotations||[]),camera_segments:copy(p.cameraSegments||[]),source_refs:copy(p.sourceRefs||[]),notes:copy(p.notes||[]),...(own(p,'calibration')?{calibration:copy(p.calibration)}:{})}))};
}

export function exportProject(project) {validateProject(project);return JSON.stringify(project,null,2);}
export const escapeHTML = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
