import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalStoryPlan,createStoryPlan,reviewStoryPlan,reviseStoryPlan,verifyStoryPlan,validateStoryPlan,storyTimeMap,inferenceIdentity,renderIdentity,hashJSON,canonicalJSON} from '../pro/story-plan.mjs';
import {analyzePossession,buildNarration} from '../pro/analytics.mjs';
import {readFileSync} from 'node:fs';
import {parseInput} from '../pro/model.mjs';

function fixture(){const p={id:'p01',title:'Test possession',start:10,end:14,player:'Alice',team:'T',shotTime:11,resultTime:13,shotValue:3,outcome:'made',tracks:[],tracking:{},metrics:{difficulty:{value:.62,semantics:'shot_make_probability',availableAt:11,unit:'probability'}},provenance:{kind:'manual',source:'test record'}};return {schema:'courtlens-arena/1',id:'test',name:'Test',revision:0,provenance:{kind:'synthetic',source:'test'},plays:[p],playlist:[{playId:'p01',start:10,end:14}]};}
const settings={sourceSha256:'1'.repeat(64),renderer:'test',rendererSha256:'2'.repeat(64),assets:[{name:'renderer',sha256:'2'.repeat(64)}],font:{family:'test',sha256:'3'.repeat(64)},audio:{mode:'silent'},width:1280,height:720,fps:25};
const pending=()=>createLocalStoryPlan(fixture());
const approved=async()=>reviewStoryPlan(await pending(),{reviewer:'Test reviewer',reason:'Checked source anchors, wording and geometry.'});

test('local evidence plan preserves input and accurate source→presentation timing',async()=>{const project=fixture(),plan=await createLocalStoryPlan(project);assert.equal(plan.generation.model,'none');assert.equal(plan.generation.kind,'deterministic-evidence');assert.deepEqual(plan.inputSnapshot.project,project);assert.equal(plan.review.status,'pending');assert.equal((await verifyStoryPlan(plan,project)).ok,true);const map=storyTimeMap(plan);assert.equal(map.duration,4);assert.deepEqual(map.clips[0],{playId:'p01',start:10,end:14,outputStart:0,outputEnd:4});assert.equal(map.cues[1].sourceStart,11);assert.equal(map.cues[1].start,1);assert.equal(map.cues[2].start,3);await assert.rejects(()=>verifyStoryPlan(plan,project,{requireReviewed:true}),/human review/);});

test('manual edits and original engine wording are retained and require review',async()=>{const project=fixture(),p=project.plays[0],a=analyzePossession(p),n=buildNarration(p,a);n.cues=n.cues.map(c=>({...c,originalText:c.text,text:c.start===11?'输入概率为 62%。':c.text,origin:c.start===11?'manual':'evidence-engine'}));const plan=await createLocalStoryPlan(project,{analyses:{p01:a},narrations:{p01:n},question:'Read source probability'});assert.equal(plan.cues[1].text,'输入概率为 62%。');assert.equal(plan.cues[1].origin,'manual');assert.match(plan.cues[1].originalText,/预期命中概率/);assert.ok(plan.cues[1].facts.some(f=>f.evidenceId==='p01:metric:difficulty'&&f.format==='percent'));const reviewed=await reviewStoryPlan(plan,{reviewer:'Editor',reason:'Explicit manual wording reviewed against probability evidence.'});assert.equal((await verifyStoryPlan(reviewed,project,{requireReviewed:true})).ok,true);assert.deepEqual(reviewed.generation.proposal.cues,plan.generation.proposal.cues);});

