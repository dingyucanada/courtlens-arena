/** Portable, provider-neutral editorial proposals. Validation is not video inference. */
import {analyzePossession, buildNarration} from './analytics.mjs';

export const STORY_PLAN_SCHEMA = 'courtlens-story-plan/1';
export const STORY_PLAN_LIMITS = Object.freeze({bytes:24*1024*1024, clips:100, cues:1000, arrows:500, text:1200, references:32, prompt:16000, history:100});
const stringSchema={type:'string',minLength:1,maxLength:160};
const referenceSchema={type:'array',minItems:1,maxItems:32,uniqueItems:true,items:stringSchema};
/** The same proposal contract can be sent to any structured-output provider. */
export const STORY_PLAN_PROPOSAL_SCHEMA=Object.freeze({type:'object',additionalProperties:false,required:['title','clips','cues'],properties:{
  title:{type:'string',minLength:1,maxLength:300},
  clips:{type:'array',minItems:1,maxItems:100,items:{type:'object',additionalProperties:false,required:['playId','start','end'],properties:{playId:stringSchema,start:{type:'number',minimum:0},end:{type:'number',minimum:0}}}},
  cues:{type:'array',maxItems:1000,items:{type:'object',additionalProperties:false,required:['id','clipIndex','playId','start','end','text','evidenceIds','playerIds','facts','origin','basisStart','originalText'],properties:{id:stringSchema,clipIndex:{type:'integer',minimum:0,maximum:99},playId:stringSchema,start:{type:'number',minimum:0},end:{type:'number',minimum:0},text:{type:'string',minLength:1,maxLength:1200},evidenceIds:referenceSchema,playerIds:{type:'array',maxItems:20,items:stringSchema},facts:{type:'array',maxItems:128,items:{type:'object',additionalProperties:false,required:['evidenceId','path','value','format','decimals'],properties:{evidenceId:stringSchema,path:{type:'string',maxLength:160},value:{type:'number'},format:{enum:['raw','percent','absolute-percent']},decimals:{type:'integer',minimum:0,maximum:6}}}},origin:{enum:['evidence-engine','manual','external-model']},basisStart:{type:['number','null']},originalText:{type:'string',maxLength:1200}}}},
  arrows:{type:'array',maxItems:500,items:{type:'object',additionalProperties:false,required:['id','playId','start','end','evidenceIds','playerId','origin','points'],properties:{id:stringSchema,playId:stringSchema,start:{type:'number',minimum:0},end:{type:'number',minimum:0},evidenceIds:referenceSchema,playerId:{type:['string','null'],maxLength:160},origin:{const:'manual'},color:{type:'string',pattern:'^#[a-fA-F0-9]{6}$'},sourceAnnotation:{type:'object',additionalProperties:false,required:['id','start','end','points','origin','source','evidenceId','frameReviewed'],properties:{id:stringSchema,start:{type:'number',minimum:0},end:{type:'number',minimum:0},points:{type:'array',minItems:2,maxItems:20,items:{anyOf:[{type:'array',minItems:2,maxItems:2,items:{type:'number',minimum:0,maximum:1}},{type:'object',additionalProperties:false,required:['x','y'],properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1}}}]}},origin:{type:['string','null'],maxLength:160},source:{type:['string','null'],maxLength:320},evidenceId:{type:['string','null'],maxLength:160},frameReviewed:{type:['boolean','null']}}},points:{type:'array',minItems:2,maxItems:20,items:{type:'object',additionalProperties:false,required:['x','y'],properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1}}}}}}},
  layers:{type:'object',additionalProperties:false,properties:Object.fromEntries(['players','paths','labels','zones','defenders','ball','metrics'].map(k=>[k,{type:'boolean'}]))}
}});
const LAYERS = ['players','paths','labels','zones','defenders','ball','metrics'];
const finite = n => typeof n === 'number' && Number.isFinite(n);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(canonicalJSON(v));
const fail = message => {throw new StoryPlanError(message);};
export class StoryPlanError extends Error {constructor(message){super(message);this.name='StoryPlanError';}}

