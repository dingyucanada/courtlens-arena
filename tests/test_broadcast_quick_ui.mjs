import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {quickPlan, quickDefaults, currentQuickEvidence, renderQuickScreen, updateCommentaryCue, commentaryCueRows, renderCommentaryCueSection, cueDraftKey, hasUnsavedCommentary, remainingCommentaryDrafts} from '../broadcast/quick_ui.mjs';

const caps={renderer:{available:true},commentaryLanguages:[{id:'zh-CN',voiceModes:['local-tts']},{id:'en-US',voiceModes:['local-tts']},{id:'yue-HK',voiceModes:['local-tts']}],providers:[{id:'local-tts',kind:'voice',available:true,verified:false},{id:'stepfun-vision',kind:'semantic',available:true,modalities:['video','image']},{id:'stepfun-story',kind:'semantic',available:true,modalities:['text']}]};
const project={id:'p',revision:4,media:{sha256:'current-sha',duration:12},observations:[],releases:[]};
const report={projectId:'p',projectRevision:4,mediaSha256:'current-sha',frames:[{id:'f',mediaSha256:'current-sha',actualTime:1}],vision:{providerRuns:[{runId:'run',mediaMatches:true,executionAudited:true}],reviewQueue:[]},checks:[{id:'story',status:'pass'},{id:'review',status:'fail'}]};
const observation={id:'o',start:1,end:2,description:'持球人向篮筐移动。',frameIds:['f'],source:{kind:'model',runId:'run'},review:{status:'unreviewed'}};
const plan=(overrides={})=>quickPlan({project,capabilities:caps,report,...overrides});
assert.equal(quickPlan({capabilities:caps}).stage,'upload');
assert.equal(quickPlan({capabilities:caps}).disabled,true);
assert.equal(plan().stage,'analyze');
assert.equal(plan({selectedFile:{name:'replacement.mp4'}}).stage,'upload','replacement must use new video rather than old evidence');
assert.equal(plan({project:{...project,media:{...project.media,duration:60}}}).stage,'blocked','never truncate analysis without consent');
assert.equal(plan({capabilities:{...caps,providers:caps.providers.filter(x=>x.kind==='voice')}}).stage,'blocked');
assert.equal(plan({capabilities:{...caps,commentaryLanguages:[]}}).stage,'blocked','voice language support must be explicitly declared');
assert.equal(quickDefaults(caps).visual.strategy,'video-first');
const pending={...project,observations:[observation]};
assert.equal(plan({project:pending}).stage,'observations','never silently accept a model candidate');
assert.equal(plan({project:pending,report:{...report,projectRevision:3}}).stage,'checking');
assert.equal(currentQuickEvidence(pending,{...report,frames:[]}).ok,false);
assert.equal(currentQuickEvidence(pending,{...report,frames:[{id:'f',mediaSha256:'other-video'}]}).ok,false);
assert.equal(currentQuickEvidence(pending,{...report,vision:{...report.vision,providerRuns:[]}}).ok,false);
assert.equal(currentQuickEvidence(pending,{...report,vision:{...report.vision,providerRuns:[{runId:'run',mediaMatches:true,executionAudited:false}]}}).ok,false);
const accepted={...pending,observations:[{...observation,review:{status:'accepted',actor:'Reviewer'}}]};
assert.equal(plan({project:accepted}).stage,'draft');
assert.equal(plan({project:accepted,language:'en-US',capabilities:{...caps,providers:caps.providers.filter(x=>x.id!=='stepfun-story')}}).stage,'draft','accepted events can use original English action templates without translation claims');
const drafted={...accepted,story:{language:'zh-CN',commentaryStyle:'energetic',sourceRange:{start:0,end:12},beats:[{id:'b',text:'持球人向篮筐移动。',sourceStart:2,sourceEnd:6}]}};
assert.equal(plan({project:drafted}).stage,'story-review');
assert.equal(plan({project:drafted,language:'en-US'}).stage,'draft','changing language requires a fresh draft and review');
const reviewed={...report,checks:[{id:'story',status:'pass'},{id:'review',status:'pass'}]};
assert.equal(plan({project:drafted,report:reviewed}).stage,'render');
assert.equal(plan({project:drafted,report:{...reviewed,checks:[{id:'story',status:'fail',detail:'Invalid timing'}]}}).message,'Invalid timing');
assert.equal(plan({project:drafted,job:{id:'j',projectId:'p',status:'running',stage:'voice'}}).stage,'running');
assert.equal(plan({project:drafted,job:{id:'j',projectId:'other',status:'running',stage:'voice'}}).stage,'story-review','a different project job cannot block this project');
const ready={...drafted,releases:[{id:'release',projectRevision:4,voice:{mode:'local-tts',language:'zh-CN'},videoUrl:'/film.mp4'}]};
assert.equal(plan({project:ready,report:reviewed}).stage,'released');
assert.equal(plan({project:{...ready,releases:[{...ready.releases[0],projectRevision:3}]},report:reviewed}).stage,'render','old release is not current success');
const first=renderQuickScreen({capabilities:caps,language:'zh-CN'});
assert.match(first,/自动模式/);assert.match(first,/详细工作台/);assert.match(first,/普通话 · 原创解说/);assert.match(first,/英语 · 原创解说/);assert.match(first,/粤语 · 原创解说/);
assert.equal((first.match(/data-action="quick-generate"/g)||[]).length,1);
assert.doesNotMatch(first,/sourceLabel|rightsNote|analysisChoice|providerId|voiceId|克隆|杨毅|于嘉|徐静雨/);
const candidate=renderQuickScreen({project:{...pending,observations:[{...observation,description:'<img onerror=alert(1)>'}]},capabilities:caps,report});
assert.match(candidate,/&lt;img/);assert.match(candidate,/确认属实/);assert.match(candidate,/排除/);
const review=renderQuickScreen({project:drafted,capabilities:caps,report});
assert.match(review,/data-form="quick-review"/);assert.match(review,/name="confirmed" required/);
assert.doesNotMatch(first,/已完成|已验证|AI已看懂/);
console.log('Quick workflow gates stale evidence, missing providers, translation, review, replacement media, and immutable releases');