test('external provider proposal can supply new prose with explicit numeric facts',async()=>{const project=fixture(),proposal={title:'A reviewed probability',clips:[{playId:'p01',start:10,end:14}],cues:[{id:'external-1',playId:'p01',start:11,end:13,text:'输入概率为 62%。',evidenceIds:['p01:metric:difficulty'],playerIds:['Alice'],facts:[{evidenceId:'p01:metric:difficulty',path:'',value:.62,format:'percent',decimals:0}],basisStart:null,originalText:'',origin:'external-model'}]};const plan=await createStoryPlan(project,proposal,{generation:{kind:'external-model',provider:'provider-neutral',model:'reported-model-id',prompt:'Use only supplied evidence.',request:{question:'Explain probability'}}});assert.equal(plan.cues[0].clipIndex,0);assert.deepEqual(plan.generation.proposal,proposal);assert.equal(plan.generation.prompt,'Use only supplied evidence.');assert.equal((await verifyStoryPlan(plan)).ok,true);});

test('repeated source clips have distinct cue occurrences, without duplicate captions',async()=>{const project=fixture();project.playlist.push({playId:'p01',start:11,end:14});const plan=await createLocalStoryPlan(project),map=storyTimeMap(plan);assert.equal(map.duration,7);assert.equal(map.cues.length,5);assert.equal(map.cues.filter(c=>c.clipIndex===1).length,2);assert.equal(map.cues.find(c=>c.clipIndex===1).start,4);assert.equal(map.cues.at(-1).sourceStart,13);assert.equal(map.cues.at(-1).start,6);});

test('rejects unknown play, player and evidence ids, including cross-play references',async()=>{const plan=await pending();for(const [field,value,pattern] of [['playId','missing',/play id/],['playerIds',['Bob'],/player id/],['evidenceIds',['p02:event'],/evidence id/]]){const bad=structuredClone(plan);bad.cues[0][field]=value;assert.throws(()=>validateStoryPlan(bad),pattern);}const project=fixture();project.plays.push({...structuredClone(project.plays[0]),id:'p02',player:'Bob',start:15,end:19,shotTime:16,resultTime:18});const two=await createLocalStoryPlan(project);const bad=structuredClone(two);bad.cues[0].text='Bob 进攻。';assert.throws(()=>validateStoryPlan(bad),/another play/);bad.cues[0].text=two.cues[0].text;bad.cues[0].evidenceIds=['p02:event'];assert.throws(()=>validateStoryPlan(bad),/cross-play/);});

test('rejects future metric and outcome disclosures and invalid source windows',async()=>{const plan=await pending();const early=structuredClone(plan);early.cues[1].start=10.5;assert.throws(()=>validateStoryPlan(early),/future evidence/);const outcome=structuredClone(plan);outcome.cues[2].start=12;assert.throws(()=>validateStoryPlan(outcome),/future evidence/);for(const change of [{start:9},{end:20},{start:NaN},{end:10}]){const bad=structuredClone(plan);Object.assign(bad.clips[0],change);assert.throws(()=>validateStoryPlan(bad));}const contradiction=structuredClone(plan);contradiction.cues[2].text='本次投篮未中。';assert.throws(()=>validateStoryPlan(contradiction),/contradicts/);});

test('rewriting a probability cue as a made-shot result cannot inherit probability evidence',async()=>{const plan=await pending(),bad=structuredClone(plan);bad.cues[1].text='投篮命中。';bad.cues[1].origin='manual';assert.throws(()=>validateStoryPlan(bad),/Outcome narration requires/);});

test('rejects invented numeric assertions and changed fact values',async()=>{const plan=await pending();const invented=structuredClone(plan);invented.cues[1].text='输入概率为 99%。';assert.throws(()=>validateStoryPlan(invented),/Unsupported number/);const inventedFact=structuredClone(plan);inventedFact.cues[1].facts[0].value=.99;assert.throws(()=>validateStoryPlan(inventedFact),/Unsupported numeric fact/);const path=structuredClone(plan);path.cues[1].facts[0].path='__proto__.evil';assert.throws(()=>validateStoryPlan(path),/fact path/);});

