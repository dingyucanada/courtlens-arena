import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

globalThis.crypto ||= webcrypto;
const memory=new Map();
globalThis.sessionStorage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
globalThis.location={href:'https://test.example/broadcast/'};
const requests=[];
globalThis.fetch=async (url,options={})=>{
  if(url==='/cloud-config.json')return {ok:true,json:async()=>({schema:'courtlens-cloud-config/1',clientId:'public-client',hostedUiDomain:'https://auth.test.example',redirectUri:'https://test.example/broadcast/'})};
  requests.push({url,options});
  return {ok:true,status:202,json:async()=>({data:{id:'job-test',type:url.endsWith('/story')?'model-story':'frames'}})};
};

const {initCloudAuth}=await import('../broadcast/auth.mjs');
const {api}=await import('../broadcast/api.mjs');
assert.equal(await initCloudAuth(),true);
const project={id:'project-test',revision:7};
await api.frames(project,[1]);
await api.analyze(project,'model-test',{start:0,end:2},'frames-first');
await api.cv(project,'cv-test',{start:0,end:2});
const modelStoryJob=await api.story(project,'fan','model','agentcore-story');
assert.equal(modelStoryJob.type,'model-story');
await api.probe('model-test',project,null,{start:0,end:2});
await api.render(project,'silent');
await api.commitUpload(project,{size:5,type:'video/mp4',name:'clip.mp4'},'a'.repeat(64),'upload-test');
const seen=new Set();
for(const {url,options} of requests){
  const key=options.headers?.['Idempotency-Key'];
  assert.match(key||'',/^[0-9a-f-]{36}$/i,`${url} must send a task idempotency key`);
  assert.ok(!seen.has(key),`${url} reused a task key`);
  seen.add(key);
}
assert.equal(requests.length,7);
console.log('7 cloud task-entry requests carry unique idempotency keys');
