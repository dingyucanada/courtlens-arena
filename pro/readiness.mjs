/** Local production gates and rehearsal clock. This never certifies AWS or contest eligibility. */
import {createLocalStoryPlan,verifyStoryPlan} from './story-plan.mjs';
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/i.test(s);
export function localReadiness(project,{narrations={},analyses={},signature=null}={}) {
  const plays=project?.plays||[], selected=project?.playlist?.length?project.playlist.map(c=>plays.find(p=>p.id===c.playId)).filter(Boolean):plays;
  const errors=[];let cues=0,manual=0,unsupported=0;
  for(const p of selected){
    const n=narrations[p.id], a=analyses[p.id],evidence=new Map([...(a?.evidence||[]),n?.eventEvidence].filter(Boolean).map(e=>[e.id,e]));
    for(const c of n?.cues||[]){cues++;if(c.origin==='manual')manual++;if(!c.evidenceIds?.length||c.evidenceIds.some(id=>{const e=evidence.get(id);return !e||e.available===false||(finite(e.t)&&e.t>c.start)||(finite(e.availableAt)&&e.availableAt>c.start);})||!finite(c.start)||!finite(c.end)||c.start<p.start||c.end>p.end||c.end<=c.start)unsupported++;}
    if(!p.reviewed||(signature!==null&&p.reviewSignature!==signature))errors.push(`${p.id} 当前内容尚未复核`);
  }
  const gates=[
    {id:'media',label:'原片指纹',status:hash(project?.video?.sha256)?'pass':'unknown',detail:hash(project?.video?.sha256)?'已保留SHA-256；来源仍按提供者声明':'尚无文件指纹，请绑定对应原片'},
    {id:'identity',label:'回合与事件',status:plays.length&&plays.every(p=>p.id&&finite(p.start)&&finite(p.end)&&p.end>p.start)?'pass':'fail',detail:`${plays.length} 个回合；官方考试身份需在素材到达后核验`},
    {id:'evidence',label:'逐句证据与时间',status:cues&&unsupported===0?(manual?'unknown':'pass'):cues?'fail':'unknown',detail:`${cues} 句，${unsupported} 句缺失或无效引用；${manual} 句人工编辑须校验数值并核对含义`},
    {id:'review',label:'当前制作配置复核',status:selected.length&&!errors.length?'pass':'unknown',detail:errors.join('；')||'当前所选回合已复核'},
    {id:'cloud',label:'正式AWS与Portal',status:'unknown',detail:'环境尚未开放；本地检查不认证指定云、账号、区域或提交'}
  ];
  return {gates,cues,manual,unsupported,localReady:gates.filter(g=>g.id!=='cloud').every(g=>g.status==='pass'),submissionReady:false};
}
/** Run the same bounded content checks as export; a checkbox is not numeric evidence. */
export async function validatedLocalReadiness(project,options={}) {
  const result=localReadiness(project,options),gate=result.gates.find(g=>g.id==='evidence');
  try {
    const plan=await createLocalStoryPlan(project,options);await verifyStoryPlan(plan,project);
    result.storyValidation={valid:true,inputHash:plan.inputHash,contentHash:plan.contentHash};
    if(result.cues&&result.unsupported===0){gate.status='pass';gate.detail+= '；StoryPlan 数值与原始证据校验通过，含义仍由人工复核';}
  } catch(error) {
    result.storyValidation={valid:false,error:error.message};gate.status='fail';gate.detail+=`；${error.message}`;
  }
  result.localReady=result.gates.filter(g=>g.id!=='cloud').every(g=>g.status==='pass');return result;
}
export function beginRehearsal(project,{now=Date.now()}={}) {
  if(!finite(now)||!project?.id)throw new Error('演练时间或项目无效。');
  return {schema:'courtlens-rehearsal/1',projectId:project.id,startedAt:new Date(now).toISOString(),startedRevision:project.revision,milestones:[],scope:'local-rehearsal',officialCloudVerified:false};
}
export function rehearsalStatus(run,{now=Date.now()}={}) {
  const start=Date.parse(run?.startedAt);if(!finite(start)||!finite(now)||now<start)throw new Error('演练时钟无效，系统时间不能倒退。');
  const elapsed=(now-start)/60000;
  const trigger=elapsed>=120?'截止检查':elapsed>=90?'核对发布版本':elapsed>=70?'停用失败的配音与漂移图层':elapsed>=50?'保留最有证据的事件':'核对输入并编排故事';
  return {elapsedMinutes:elapsed,remainingMinutes:Math.max(0,120-elapsed),trigger,within90:elapsed<=90};
}
export function recordMilestone(run,{name,revision,outputHash=null,note='',now=Date.now()}={}) {
  const status=rehearsalStatus(run,{now});if(!['input','plan','render','independent-review','local-release','submission-check'].includes(name)||!Number.isSafeInteger(revision)||revision<0)throw new Error('演练阶段或修订号无效。');
  if(outputHash!==null&&!hash(outputHash))throw new Error('输出哈希无效。');
  if(['render','local-release'].includes(name)&&!outputHash)throw new Error('成片或发布阶段需要实际输出哈希。');
  return {...structuredClone(run),milestones:[...run.milestones,{name,revision,outputHash,note:String(note).slice(0,500),at:new Date(now).toISOString(),elapsedMinutes:status.elapsedMinutes}]};
}