test('numeric checks include Chinese-adjacent digits, fullwidth digits, scientific notation and Unicode negative signs',async()=>{const plan=await pending();for(const text of ['概率为99%。','概率为９９%。','概率为−62%。','概率为负62%。','概率为1e2%。']){const bad=structuredClone(plan);bad.cues[1].text=text;assert.throws(()=>validateStoryPlan(bad),/Unsupported number/);}const project=fixture();const a=analyzePossession(project.plays[0]),n=buildNarration(project.plays[0],a);n.cues[1].text='新增事实为0.62。';n.cues[1].originalText=buildNarration(project.plays[0],a).cues[1].text;n.cues[1].origin='manual';await assert.rejects(()=>createLocalStoryPlan(project,{analyses:{p01:a},narrations:{p01:n}}),/Supply its evidence fact handle/);});

test('a fractional coordinate is not automatically interpreted as a probability',async()=>{const plan=await pending(),bad=structuredClone(plan);bad.inputSnapshot.analyses.p01.evidence.find(e=>e.id==='p01:metric:difficulty').unit='ft';bad.inputSnapshot.analyses.p01.evidence.find(e=>e.id==='p01:metric:difficulty').semantics='coordinate-distance';assert.throws(()=>validateStoryPlan(bad),/declared 0–1 probability/);});

test('arrow windows, players, points and layers are bounded',async()=>{const plan=await pending(),arrow={id:'a1',playId:'p01',start:10,end:12,evidenceIds:['p01:event'],playerId:'Alice',origin:'manual',points:[{x:.1,y:.2},{x:.7,y:.8}],color:'#ffb454'};const good=await reviseStoryPlan(plan,{arrows:[arrow]});assert.equal(validateStoryPlan(good).ok,true);for(const patch of [{playerId:'missing'},{start:9},{points:[{x:2,y:0},{x:0,y:0}]},{origin:'model'}]){const bad=structuredClone(good);Object.assign(bad.arrows[0],patch);assert.throws(()=>validateStoryPlan(bad));}const layers=structuredClone(good);layers.layers.invented=true;assert.throws(()=>validateStoryPlan(layers),/layer/);});

test('content edits invalidate review, record parents, and change render identity',async()=>{const initial=await approved(),first=await renderIdentity(initial,settings);const cues=structuredClone(initial.cues);cues[1].text='输入概率为 62%。';cues[1].origin='manual';const edited=await reviseStoryPlan(initial,{cues},{actor:'Human editor'});assert.equal(edited.review.status,'pending');assert.equal(edited.revision,1);assert.equal(edited.history[0].parentPlanHash,initial.planHash);assert.notEqual(edited.contentHash,initial.contentHash);assert.notEqual(edited.planHash,initial.planHash);await assert.rejects(()=>renderIdentity(edited,settings),/human review/);const reapproved=await reviewStoryPlan(edited,{reviewer:'Human editor'});assert.notEqual(await renderIdentity(reapproved,settings),first);assert.equal(reapproved.generation.proposal.cues[1].text,initial.generation.proposal.cues[1].text);assert.equal(reapproved.history[0].changes.cues[1].text,cues[1].text);});

test('render identity includes arrows, layers, clip time, audio, font, assets, renderer and dimensions',async()=>{const plan=await approved(),identity=await renderIdentity(plan,settings);for(const patch of [{font:{family:'test',sha256:'4'.repeat(64)}},{audio:{mode:'file',sha256:'4'.repeat(64)}},{rendererSha256:'4'.repeat(64)},{assets:[{name:'renderer',sha256:'4'.repeat(64)}]},{width:640},{fps:30},{sourceSha256:'4'.repeat(64)}])assert.notEqual(await renderIdentity(plan,{...settings,...patch}),identity);for(const change of [{layers:{...plan.layers,paths:false}},{title:'New title'},{arrows:[{id:'a1',playId:'p01',start:10,end:12,evidenceIds:['p01:event'],playerId:null,origin:'manual',points:[{x:.2,y:.3},{x:.8,y:.3}]}]}]){const next=await reviewStoryPlan(await reviseStoryPlan(plan,change),{reviewer:'Editor'});assert.notEqual(await renderIdentity(next,settings),identity);}await assert.rejects(()=>renderIdentity(plan,{...settings,font:{family:'x'}}),/Font/);});

