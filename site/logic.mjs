/** Small pure view helpers. Scientific answers are supplied by core.engine. */
export const metricLabels = {xfg_pct:'预期命中概率',gravity:'Gravity',leverage:'回合胜率机会差'};
export const formatPercent = value => value == null ? '缺失' : `${(value * 100).toFixed(1)}%`;
export const formatTime = value => { const n=Math.max(0,Number.isFinite(value)?value:0); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(Math.floor(n)%60).padStart(2,'0')}`; };
export function possessionAt(dataset,time) { return dataset.possessions.find(p => p.start<=time && time<p.end) || (time===dataset.video.duration?dataset.possessions.at(-1):null); }
export function cueAt(analyzed,time) { return analyzed?.cues.find(c => c.start<=time && time<c.end) || null; }
export function trackAt(possession,time) {
  if(!possession) return null;
  const segments=possession.camera_segments;
  const segment=segments.find((s,i)=>s.start<=time&&(time<s.end||(i===segments.length-1&&time===s.end)));
  if(!segment?.calibrated) return null;
  const frames=possession.tracks.filter(f=>segment.start<=f.t&&(f.t<segment.end||f.t===segment.end&&segment.end===possession.end));
  const exact=frames.find(f=>Math.abs(f.t-time)<0.000001);
  if(exact) return exact;
  const left=frames.filter(f=>f.t<time).at(-1),right=frames.find(f=>f.t>time);
  if(!left||!right||right.t-left.t>1) return null;
  const factor=(time-left.t)/(right.t-left.t), map=new Map(right.players.map(p=>[p.id,p]));
  const interpolate=(a,b)=>({x:a.x+(b.x-a.x)*factor,y:a.y+(b.y-a.y)*factor});
  return {t:time,players:left.players.filter(p=>map.has(p.id)).map(p=>({...p,...interpolate(p,map.get(p.id))})),ball:interpolate(left.ball,right.ball)};
}
export function rankingParts(p) {
  const x=p.metrics.xfg_pct,l=p.metrics.leverage;
  return [l==null?0:70*l,x==null?0:20*(1-x),x==null||p.result==='unknown'?0:10*(p.result==='made'?1-x:x)];
}
export function sanitizeState(search,dataset) {
  const q=new URLSearchParams(search);
  return {possessionId:dataset.possessions.some(p=>p.id===q.get('play'))?q.get('play'):dataset.possessions[0].id,audience:q.get('view')==='analyst'?'analyst':'fan'};
}