const cue={id:'spoken-1',text:'持球人移动。',sourceStart:2,sourceEnd:4,observationIds:['o'],language:'zh-CN'};
const spoken={...drafted,story:{...drafted.story,commentaryCues:[cue,{...cue,id:'spoken-2',sourceStart:5,sourceEnd:7}]}};
const before=structuredClone(spoken);
const expected={projectId:spoken.id,revision:spoken.revision};
const edited=updateCommentaryCue(spoken,cue.id,{text:'移动。',sourceStart:'2.1',sourceEnd:'4.8'},expected);
assert.deepEqual(spoken,before,'client editing must not mutate the saved project or evidence');
assert.equal(edited.commentaryCues[0].text,'移动。');assert.equal(edited.commentaryCues[0].sourceStart,2.1);assert.equal(edited.commentaryCues[0].sourceEnd,4.8);
assert.deepEqual(edited.commentaryCues[0].observationIds,cue.observationIds);assert.equal(edited.commentaryCues[0].language,cue.language);assert.equal(edited.commentaryCues[0].id,cue.id);
assert.deepEqual(edited.beats,spoken.story.beats,'spoken edits must target the real voice lane independently of visual overlays');assert.deepEqual(edited.commentaryCues[1],spoken.story.commentaryCues[1]);assert.deepEqual(edited.sourceRange,spoken.story.sourceRange);
assert.throws(()=>updateCommentaryCue(spoken,cue.id,{text:'移动。',sourceStart:2,sourceEnd:4},{...expected,revision:3}),/版本已变化/);
assert.throws(()=>updateCommentaryCue(spoken,cue.id,{text:'移动。',sourceStart:2,sourceEnd:4},{...expected,projectId:'another'}),/版本已变化/);
assert.throws(()=>updateCommentaryCue(spoken,cue.id,{text:'',sourceStart:2,sourceEnd:4},expected),/文字/);
assert.throws(()=>updateCommentaryCue(spoken,cue.id,{text:'移动。',sourceStart:'',sourceEnd:4},expected),/范围/);
assert.throws(()=>updateCommentaryCue(spoken,cue.id,{text:'移动。',sourceStart:2,sourceEnd:13},expected),/范围/);
const legacyEdited=updateCommentaryCue(drafted,'b',{text:'移动。',sourceStart:2,sourceEnd:5},expected);assert.equal(legacyEdited.beats[0].text,'移动。');assert.equal(Object.hasOwn(legacyEdited,'commentaryCues'),false);
assert.deepEqual(commentaryCueRows({...spoken.story,commentaryCues:[]}),[],'an explicitly empty spoken lane must not pretend that visual beats will be voiced');
const section=renderCommentaryCueSection(spoken,{drafts:{[cueDraftKey(spoken,cue.id)]:{text:'未保存的修正。',sourceStart:'2.2',sourceEnd:'4.5'}}});
assert.match(section,/实际配音文字/);assert.match(section,/未保存的修正。/);assert.match(section,/name="cueStart"/);assert.match(section,/name="cueEnd"/);assert.match(section,/data-revision="4"/);assert.match(section,/details class="manual-tools" open/);
assert.doesNotMatch(section,/name="language"|name="observationIds"|自动批准/);
const failedEditScreen=renderQuickScreen({project:spoken,capabilities:caps,report,job:{projectId:'p',status:'failed',error:{code:'voice_overflow',message:'本句口播超窗。'}}});
assert.match(failedEditScreen,/修正解说/);assert.match(failedEditScreen,/本句口播超窗/);
console.log('Spoken cue edits preserve language and evidence, reject stale versions, retain failed inputs, and expose voice-overflow repair');

