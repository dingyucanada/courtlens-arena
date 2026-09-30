import assert from 'node:assert/strict';
import {maxAnalysisWindow,providerName,validateAnalysisScope,visualChoices,writingProviders} from '../broadcast/capability_ui.mjs';

const capabilities={providers:[
  {id:'stepfun-vision',kind:'semantic',available:true,verified:false,modalities:['image','text']},
  {id:'stepfun-story',kind:'semantic',available:true,verified:false,modalities:['text']},
  {id:'bedrock-video',kind:'semantic',available:false,modalities:['video','image','text']},
  {id:'agentcore-story',kind:'semantic',available:true,modalities:['text']},
]};
assert.deepEqual(visualChoices(capabilities).map(choice=>[choice.provider.id,choice.strategy]),[
  ['stepfun-vision','frames-first'],
]);
assert.deepEqual(writingProviders(capabilities).map(provider=>provider.id),['stepfun-story','agentcore-story']);
assert.equal(providerName(capabilities.providers[0]),'阶跃星辰');
assert.equal(maxAnalysisWindow(capabilities.providers[0],'frames-first'),48);
assert.deepEqual(validateAnalysisScope(4.5,6.5,180,capabilities.providers[0],'frames-first'),{start:4.5,end:6.5});
assert.throws(()=>validateAnalysisScope(0,48.01,180,capabilities.providers[0],'frames-first'),/48 秒/);

const cloud={providers:[
  {id:'agentcore-proposal',kind:'semantic',available:true,modalities:['video','image','text']},
  {id:'agentcore-story',kind:'semantic',available:true,modalities:['text']},
]};
assert.deepEqual(visualChoices(cloud).map(choice=>choice.strategy),['video-first','frames-first']);
assert.equal(maxAnalysisWindow(cloud.providers[0],'video-first'),90);
assert.equal(maxAnalysisWindow(cloud.providers[0],'frames-first'),180);
assert.throws(()=>validateAnalysisScope(0,90.01,180,cloud.providers[0],'video-first'),/90 秒/);
assert.deepEqual(validateAnalysisScope(0,180,180,cloud.providers[0],'frames-first'),{start:0,end:180});
assert.throws(()=>validateAnalysisScope(20,181,180,cloud.providers[0],'frames-first'),/源片内/);
assert.deepEqual(writingProviders(cloud).map(provider=>provider.id),['agentcore-story']);
assert.deepEqual(visualChoices({providers:[{id:'agentcore-story',kind:'semantic',available:true,modalities:['text']}]}),[]);
console.log('Capability UI separates tested visual strategies from text-only writing providers');