test('inference cache is deterministic and excludes presentation edits',async()=>{const args={input:{a:1,b:2},provider:'x',model:'m',prompt:'p',promptVersion:'1',parameters:{temperature:0}};assert.equal(await inferenceIdentity(args),await inferenceIdentity({...args,input:{b:2,a:1}}));for(const patch of [{model:'n'},{prompt:'q'},{input:{a:2}},{provider:'y'},{parameters:{temperature:1}}])assert.notEqual(await inferenceIdentity(args),await inferenceIdentity({...args,...patch}));});

test('tampering and changed original input cannot retain old review hashes',async()=>{const plan=await approved();const bad=structuredClone(plan);bad.cues[1].text='输入概率为 62%。';await assert.rejects(()=>verifyStoryPlan(bad),/hash mismatch/);const modified=fixture();modified.revision=1;await assert.rejects(()=>verifyStoryPlan(plan,modified),/Project changed/);const history=structuredClone(plan);history.generation.prompt='altered';await assert.rejects(()=>verifyStoryPlan(history),/hash mismatch/);});

test('self-consistent forged evidence snapshots still fail the original-project check',async()=>{const plan=await approved(),bad=structuredClone(plan);bad.inputSnapshot.analyses.p01.evidence.find(e=>e.id==='p01:metric:difficulty').value=.99;bad.cues[1].facts=bad.cues[1].facts.map(f=>({...f,value:.99}));bad.cues[1].text='输入概率为 99%。';bad.inputHash=await hashJSON(bad.inputSnapshot);bad.generation.inferenceIdentity=await inferenceIdentity({input:bad.inputSnapshot,provider:bad.generation.provider,model:bad.generation.model,prompt:bad.generation.prompt,promptVersion:bad.generation.promptVersion,parameters:bad.generation.parameters,request:bad.generation.request});bad.contentHash=await hashJSON({schema:bad.schema,inputHash:bad.inputHash,title:bad.title,clips:bad.clips,cues:bad.cues,arrows:bad.arrows,layers:bad.layers});bad.review.contentHash=bad.contentHash;const {planHash,...rest}=bad;bad.planHash=await hashJSON(rest);await assert.rejects(()=>verifyStoryPlan(bad),/does not match calculations/);});

test('schema rejects unexpected fields, long prose, and non-JSON values',async()=>{const plan=await pending();const extra=structuredClone(plan);extra.cues[0].secret='unbounded';assert.throws(()=>validateStoryPlan(extra),/Unknown cue field/);const long=structuredClone(plan);long.cues[0].text='x'.repeat(1201);assert.throws(()=>validateStoryPlan(long),/too long/);assert.throws(()=>canonicalJSON({x:Infinity}),/Non-finite/);assert.throws(()=>canonicalJSON({x:undefined}),/Only JSON/);});

test('different inference questions and audiences cannot share a generation cache key',async()=>{const args={input:{a:1},provider:'x',model:'m',prompt:'same',promptVersion:'1',parameters:{},request:{question:'Explain spacing',audience:'fan'}};assert.notEqual(await inferenceIdentity(args),await inferenceIdentity({...args,request:{question:'Explain difficulty',audience:'fan'}}));assert.notEqual(await inferenceIdentity(args),await inferenceIdentity({...args,request:{question:'Explain spacing',audience:'analyst'}}));});

function numericProposal(project,{value=.62,format='percent',decimals=2,text='输入概率为0.62%。'}={}) {
  const p=project.plays[0],evidenceId=analyzePossession(p).metrics.difficulty.evidenceId;return {title:'Unit-bound imported proposal',clips:[{playId:p.id,start:p.start,end:p.end}],cues:[{id:'unit-cue',clipIndex:0,playId:p.id,start:p.shotTime,end:p.resultTime??p.end,text,evidenceIds:[evidenceId],playerIds:[],facts:[{evidenceId,path:'',value,format,decimals}],origin:'external-model',basisStart:null,originalText:''}]};
}
function percentV2(value){const bundle=JSON.parse(readFileSync(new URL('../pro/fixtures/metrics-v2-sample.json',import.meta.url),'utf8'));bundle.records[0].value=value;return parseInput(JSON.stringify(bundle),'unit-regression.json').project;}
const sourceArrow=()=>({id:'ui-arrow',kind:'arrow',origin:'manual',source:'manual',start:10,end:14,points:[[.1,.2],[.7,.8]],frame_reviewed:true,evidence_id:'p01:manual',label:'人工箭头'});

