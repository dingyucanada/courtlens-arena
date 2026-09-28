import {escapeHTML as h} from './model.mjs';
const finite = value => typeof value==='number' && Number.isFinite(value);

export function timestamp(seconds) {
  if(!finite(seconds)||seconds<0) throw new Error('视频时间须为非负有限秒数。');
  const ms=Math.round(seconds*1000);
  if(!Number.isSafeInteger(ms)) throw new Error('视频时间超过可表示范围。');
  return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}

/** Clip only valid source cues, then translate every output time to the film clock. */
export function playlistPlan(project,narrations={}) {
  if(!Array.isArray(project?.plays)||project.playlist!==undefined&&!Array.isArray(project.playlist)) throw new Error('比赛回合与片单须为数组。');
  let offset=0; const cues=[],clips=[];
  for(const item of project.playlist||[]) {
    const p=project.plays.find(p=>p.id===item?.playId);
    if(!p) throw new Error('片单包含不存在的回合。');
    const start=item.start??p.start,end=item.end??p.end;
    if(!finite(p.start)||!finite(p.end)||p.start<0||p.end<=p.start||!finite(start)||!finite(end)||start<p.start||end>p.end||end<=start) throw new Error(`${p.id} 片段范围无效。`);
    const sourceCues=narrations[p.id]?.cues??[];
    if(!Array.isArray(sourceCues)) throw new Error(`${p.id} 解说字幕须为数组。`);
    clips.push({playId:p.id,start,end,outputStart:offset,outputEnd:offset+end-start});
    for(const c of sourceCues) {
      if(!c||!finite(c.start)||!finite(c.end)||c.start<p.start||c.end>p.end||c.end<=c.start||typeof c.text!=='string') throw new Error(`${p.id} 解说时间或文字无效，请先核对原始画面锚点。`);
      const a=Math.max(start,c.start),b=Math.min(end,c.end);
      if(b<=a) continue;
      const cue={...structuredClone(c),start:offset+a-start,end:offset+b-start,sourceStart:a,sourceEnd:b,playId:p.id};
      if(c.relativeStart!==undefined) cue.relativeStart=cue.start;
      if(c.relativeEnd!==undefined) cue.relativeEnd=cue.end;
      cues.push(cue);
    }
    offset+=end-start;
    if(!finite(offset)) throw new Error('成片总时长无效。');
  }
  return {clips,cues,duration:offset};
}

export function vtt(plan) {
  if(!plan||!finite(plan.duration)||plan.duration<0||!Array.isArray(plan.cues)) throw new Error('字幕需要有效成片时长与字幕数组。');
  let previous=-Infinity;
  const records=plan.cues.map((c,i)=>{
    if(!c||!finite(c.start)||!finite(c.end)||c.start<0||c.end<=c.start||c.end>plan.duration||c.start<previous||typeof c.text!=='string') throw new Error('字幕时间或文字无效，无法生成 WebVTT。');
    previous=c.start;
    if(Math.round(c.end*1000)<=Math.round(c.start*1000)) throw new Error('字幕间隔小于一毫秒，无法生成 WebVTT。');
    // Payload is literal text. It cannot create VTT tags, new cues or timestamp lines.
    const caption=c.text.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/[\u2028\u2029]/g,' ').replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
    return `${i+1}\n${timestamp(c.start)} --> ${timestamp(c.end)}\n${caption}\n`;
  });
  return 'WEBVTT\n\n'+records.join('\n');
}

export function report(project,analyses={},narrations={}) {
  const evidenceTime=t=>finite(t)&&t>=0?timestamp(t):'未提供';
  const sections=(project.plays||[]).map(p=>{
    const analysis=analyses[p.id],narration=narrations[p.id],cues=Array.isArray(narration?.cues)?narration.cues:[];
    const prose=cues.length?cues.map(c=>c.text).join(' '):narration?.text;
    const captions=cues.map(c=>{
      const manual=c.origin==='manual';
      const label=manual?'人工编辑 · 未自动认证':c.origin==='evidence-engine'?'本地证据引擎':'来源未标记';
      const refs=Array.isArray(c.evidenceIds)?c.evidenceIds.join('、'):'';
      return `<li><small>${h(evidenceTime(c.start))} → ${h(evidenceTime(c.end))} · ${h(label)}</small><p>${h(c.text)}</p><small>候选证据引用：${h(refs||'未提供')}。${manual?'保留引用不等于证据能够支持改写后的文句。':''}</small>${manual&&typeof c.originalText==='string'?`<details><summary>查看原引擎文句</summary><p>${h(c.originalText)}</p></details>`:''}</li>`;
    }).join('');
    const rows=(analysis?.evidence||[]).slice(0,30).map(e=>`<tr><td>${h(e.field)}</td><td>${h(typeof e.value==='object'?JSON.stringify(e.value):e.value)} ${h(e.unit)}</td><td>${h(e.kind)}</td><td>${h(evidenceTime(e.t))}</td></tr>`).join('');
    return `<section><h2>${h(p.title)} <small>${h(p.id)} · ${h(p.clock)}</small></h2><p>${h(prose)}</p>${captions?`<h3>逐句画面锚点与编写来源</h3><ol>${captions}</ol>`:''}<table><tr><th>证据字段</th><th>值</th><th>来源类型</th><th>视频时间</th></tr>${rows}</table><p>${h((analysis?.warnings||[]).join('；'))}</p></section>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${h(project.name)} · CourtLens 比赛故事</title><style>body{font:16px/1.8 system-ui;max-width:900px;margin:45px auto;color:#15243b;padding:20px}h1{font-size:38px}h2{border-top:4px solid #17408b;padding-top:18px}small{color:#55647b}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}blockquote{border-left:4px solid #c9082a;padding:12px;background:#f5f7fa}li{margin:12px 0}li p{margin:3px 0}@media print{section{break-inside:avoid}}</style><h1>${h(project.name)}</h1><p>CourtLens Arena · v4.0 · 项目修订 ${h(project.revision)}</p><blockquote>${h(project.provenance?.label)} · ${h(project.provenance?.source)}。原指标按来源口径保留；来源声明不是软件认证。几何派生不等于官方 Gravity；投篮结果不证明选择优劣。人工编辑的文句须独立复核，不计为引擎自动验证。</blockquote>${sections}<footer>本报告以项目数据、本地分析与标明来源的文句生成。官方素材接入后的准确性须另行实测。</footer></html>`;
}

export function download(name,content,type='text/plain;charset=utf-8') {
  const blob=content instanceof Blob?content:new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);
}