const draftKey=cueDraftKey(spoken,cue.id),dirtyDraft={[draftKey]:{text:'修改待保存。',sourceStart:'2',sourceEnd:'4'}};
assert.equal(hasUnsavedCommentary(spoken,dirtyDraft),true);
assert.equal(hasUnsavedCommentary(spoken,{[draftKey]:{...cue,text:cue.text,sourceStart:'2',sourceEnd:'4'}}),false);
assert.equal(quickPlan({project:spoken,capabilities:caps,report:reviewed,cueDrafts:dirtyDraft}).disabled,true,'unsaved speech cannot be approved or rendered as the old version');
const appSource=readFileSync(new URL('../broadcast/app.mjs',import.meta.url),'utf8');
const saveSource=appSource.slice(appSource.indexOf('async function saveCommentaryCue('),appSource.indexOf('async function saveStory('));
const mutations=[],context={state:{project:spoken,cueDrafts:{},job:{id:'failed',status:'failed'},jobTimer:1},cueDraftKey,updateCommentaryCue,remainingCommentaryDrafts,
  requiredProject(){return context.state.project;},FormData:class {constructor(form){this.values=form.values;}get(key){return this.values[key];}},
  api:{async edit(p,patch){mutations.push({project:p,patch});return {...p,story:patch.story,revision:p.revision+1,review:null};}},
  clearTimeout(){},sessionStorage:{removeItem(){}},saveProject(p){context.state.project=p;},notify(){}};
vm.createContext(context);vm.runInContext(saveSource,context);
const form={dataset:{cueId:cue.id,projectId:spoken.id,revision:String(spoken.revision)},values:{cueText:'移动。',cueStart:'2.2',cueEnd:'4.5'}};
await context.saveCommentaryCue(form);assert.equal(mutations.length,1);assert.equal(mutations[0].patch.story.commentaryCues[0].text,'移动。');assert.deepEqual(mutations[0].patch.story.beats,spoken.story.beats);assert.equal(context.state.project.review,null);assert.equal(context.state.job,null);
assert.deepEqual(Object.keys(context.state.cueDrafts),[]);
context.state.project=spoken;context.api.edit=async()=>{throw new Error('server rejected wording');};
await assert.rejects(context.saveCommentaryCue(form),/server rejected/);assert.equal(context.state.project,spoken);assert.equal(context.state.cueDrafts[draftKey].text,'移动。','server rejection preserves the input for shortening or correcting');