test('percent unit retains the original percent value through creation, review and verification',async()=>{
  for(const value of [.62,62]){const project=percentV2(value);
    const plan=await createStoryPlan(project,numericProposal(project,{value,text:`输入概率为${value}%。`}));
    const reviewed=await reviewStoryPlan(plan,{reviewer:'Unit reviewer',reason:'Original percent unit and wording checked.'});assert.equal((await verifyStoryPlan(reviewed,project,{requireReviewed:true})).ok,true);assert.equal((await verifyStoryPlan(await reviewStoryPlan(await createLocalStoryPlan(project),{reviewer:'Local unit reviewer'}))).ok,true);
  }
});

test('semantic probability labels never multiply a percent or unrelated unit by 100',async()=>{
  for(const unit of ['percent','ft','index']){const project=unit==='percent'?percentV2(.62):fixture();if(unit!=='percent')project.plays[0].metrics.difficulty.unit=unit;
    await assert.rejects(()=>createStoryPlan(project,numericProposal(project,{text:'输入概率为62%。',decimals:0})),unit==='percent'?/Unsupported number/:/declared 0–1 probability/);
  }
});

test('probability unit supports 62 percent and rejects the unconverted 0.62 percent claim',async()=>{
  const project=fixture();const plan=await createStoryPlan(project,numericProposal(project,{text:'输入概率为62%。',decimals:0}));
  assert.equal((await verifyStoryPlan(await reviewStoryPlan(plan,{reviewer:'Probability reviewer'}))).ok,true);
  await assert.rejects(()=>createStoryPlan(project,numericProposal(project)),/Unsupported number/);
});

test('percentage text cannot borrow an engine baseline or a raw unrelated numeric handle',async()=>{
  const project=fixture();project.plays[0].metrics.difficulty.unit='percent';await assert.rejects(()=>createLocalStoryPlan(project),/Unsupported number/);
  const input=fixture();input.plays[0].metrics.difficulty={value:62,semantics:'unrelated',availableAt:11,unit:'index'};
  await assert.rejects(()=>createStoryPlan(input,numericProposal(input,{value:62,format:'raw',text:'指标为62%。'})),/correctly unit-bound/);
});

test('local defaults preserve UI manual geometry, source metadata and pending human review',async()=>{
  const project=fixture();project.plays[0].annotations=[sourceArrow()];const saved=structuredClone(project),plan=await createLocalStoryPlan(project);
  assert.equal(plan.arrows.length,1);assert.deepEqual(plan.arrows[0].points,[{x:.1,y:.2},{x:.7,y:.8}]);assert.equal(plan.arrows[0].playId,'p01');assert.deepEqual(plan.arrows[0].evidenceIds,['p01:event']);
  assert.deepEqual(plan.arrows[0].sourceAnnotation,{id:'ui-arrow',start:10,end:14,points:[[.1,.2],[.7,.8]],origin:'manual',source:'manual',evidenceId:'p01:manual',frameReviewed:true});
  assert.equal(plan.review.status,'pending');await assert.rejects(()=>verifyStoryPlan(plan,project,{requireReviewed:true}),/human review/);
  assert.equal((await verifyStoryPlan(await reviewStoryPlan(plan,{reviewer:'Geometry reviewer',reason:'Paused frame source coordinates reviewed.'}),project,{requireReviewed:true})).ok,true);assert.deepEqual(project,saved);
});

