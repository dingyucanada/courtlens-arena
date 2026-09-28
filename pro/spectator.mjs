/** Audience-first story selection. All time filtering uses source-video seconds. */
import {selectBoundMetric,metricTransforms} from './metrics-v2.mjs';
const finite = n => typeof n === 'number' && Number.isFinite(n);
const unique = xs => [...new Set(xs)];
export function coreQuestion(play, analysis) {
  if (typeof play?.question === 'string' && play.question.trim()) return play.question.trim().slice(0,160);
  if (analysis?.metrics?.difficulty?.available) return '这次出手，到底难在哪里？';
  if (analysis?.temporal?.opportunityWindows?.length) return '跑动之后，空间发生了什么变化？';
  return '这一球，为什么这样打？';
}
export function storyBeats(play,narration,analysis,{limit=3}={}) {
  if(!play || !Array.isArray(narration?.cues)) return [];
  const evidence=new Map([...(analysis?.evidence||[]),narration.eventEvidence].filter(Boolean).map(e=>[e.id,e]));
  const valid=narration.cues.filter(c=>finite(c.start)&&finite(c.end)&&c.start>=play.start&&c.end<=play.end&&c.end>c.start&&typeof c.text==='string'&&c.text.trim()&&Array.isArray(c.evidenceIds)&&c.evidenceIds.length&&c.evidenceIds.every(id=>{
    const e=evidence.get(id);return e&&e.available!==false&&(!finite(e.availableAt)||e.availableAt<=c.start)&&(!finite(e.t)||e.t<=c.start);
  }));
  // A few real moments, never fabricate a required three-act tactical pattern.
  const meaningful=valid.filter(c=>!c.evidenceIds.every(id=>id===narration.eventEvidence?.id));
  const candidates=meaningful.length?meaningful:valid;
  const chosen=candidates.length<=limit?candidates:[candidates[0],candidates[Math.floor((candidates.length-1)/2)],candidates.at(-1)].slice(0,limit);
  return chosen.map((c,i)=>({id:`${play.id}:beat:${i}`,start:c.start,end:c.end,text:c.text,evidenceIds:unique(c.evidenceIds),origin:c.origin||'evidence-engine',label:c.origin==='manual'?'人工复核讲解':i===0?'观察变化':i===chosen.length-1?'看见结果':'理解选择'}));
}
export function activeBeat(beats,t) {return finite(t)?beats.find(b=>t>=b.start&&t<b.end)||null:null;}
export function activeMetric(analysis,t,{key=null,play=null}={}) {
  if(!finite(t)) return null;
  // An end-of-possession analysis cannot choose the metric for an earlier frame.
  // Reuse the adapter's authoritative scope/time selector, including null updates.
  const metrics=Array.isArray(play?.metricRecords)?Object.fromEntries(['difficulty','gravity','leverage'].map(role=>{
    const {record}=selectBoundMetric(play,role,t);
    return [role,record?{...record,...metricTransforms(record),key:role}:null];
  })):analysis?.metrics||{};
  const entries=Object.entries(metrics).filter(([,m])=>m?.available&&finite(m.value)&&finite(m.availableAt)&&m.availableAt<=t&&(!finite(m.time?.validFrom)||t>=m.time.validFrom)&&(!finite(m.time?.validTo)||t<m.time.validTo));
  if(key) return entries.find(([k])=>k===key)?.[1]||null;
  // At most one main metric; prefer the most recently available value.
  return entries.sort((a,b)=>b[1].availableAt-a[1].availableAt||['difficulty','gravity','leverage'].indexOf(a[0])-['difficulty','gravity','leverage'].indexOf(b[0]))[0]?.[1]||null;
}
export function primaryMetricText(metric) {
  if(!metric||!finite(metric.value))return '—';
  if(finite(metric.probability))return `${(metric.probability*100).toFixed(1)}%`;
  if(metric.unit==='percent')return `${metric.value.toFixed(1)}%`;
  if(metric.unit==='probability'&&['shot_make_probability','official_xfg','possession_win_probability_opportunity'].includes(metric.semantics)&&metric.value>=0&&metric.value<=1)return `${(metric.value*100).toFixed(1)}%`;
  return `${metric.value.toFixed(2)} ${metric.unit||'来源单位'}`;
}
