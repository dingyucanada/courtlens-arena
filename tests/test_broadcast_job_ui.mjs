import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src=fs.readFileSync(new URL('../broadcast/app.mjs',import.meta.url),'utf8');
const slice=(start,end)=>src.slice(src.indexOf(start),src.indexOf(end,src.indexOf(start)));
function harness(state,api,memory=new Map()){
  const errors=[];
  const context={state,api,finite:Number.isFinite,Date,JSON,
    sessionStorage:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},
    clearTimeout(){},setTimeout(){return 1},notify(){},render(){},handleError:e=>errors.push(e),
    beginDefaultAnalysis:async()=>{context.analysisProjects.push(state.project.id)},analysisProjects:[]};
  vm.createContext(context);
  vm.runInContext(slice('async function pollJob()', 'async function beginDefaultAnalysis()')+
    slice('async function restoreLastJob()', 'function checked('),context);
  return {context,errors,memory};
}
const A={id:'A',media:{},mode:'assisted',revision:2},B={id:'B',media:{},mode:'assisted',revision:7};
const done={id:'jobA',projectId:'A',type:'ingest',status:'succeeded'};
{
  const edits=[];
  const {context}=harness({project:B,job:done},{job:async()=>done,project:async()=>B,edit:async(p)=>{edits.push(p.id);return p}});
  await context.pollJob();
  assert.deepEqual(edits,[],'A completion must not mutate B');
  assert.equal(context.state.project.id,'B');
}
{
  const source={kind:'user-provided',label:'A source',rightsNote:'development'};
  const memory=new Map([['courtlens.broadcast.job.A','jobA'],['courtlens.broadcast.upload.A',JSON.stringify({source,jobId:'jobA'})]]);
  const edits=[];
  const {context,errors}=harness({project:A,job:null},{job:async()=>done,project:async()=>A,edit:async(p,patch)=>{edits.push({id:p.id,source:patch.source});return {...p,revision:3}}},memory);
  await context.restoreLastJob();
  await context.pollJob();
  assert.equal(edits.length,1);assert.equal(edits[0].id,'A');assert.equal(edits[0].source.label,'A source');
  assert.equal(context.analysisProjects[0],'A');
  assert.equal(memory.has('courtlens.broadcast.upload.A'),false);assert.equal(errors.length,0);
}
{
  const state={project:A,job:done};const edits=[];
  const {context}=harness(state,{job:async()=>done,project:async()=>{state.project=B;return A},edit:async()=>edits.push('wrong')});
  await context.pollJob();assert.equal(context.state.project.id,'B');assert.deepEqual(edits,[]);
}
console.log('3 project-scoping and refresh-continuation scenarios passed');
