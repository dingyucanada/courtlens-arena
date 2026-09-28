/** A bounded, explicit trust boundary between imported data and model tool calls. */
import {queryEvidence} from './analytics.mjs';
const EVIDENCE_KEYS=['id','playId','t','field','value','unit','kind','source','definition','start','end','available'];
const pick=(object,keys)=>Object.fromEntries(keys.filter(key=>object[key]!==undefined).map(key=>[key,object[key]]));
export function agentPayload(plays,analyses,narrations,{question,audience='fan',provider='ollama'}={}){
  const query=queryEvidence(plays,question),wanted=new Set(query.matches.map(m=>m.playId));
  const candidates=plays.filter(p=>wanted.has(p.id)).slice(0,8);
  if(!candidates.length)throw new Error('没有找到与问题对应的回合证据。请指定球员、回合或指标。');
  const packed=candidates.map(p=>{
    const a=analyses[p.id],n=narrations[p.id];
    const claims=n.claims.filter(c=>c.evidenceIds?.length).slice(0,12).map(c=>({id:c.id,text:c.text,evidenceIds:c.evidenceIds,start:c.t,end:n.cues.find(cue=>cue.start===c.t)?.end??Math.min(p.end,c.t+3)}));
    const referenced=new Set(claims.flatMap(c=>c.evidenceIds));
    const evidence=a.evidence.filter(e=>referenced.has(e.id)).map(e=>pick(e,EVIDENCE_KEYS));
    return {playId:p.id,title:p.title,start:p.start,end:p.end,evidence,claims};
  });
  const payload={question,audience,provider,plays:packed};
  if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>95000)throw new Error('相关证据超过单次模型调用范围。请缩小到具体球员或回合。');
  return payload;
}