const {default:test}=await import('node:test');
test('saving one spoken sentence preserves and migrates another pending edit through both revisions',async()=>{
  const pending={text:'第二句待保存。',sourceStart:'5.2',sourceEnd:'6.8'};
  context.state.project=spoken;context.state.cueDrafts={[cueDraftKey(spoken,'spoken-2')]:pending};
  context.api.edit=async(p,{story})=>({...p,story,revision:p.revision+1,review:null});
  await context.saveCommentaryCue(form);
  const firstSaved=context.state.project;
  assert.equal(firstSaved.story.commentaryCues[0].text,'移动。');
  assert.equal(firstSaved.story.commentaryCues[1].text,spoken.story.commentaryCues[1].text,'pending input is not silently included in the first save');
  assert.equal(context.state.cueDrafts[cueDraftKey(firstSaved,'spoken-2')],pending);
  assert.equal(hasUnsavedCommentary(firstSaved,context.state.cueDrafts),true);
  assert.match(renderCommentaryCueSection(firstSaved,{drafts:context.state.cueDrafts}),/第二句待保存。/);
  assert.equal(context.state.cueDrafts[cueDraftKey(spoken,'spoken-2')],undefined,'old revision key is replaced');
  await context.saveCommentaryCue({dataset:{cueId:'spoken-2',projectId:firstSaved.id,revision:String(firstSaved.revision)},values:{cueText:pending.text,cueStart:pending.sourceStart,cueEnd:pending.sourceEnd}});
  assert.equal(context.state.project.story.commentaryCues[0].text,'移动。');
  assert.equal(context.state.project.story.commentaryCues[1].text,pending.text);
  assert.equal(context.state.project.revision,spoken.revision+2);
  assert.equal(context.state.project.review,null);assert.equal(hasUnsavedCommentary(context.state.project,context.state.cueDrafts),false);
  assert.deepEqual(Object.keys(context.state.cueDrafts),[]);
});
test('simple and detailed review plus detailed render all reject pending spoken edits before an API call',async()=>{
  const formSource=appSource.slice(appSource.indexOf('async function onForm('),appSource.indexOf('async function onAction('));
  let submitted=0;const editContext={state:{project:spoken,cueDrafts:dirtyDraft,capabilities:caps},hasUnsavedCommentary,
    requiredProject(){return editContext.state.project;},run:async fn=>fn(),FormData:class {constructor(form){this.values=form.values;}get(k){return this.values[k];}},
    cleanText:(form,k)=>form.values[k]||'',api:{review:async p=>{submitted++;return p;},render:async p=>{submitted++;return {id:'stub',projectRevision:p.revision};}},
    saveProject:p=>{editContext.state.project=p;},notify(){},startJob(){}};
  vm.createContext(editContext);vm.runInContext(formSource,editContext);
  const values={actor:'Tester',identity:'on',timing:'on',metrics:'on',wording:'on',geometry:'on',voiceMode:'local-tts'};
  const event=kind=>({preventDefault(){},target:{closest:()=>({dataset:{form:kind},values})}});
  for(const kind of ['quick-review','review','render'])await assert.rejects(editContext.onForm(event(kind)),/请先保存口播修改/);
  assert.equal(submitted,0,'guard must run before any review, render or provider action');
  editContext.state.cueDrafts={};
  await editContext.onForm(event('review'));await editContext.onForm(event('render'));assert.equal(submitted,2,'saved draft can be explicitly reviewed and rendered');
});