/** Sorted JSON is the common browser/CLI hashing representation. */
export function canonicalJSON(value) {
  const seen=new Set();
  function encode(v) {
    if(v===null || typeof v==='boolean' || typeof v==='string') return JSON.stringify(v);
    if(typeof v==='number') {if(!finite(v))fail('Non-finite JSON number.');return JSON.stringify(v);}
    if(!object(v)&&!Array.isArray(v)) fail('Only JSON values are permitted.');
    if(seen.has(v))fail('Cyclic JSON is not permitted.');seen.add(v);
    const out=Array.isArray(v)?'['+v.map(encode).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+encode(v[k])).join(',')+'}';
    seen.delete(v);return out;
  }
  return encode(value);
}
export async function hashJSON(value) {
  if(!globalThis.crypto?.subtle) fail('SHA-256 requires Web Crypto (modern Node or browser).');
  const bytes=new TextEncoder().encode(canonicalJSON(value));
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}
const timestamp = () => new Date().toISOString();
const content = plan => ({schema:plan.schema,inputHash:plan.inputHash,title:plan.title,clips:plan.clips,cues:plan.cues,arrows:plan.arrows,layers:plan.layers});
const unsigned = plan => {const {planHash,...rest}=plan;return rest;};
async function seal(plan) {plan.contentHash=await hashJSON(content(plan));plan.planHash=await hashJSON(unsigned(plan));return plan;}
const boundedText=(v,name,max=STORY_PLAN_LIMITS.text)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))fail(`${name} is empty, too long, or contains control characters.`);};
const list=(v,name,max)=>{if(!Array.isArray(v)||v.length>max)fail(`${name} must be a bounded array.`);};
const assertHash=(v,name)=>{if(typeof v!=='string'||!/^\w{64}$/.test(v)||!/^[a-f0-9]+$/.test(v))fail(`${name} must be SHA-256.`);};
const uniqueIds=(rows,name)=>{const ids=new Set();for(const row of rows){boundedText(row?.id,`${name} id`,160);if(ids.has(row.id))fail(`Duplicate ${name} id.`);ids.add(row.id);}};
const keys=(value,allowed,name)=>{if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail(`Unknown ${name} field.`);};
const normalizedNumbers=text=>text.replace(/[０-９]/g,c=>String(c.charCodeAt(0)-0xff10)).replace(/[−﹣－]/g,'-').replace(/[＋]/g,'+').replace(/负(?=\d)/g,'-');
const numbersIn=text=>[...normalizedNumbers(text).matchAll(/(?<![A-Za-z0-9_])[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?(?![A-Za-z0-9_])/g)].map(m=>Number(m[0]));
const probability = e => e?.unit==='probability';
const percentage = e => ['percent','%'].includes(e?.unit);
const percentNumbersIn=text=>[...normalizedNumbers(text).matchAll(/(?<![A-Za-z0-9_])([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)(?![A-Za-z0-9_])\s*[%％]/g)].map(m=>Number(m[1]));
const percentAllowed=(e,value)=>probability(e)?value>=0&&value<=1:percentage(e);
const sameNumber=(a,b)=>Math.abs(a-b)<1e-9;
function roster(play) {
  const ids=new Set([play.playerId,play.player,play.shooter].filter(v=>typeof v==='string'&&v));
  const aliases=new Set(ids);
  for(const f of [...play.tracks||[],...play.screenTracks||[]]) for(const p of f.players||[]) {if(typeof p.id==='string')ids.add(p.id);for(const v of [p.name,p.player])if(typeof v==='string'&&v)aliases.add(v);}
  return {ids,aliases};
}
function getPath(value,path) {
  if(typeof path!=='string'||path.length>160||path.split('.').some(k=>['__proto__','prototype','constructor'].includes(k))) fail('Invalid evidence fact path.');
  for(const key of path?path.split('.'):[]) {if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))fail('Unknown evidence fact path.');value=value[key];}
  return value;
}
function numericLeaves(value,path='') {
  if(finite(value))return [{path,value}];
  if(!object(value)&&!Array.isArray(value))return [];
  return Object.entries(value).flatMap(([k,v])=>numericLeaves(v,path?`${path}.${k}`:k));
}
function displayed(fact,evidence) {const n=fact.format==='percent'?(probability(evidence)?fact.value*100:fact.value):fact.format==='absolute-percent'?Math.abs(fact.value):fact.value;return Number(n.toFixed(fact.decimals??3));}
function evidenceIndex(snapshot) {
  const rows=Object.values(snapshot.analyses).flatMap(a=>a.evidence||[]),map=new Map();
  for(const e of rows){if(!e?.id||map.has(e.id))fail('Evidence ids must be globally unique.');map.set(e.id,e);}
  return map;
}
function checkWindow(item,play,label) {if(!finite(item.start)||!finite(item.end)||item.start<play.start||item.end>play.end||item.end<=item.start)fail(`${label}: invalid source window.`);}
function checkRefs(item,play,evidence) {
  list(item.evidenceIds,'evidenceIds',STORY_PLAN_LIMITS.references);
  if(!item.evidenceIds.length||new Set(item.evidenceIds).size!==item.evidenceIds.length)fail('Every cue/arrow needs unique evidence ids.');
  return item.evidenceIds.map(id=>{const e=evidence.get(id);if(!e||e.playId!==play.id)fail('Unknown or cross-play evidence id.');if(e.available===false||!finite(e.t)||e.t>item.start)fail('Unavailable/future evidence cannot appear at this source time.');if(e.start!==undefined&&(!finite(e.start)||!finite(e.end)||e.start<play.start||e.end>play.end||e.end<e.start||e.end>item.start))fail('Evidence window is invalid or not yet complete.');return e;});
}
/** Synchronous structural/evidence validation; throws StoryPlanError on rejection. */
export function validateStoryPlan(plan,project=plan?.inputSnapshot?.project,{requireReviewed=false}={}) {
  if(typeof requireReviewed!=='boolean')fail('requireReviewed must be boolean.');
  if(!object(plan)||plan.schema!==STORY_PLAN_SCHEMA)fail('Unsupported StoryPlan schema.');
  keys(plan,['schema','id','revision','createdAt','title','inputSnapshot','inputHash','clips','cues','arrows','layers','generation','review','history','contentHash','planHash'],'StoryPlan');
  if(new TextEncoder().encode(canonicalJSON(plan)).length>STORY_PLAN_LIMITS.bytes)fail('StoryPlan exceeds the byte limit.');
  if(!object(project)||!Array.isArray(project.plays)||!object(plan.inputSnapshot?.analyses)||!object(plan.inputSnapshot?.narrations))fail('Original project, evidence and narration snapshots are required.');
  for(const key of ['inputHash','contentHash','planHash'])assertHash(plan[key],key);
  boundedText(plan.title,'title',300);
  list(plan.clips,'clips',STORY_PLAN_LIMITS.clips);if(!plan.clips.length)fail('StoryPlan needs at least one clip.');
  list(plan.cues,'cues',STORY_PLAN_LIMITS.cues);list(plan.arrows,'arrows',STORY_PLAN_LIMITS.arrows);list(plan.history,'history',STORY_PLAN_LIMITS.history);
  uniqueIds(plan.cues,'cue');uniqueIds(plan.arrows,'arrow');
  const plays=new Map(project.plays.map(p=>[p.id,p]));if(plays.size!==project.plays.length)fail('Duplicate play id.');
  const evidence=evidenceIndex(plan.inputSnapshot),allAliases=new Set(project.plays.flatMap(p=>[...roster(p).aliases]));
  for(const clip of plan.clips){keys(clip,['playId','start','end'],'clip');const p=plays.get(clip.playId);if(!p)fail('Unknown clip play id.');checkWindow(clip,p,'clip');}
  if(!object(plan.layers)||Object.keys(plan.layers).some(k=>!LAYERS.includes(k)||typeof plan.layers[k]!=='boolean'))fail('Unknown layer or non-boolean layer setting.');
  for(const cue of plan.cues){
    keys(cue,['id','clipIndex','playId','start','end','text','evidenceIds','playerIds','facts','origin','basisStart','originalText'],'cue');
    const p=plays.get(cue.playId);if(!p)fail('Unknown cue play id.');checkWindow(cue,p,'cue');
    const clip=plan.clips[cue.clipIndex];if(!Number.isInteger(cue.clipIndex)||!clip||clip.playId!==p.id||cue.start<clip.start||cue.end>clip.end)fail('Cue must be contained in its selected clip.');
    boundedText(cue.text,'cue text');const refs=checkRefs(cue,p,evidence);
    list(cue.playerIds,'playerIds',20);const local=roster(p);if(cue.playerIds.some(id=>!local.ids.has(id)))fail('Unknown or cross-play player id.');
    for(const alias of allAliases)if(alias.length>=2&&!local.aliases.has(alias)&&cue.text.includes(alias))fail('Text names a player from another play.');
    const baseline=plan.inputSnapshot.narrations[p.id]?.cues?.find(c=>c.start===cue.basisStart);
    if(cue.basisStart!==null&&(!baseline||cue.originalText!==baseline.text||baseline.evidenceIds.some(id=>!cue.evidenceIds.includes(id))))fail('Original narration anchor does not match the input snapshot.');
    list(cue.facts,'facts',128);const supported=[],supportedPercent=[];
    for(const fact of cue.facts){keys(fact,['evidenceId','path','value','format','decimals'],'fact');if(!cue.evidenceIds.includes(fact.evidenceId))fail('A numeric fact must cite a cue evidence id.');const e=evidence.get(fact.evidenceId),value=getPath(e.value,fact.path);if(!finite(value)||!finite(fact.value)||!sameNumber(value,fact.value))fail('Unsupported numeric fact.');if(!['raw','percent','absolute-percent'].includes(fact.format)||!Number.isInteger(fact.decimals)||fact.decimals<0||fact.decimals>6)fail('Unsupported numeric display format.');if(fact.format==='percent'&&!percentAllowed(e,value))fail('Percent requires a declared 0–1 probability unit or an original percent unit.');if(fact.format==='absolute-percent'&&e.field!=='tracks.players.defensive-convex-hull')fail('Absolute percent requires a declared defensive contraction measurement.');supported.push(displayed(fact,e));if(['percent','absolute-percent'].includes(fact.format))supportedPercent.push(displayed(fact,e));}
    for(const n of percentNumbersIn(cue.text))if(!supportedPercent.some(v=>sameNumber(v,n)))fail(`Unsupported number in percentage narration: ${n}%. Supply its correctly unit-bound evidence fact handle.`);
    // Trusted engine wording supplies contextual numbers (period, game clock, scale).
    const baselineNumbers=baseline?numbersIn(baseline.text):[];
    for(const n of numbersIn(cue.text))if(![...supported,...baselineNumbers].some(v=>sameNumber(v,n)))fail(`Unsupported number in narration: ${n}. Supply its evidence fact handle.`);
    const outcomeText=cue.text.replace(/(?:预期|预计)?命中(?:概率|率)|(?:make|made)[ -]?(?:probability|chance)/giu,'');
    if(/命中|未中|made|missed/iu.test(outcomeText)&&!refs.some(e=>e.field==='outcome'&&['made','missed'].includes(e.value)))fail('Outcome narration requires available outcome evidence.');
    const outcome=refs.find(e=>e.field==='outcome');
    if(outcome?.value==='made'&&/未(?:命)?中|missed/iu.test(outcomeText)||outcome?.value==='missed'&&/命中|\bmade\b/iu.test(outcomeText.replace(/未命中/g,'')))fail('Narration contradicts the supplied outcome.');
    if(!['evidence-engine','manual','external-model'].includes(cue.origin))fail('Unknown cue origin.');
  }
  for(const arrow of plan.arrows){keys(arrow,['id','playId','start','end','evidenceIds','playerId','origin','points','color','sourceAnnotation'],'arrow');const p=plays.get(arrow.playId);if(!p)fail('Unknown arrow play id.');checkWindow(arrow,p,'arrow');if(!plan.clips.some(c=>c.playId===p.id&&arrow.start>=c.start&&arrow.end<=c.end))fail('Arrow must be contained in a selected clip.');checkRefs(arrow,p,evidence);if(arrow.playerId!==null&&!roster(p).ids.has(arrow.playerId))fail('Unknown arrow player id.');if(arrow.origin!=='manual')fail('Custom arrow geometry must be explicitly marked manual.');list(arrow.points,'arrow points',20);if(arrow.points.length<2||arrow.points.some(v=>!object(v)||!finite(v.x)||!finite(v.y)||v.x<0||v.x>1||v.y<0||v.y>1))fail('Arrow requires bounded normalized screen points.');if(arrow.color!==undefined&&!/^#[a-f0-9]{6}$/i.test(arrow.color))fail('Invalid arrow color.');if(arrow.sourceAnnotation!==undefined){const original=p.annotations?.find(a=>a.id===arrow.sourceAnnotation.id);if(!original||!manualAnnotation(original)||canonicalJSON(annotationSource(original))!==canonicalJSON(arrow.sourceAnnotation))fail('Arrow source annotation does not match the preserved original project.');checkWindow(original,p,'source annotation');screenPoints(original.points);if(arrow.start<original.start||arrow.end>original.end)fail('Arrow exceeds its original source annotation window.');}}
  if(!object(plan.generation)||!['deterministic-evidence','manual','external-model'].includes(plan.generation.kind)||typeof plan.generation.provider!=='string'||typeof plan.generation.model!=='string'||typeof plan.generation.prompt!=='string'||plan.generation.prompt.length>STORY_PLAN_LIMITS.prompt||!object(plan.generation.proposal)||!object(plan.generation.request)||!object(plan.generation.parameters)||!['deterministic-local','imported-proposal'].includes(plan.generation.execution))fail('Generation provenance and original proposal are required.');
  assertHash(plan.generation.inferenceIdentity,'inferenceIdentity');
  if(!object(plan.review)||!['pending','approved'].includes(plan.review.status))fail('Review record is required.');
  if(requireReviewed){if(plan.review.status!=='approved'||plan.review.contentHash!==plan.contentHash)fail('The final content needs human review.');boundedText(plan.review.reviewer,'reviewer',160);boundedText(plan.review.reason,'review reason',1200);}
  return {ok:true,errors:[],warnings:['Evidence checks cover ids, numeric handles and source time; prose meaning and manual arrow geometry require human review.','No video AI inference or source authentication is asserted.']};
}
/** Recompute every identity, including the saved input and human review content. */
export async function verifyStoryPlan(plan,project=plan?.inputSnapshot?.project,options={}) {
  const result=validateStoryPlan(plan,project,options);
  if(await hashJSON(plan.inputSnapshot)!==plan.inputHash||await hashJSON(content(plan))!==plan.contentHash||await hashJSON(unsigned(plan))!==plan.planHash)fail('StoryPlan content or provenance hash mismatch.');
  if(await inferenceIdentity({input:plan.inputSnapshot,provider:plan.generation.provider,model:plan.generation.model,prompt:plan.generation.prompt,promptVersion:plan.generation.promptVersion,parameters:plan.generation.parameters,request:plan.generation.request})!==plan.generation.inferenceIdentity)fail('Generation cache identity mismatch.');
  if(await hashJSON(project)!==await hashJSON(plan.inputSnapshot.project))fail('Project changed since StoryPlan creation; create a new plan.');
  // A self-consistent but forged evidence snapshot must not replace the actual
  // deterministic records derived from the preserved original project.
  const evidence=evidenceIndex(plan.inputSnapshot),used=new Set([...plan.cues,...plan.arrows].flatMap(c=>c.evidenceIds));
  for(const p of project.plays){
    const actual=analyzePossession(p),actualRows=new Map(actual.evidence.map(e=>[e.id,e]));
    for(const id of used){const saved=evidence.get(id);if(saved?.playId!==p.id)continue;if(canonicalJSON(saved)!==canonicalJSON(actualRows.get(id)))fail('Saved evidence does not match calculations from the original project.');}
    const savedNarration=plan.inputSnapshot.narrations[p.id],fresh=buildNarration(p,actual,{audience:savedNarration?.audience??'fan'});
    for(const cue of plan.cues.filter(c=>c.playId===p.id&&c.basisStart!==null)){const baseline=fresh.cues.find(c=>c.start===cue.basisStart);if(!baseline||baseline.text!==cue.originalText||baseline.evidenceIds.some(id=>!cue.evidenceIds.includes(id)))fail('Narration baseline does not match the original evidence engine.');}
  }
  return result;
}
function prepareSnapshot(project,options) {
  const analyses={},narrations={};
  for(const p of project.plays){const a=options.analyses?.[p.id]??analyzePossession(p),engine=buildNarration(p,a,{audience:options.narrations?.[p.id]?.audience??options.audience??'fan'}),n=options.narrations?.[p.id]??engine;analyses[p.id]=clone(a);narrations[p.id]=clone(engine);narrations[p.id].cues=(n.cues||[]).map(c=>({...clone(c),text:c.originalText??engine.cues.find(original=>original.start===c.start)?.text??c.text}));}
  return {project:clone(project),analyses,narrations};
}
function factsFor(text,ids,snapshot) {
  const evidence=evidenceIndex(snapshot),wanted=numbersIn(text),out=[];
  for(const id of ids)for(const leaf of numericLeaves(evidence.get(id)?.value))for(const format of ['raw','percent','absolute-percent'])for(const decimals of [3,2,1,0]){
    const e=evidence.get(id),f={evidenceId:id,...leaf,format,decimals};if((format!=='percent'||percentAllowed(e,leaf.value))&&(format!=='absolute-percent'||e.field==='tracks.players.defensive-convex-hull')&&wanted.some(v=>sameNumber(v,displayed(f,e)))&&!out.some(o=>o.evidenceId===id&&o.path===leaf.path&&o.format===format&&o.decimals===decimals))out.push(f);
  }
  return out.slice(0,128);
}
const manualAnnotation=a=>a?.kind==='arrow'&&(a.origin==='manual'||a.source==='manual');
function screenPoints(points) {
  list(points,'source arrow points',20);
  if(points.length<2)fail('Source arrow requires at least two points.');
  return points.map(point=>{if(Array.isArray(point)){if(point.length!==2)fail('Source arrow points must contain exactly x/y.');point={x:point[0],y:point[1]};}else keys(point,['x','y'],'source arrow point');if(!finite(point.x)||!finite(point.y)||point.x<0||point.x>1||point.y<0||point.y>1)fail('Source arrow requires bounded normalized screen points.');return {x:point.x,y:point.y};});
}
function annotationSource(a) {
  boundedText(a.id,'source annotation id',160);screenPoints(a.points);
  for(const [key,max] of [['origin',160],['source',320],['evidence_id',160]])if(a[key]!==undefined)boundedText(a[key],`source annotation ${key}`,max);
  if(a.frame_reviewed!==undefined&&typeof a.frame_reviewed!=='boolean')fail('Source annotation frame_reviewed must be boolean.');
  return {id:a.id,start:a.start,end:a.end,points:clone(a.points),origin:a.origin??null,source:a.source??null,evidenceId:a.evidence_id??null,frameReviewed:a.frame_reviewed??null};
}
/** Compile source UI geometry only for a local draft. Imported/revised arrays remain final. */
function compileLocalArrows(project,clips,snapshot) {
  const arrows=[],evidence=evidenceIndex(snapshot);
  for(const [playIndex,p] of project.plays.entries()){
    const selected=clips.filter(c=>c.playId===p.id);if(!selected.length)continue;
    if(p.annotations!==undefined&&!Array.isArray(p.annotations))fail('Source annotations must be an array.');
    for(const [annotationIndex,a] of (p.annotations??[]).entries()){
      if(!manualAnnotation(a))continue;checkWindow(a,p,'source annotation');
      if(a.frame_reviewed===false)fail('Source manual arrow explicitly lacks frame review.');
      const points=screenPoints(a.points),sourceAnnotation=annotationSource(a);
      const windows=selected.map(c=>({start:Math.max(a.start,c.start),end:Math.min(a.end,c.end)})).filter(w=>w.end>w.start);
      const boundaries=[...new Set(windows.flatMap(w=>[w.start,w.end]))].sort((a,b)=>a-b),segments=[];
      for(let i=1;i<boundaries.length;i++){const start=boundaries[i-1],end=boundaries[i];if(!windows.some(w=>start>=w.start&&end<=w.end))continue;const previous=segments.at(-1);if(previous?.end===start&&selected.some(c=>previous.start>=c.start&&end<=c.end))previous.end=end;else segments.push({start,end});}
      for(const [segmentIndex,window] of segments.entries()){
        // UI evidence_id marks a human drawing, not a measured geometry record.
        // The event handle anchors its play/time; preserved source metadata and
        // explicit human review are the authority for the drawn screen points.
        const refs=a.evidenceIds===undefined?[`${p.id}:event`]:clone(a.evidenceIds);
        const arrow={id:`arrow-${playIndex}-${annotationIndex}-${segmentIndex}`,playId:p.id,...window,evidenceIds:refs,playerId:a.playerId??null,origin:'manual',points:clone(points),sourceAnnotation:clone(sourceAnnotation)};
        if(a.color!==undefined)arrow.color=a.color;
        checkRefs(arrow,p,evidence);arrows.push(arrow);
      }
    }
  }
  list(arrows,'compiled arrows',STORY_PLAN_LIMITS.arrows);return arrows;
}
export async function createStoryPlan(project,proposal,options={}) {
  const snapshot=prepareSnapshot(project,options),raw=clone(proposal);
  const kind=options.generation?.kind??'manual';
  const plan={schema:STORY_PLAN_SCHEMA,id:globalThis.crypto.randomUUID(),revision:0,createdAt:timestamp(),title:proposal.title??project.name,inputSnapshot:snapshot,inputHash:await hashJSON(snapshot),clips:clone(proposal.clips),cues:clone(proposal.cues),arrows:clone(Object.hasOwn(proposal,'arrows')?proposal.arrows:[]),layers:clone(proposal.layers??{players:true,paths:true,labels:true,zones:true,defenders:false,ball:true,metrics:false}),generation:{kind,execution:kind==='deterministic-evidence'?'deterministic-local':'imported-proposal',provider:options.generation?.provider??'manual-import',model:options.generation?.model??'none',promptVersion:options.generation?.promptVersion??'story-plan/1',prompt:options.generation?.prompt??options.prompt??'',parameters:clone(options.generation?.parameters??{}),request:clone(options.generation?.request??{question:options.question??'',audience:options.audience??'fan'}),proposal:raw},review:{status:'pending',contentHash:null,reviewer:null,reason:null,at:null},history:[]};
  plan.generation.inferenceIdentity=await inferenceIdentity({input:snapshot,provider:plan.generation.provider,model:plan.generation.model,prompt:plan.generation.prompt,promptVersion:plan.generation.promptVersion,parameters:plan.generation.parameters,request:plan.generation.request});
  for(const cue of plan.cues)if(cue.clipIndex===undefined){const matches=plan.clips.map((c,i)=>c.playId===cue.playId&&cue.start>=c.start&&cue.end<=c.end?i:null).filter(i=>i!==null);if(matches.length!==1)fail('Cue needs an explicit clipIndex when source windows repeat.');cue.clipIndex=matches[0];}
  await seal(plan);validateStoryPlan(plan,project);return plan;
}
/** Local evidence composition, with supplied manual narration edits preserved. */
export async function createLocalStoryPlan(project,options={}) {
  const snapshot=prepareSnapshot(project,options),clips=(project.playlist?.length?project.playlist:project.plays.map(p=>({playId:p.id,start:p.start,end:p.end}))).map(c=>{const p=project.plays.find(p=>p.id===c.playId);return {playId:c.playId,start:c.start??p.start,end:c.end??p.end};});
  const cues=[];
  for(const [index,clip] of clips.entries()){
    const p=project.plays.find(p=>p.id===clip.playId),provided=options.narrations?.[p.id]??buildNarration(p,snapshot.analyses[p.id],{audience:options.audience??'fan'});
    for(const [i,c] of provided.cues.entries()){
      const start=Math.max(c.start,clip.start),end=Math.min(c.end,clip.end);if(end<=start)continue;
      const text=c.text,baseline=snapshot.narrations[p.id].cues.find(b=>b.start===c.start);
      // Only engine-baseline numbers receive automatic bindings. A manual new
      // numeric assertion needs explicit facts in an imported/revised proposal.
      cues.push({id:`cue-${index}-${i}`,clipIndex:index,playId:p.id,start,end,text,evidenceIds:clone(c.evidenceIds),playerIds:[],facts:factsFor(baseline.text,c.evidenceIds,snapshot),origin:c.origin==='manual'||text!==baseline.text?'manual':'evidence-engine',basisStart:c.start,originalText:baseline.text});
    }
  }
  return createStoryPlan(project,{title:project.name,clips,cues,arrows:Object.hasOwn(options,'arrows')?options.arrows:compileLocalArrows(project,clips,snapshot),layers:options.layers??{players:true,paths:true,labels:true,zones:true,defenders:false,ball:true,metrics:false}},{...options,generation:{kind:'deterministic-evidence',provider:'local-evidence-engine',model:'none',promptVersion:'deterministic-narration/2',prompt:options.prompt??'',request:{question:options.question??'',audience:options.audience??'fan'}}});
}
export async function reviseStoryPlan(plan,changes,{actor='manual editor'}={}) {
  await verifyStoryPlan(plan);if(!object(changes)||Object.keys(changes).some(k=>!['title','clips','cues','arrows','layers'].includes(k)))fail('Only presentation fields can be revised.');
  const next=clone(plan);Object.assign(next,clone(changes));next.revision++;next.history.push({parentPlanHash:plan.planHash,at:timestamp(),actor,changes:clone(changes)});next.review={status:'pending',contentHash:null,reviewer:null,reason:null,at:null};await seal(next);validateStoryPlan(next);return next;
}
export async function reviewStoryPlan(plan,{reviewer,reason='Source anchors, final wording and manual geometry reviewed.'}={}) {
  await verifyStoryPlan(plan);boundedText(reviewer,'reviewer',160);boundedText(reason,'reason',1200);const next=clone(plan);next.review={status:'approved',contentHash:next.contentHash,reviewer,reason,at:timestamp()};return seal(next);
}
export function storyTimeMap(plan) {
  validateStoryPlan(plan);let offset=0;
  const clips=plan.clips.map(c=>{const mapped={...c,outputStart:offset,outputEnd:offset+c.end-c.start};offset=mapped.outputEnd;return mapped;});
  const cues=clips.flatMap((c,clipIndex)=>plan.cues.filter(q=>q.clipIndex===clipIndex).map(q=>({...q,clipIndex,sourceStart:q.start,sourceEnd:q.end,start:c.outputStart+q.start-c.start,end:c.outputStart+q.end-c.start}))).sort((a,b)=>a.start-b.start||a.end-b.end);
  return {clips,cues,duration:offset};
}
/** Generation and render caches intentionally have different dependencies. */
export async function inferenceIdentity({input,provider,model,prompt,promptVersion,parameters={},request={}}) {return hashJSON({kind:'courtlens-inference/1',input,provider,model,prompt,promptVersion,parameters,request});}
export async function renderIdentity(plan,{sourceSha256,renderer,rendererSha256,assets,font,audio={mode:'silent'},width=1280,height=720,fps=25}={}) {
  await verifyStoryPlan(plan,plan.inputSnapshot.project,{requireReviewed:true});assertHash(sourceSha256,'sourceSha256');assertHash(rendererSha256,'rendererSha256');boundedText(renderer,'renderer',300);if(!Array.isArray(assets)||!assets.length||assets.some(a=>!object(a)||typeof a.name!=='string'||!(/^[a-f0-9]{64}$/.test(a.sha256))))fail('Renderer/assets need actual file hashes.');if(!object(font)||!/^[a-f0-9]{64}$/.test(font.sha256)||typeof font.family!=='string')fail('Font needs actual bytes hash and family.');if(!object(audio)||!['silent','file'].includes(audio.mode)||audio.mode==='file'&&!/^[a-f0-9]{64}$/.test(audio.sha256))fail('Audio identity must be silent or hash the actual audio.');if(!Number.isInteger(width)||width<16||width>4096||width%2||!Number.isInteger(height)||height<16||height>4096||height%2||!finite(fps)||fps<1||fps>60)fail('Invalid render dimensions or frame rate.');
  return hashJSON({kind:'courtlens-render/1',content:content(plan),reviewedContentHash:plan.review.contentHash,sourceSha256,renderer,rendererSha256,assets,font,audio,width,height,fps});
}