test('explicit empty and edited arrows remain authoritative for local and external proposals',async()=>{
  const project=fixture();project.plays[0].annotations=[sourceArrow()];const initial=await createLocalStoryPlan(project);
  assert.deepEqual((await createLocalStoryPlan(project,{arrows:[]})).arrows,[]);
  const edited={...initial.arrows[0],points:[{x:.2,y:.4},{x:.8,y:.4}]};assert.deepEqual((await createLocalStoryPlan(project,{arrows:[edited]})).arrows[0].points,edited.points);
  const external={title:initial.title,clips:initial.clips,cues:initial.cues,arrows:[]};assert.deepEqual((await createStoryPlan(project,external)).arrows,[]);delete external.arrows;assert.deepEqual((await createStoryPlan(project,external)).arrows,[]);
  const revised=await reviseStoryPlan(await reviewStoryPlan(initial,{reviewer:'Editor'}),{arrows:[]});assert.deepEqual(revised.arrows,[]);assert.equal(revised.review.status,'pending');assert.notEqual(revised.contentHash,initial.contentHash);
  for(const arrows of [null,{},undefined])await assert.rejects(()=>createLocalStoryPlan(project,{arrows}));
});

test('source annotation coordinates, windows, references, review flags and provenance are bounded',async()=>{
  for(const mutate of [a=>a.points[0][0]=1.1,a=>a.start=9,a=>a.end=Infinity,a=>a.frame_reviewed=false,a=>a.frame_reviewed='true',a=>a.evidenceIds=['p01:outcome'],a=>a.playerId='Missing']){
    const project=fixture();project.plays[0].annotations=[sourceArrow()];mutate(project.plays[0].annotations[0]);await assert.rejects(()=>createLocalStoryPlan(project));
  }
  const project=fixture();project.plays[0].annotations=[sourceArrow()];const plan=await createLocalStoryPlan(project),bad=structuredClone(plan);bad.arrows[0].sourceAnnotation.points[0][0]=.9;assert.throws(()=>validateStoryPlan(bad),/does not match/);
  assert.throws(()=>validateStoryPlan(plan,project,{requireReviewed:'false'}),/must be boolean/);
});

test('source arrows are clipped once for repeated and overlapping playlist windows',async()=>{
  const project=fixture();project.plays[0].annotations=[sourceArrow()];project.playlist=[{playId:'p01',start:10,end:12},{playId:'p01',start:11,end:14},{playId:'p01',start:10,end:12}];
  const plan=await createLocalStoryPlan(project);assert.deepEqual(plan.arrows.map(a=>[a.start,a.end]),[[10,12],[12,14]]);assert.deepEqual(plan.arrows[0].sourceAnnotation.points,sourceArrow().points);
  const {storyFrameAt}=await import('../pro/camera-view.mjs');for(const t of [10.5,11.5,12,13.5])assert.equal(storyFrameAt(project,project.plays[0],t,plan).arrows.length,1);assert.equal(storyFrameAt(project,project.plays[0],14,plan).arrows.length,0);
});


test('previously multiplied percent facts fail validation, human review and verification',async()=>{
  const previous=await approved();previous.inputSnapshot.analyses.p01.evidence.find(e=>e.id==='p01:metric:difficulty').unit='percent';
  assert.throws(()=>validateStoryPlan(previous),/Unsupported number/);await assert.rejects(()=>reviewStoryPlan(previous,{reviewer:'Editor'}),/Unsupported number/);await assert.rejects(()=>verifyStoryPlan(previous),/Unsupported number/);
});

test('manual source-only and legacy arrows without frame flags still require final human review',async()=>{
  const project=fixture(),annotation=sourceArrow();delete annotation.origin;delete annotation.frame_reviewed;project.plays[0].annotations=[annotation];
  const plan=await createLocalStoryPlan(project);assert.equal(plan.arrows.length,1);assert.equal(plan.arrows[0].sourceAnnotation.origin,null);assert.equal(plan.arrows[0].sourceAnnotation.frameReviewed,null);assert.equal(plan.review.status,'pending');
  assert.equal((await verifyStoryPlan(await reviewStoryPlan(plan,{reviewer:'Legacy geometry reviewer',reason:'Original frame and coordinates were explicitly reviewed.'}),project,{requireReviewed:true})).ok,true);
});
