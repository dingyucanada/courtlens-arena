/** Real IndexedDB integration tests. In a browser: (await import('./studio/store.test.mjs')).runStoreTests(). */
import {StudioStore} from './store.mjs';
import {createProject,id} from './domain.mjs';
const assert = (condition,message = 'Assertion failed') => {if (!condition) throw new Error(message);};
async function rejects(action,code) {
  try {await action();} catch (error) {if (code) assert(error.code===code,`Expected ${code}, received ${error.code}: ${error.message}`);return error;}
  throw new Error(`Expected operation to reject${code ? ` with ${code}` : ''}.`);
}
const play = () => ({id:'p1',start:0,end:5,shotTime:3,resultTime:4,shooter:'A',team:'HOME',points:3,made:true,tag:'Test',notes:'',reviewed:false,xfg:null,x:null,y:null,source:'Manual annotation'});
const fixture = () => ({...createProject({name:'IndexedDB integration',source:'Local original footage'}),video:{id:id('test-media'),name:'game.mp4',size:3,duration:10,width:1280,height:720,sha256:''},plays:[play()]});
export async function runStoreTests() {
  if (!globalThis.indexedDB) throw new Error('Run store integration tests in a browser with actual IndexedDB.');
  const dbName=`courtlens-store-test-${id()}`, a=new StudioStore(dbName),b=new StudioStore(dbName),results=[];
  const run=async(name,test)=>{try{await test();results.push({name,status:'passed'});}catch(error){results.push({name,status:'failed',message:error.message});}};
  try {
    await Promise.all([a.open(),b.open()]);
    await run('initial save starts revision 1 and returned projects are detached clones',async()=>{
      const input=fixture(),saved=await a.save(input,0);assert(saved.revision===1);assert(input.revision===0);saved.name='Mutated client';input.name='Mutated input';assert((await a.get(saved.id)).name==='IndexedDB integration');
    });
    await run('two-tab competing saves commit exactly one revision without lost updates',async()=>{
      const saved=await a.save(fixture(),0);
      const [one,two]=await Promise.all([a.get(saved.id),b.get(saved.id)]);one.name='Tab A';two.name='Tab B';
      const outcomes=await Promise.allSettled([a.save(one,1),b.save(two,1)]);
      assert(outcomes.filter(x=>x.status==='fulfilled').length===1);const failure=outcomes.find(x=>x.status==='rejected');assert(failure.reason.code==='CONFLICT');assert((await a.history(saved.id)).length===2);assert((await a.get(saved.id)).revision===2);
    });
    await run('stale expected revision rejects atomically without adding history',async()=>{
      const p=await a.save(fixture(),0);await rejects(()=>b.save({...p,name:'Stale'},0),'CONFLICT');assert((await a.get(p.id)).name===p.name);assert((await a.history(p.id)).length===1);
    });
    await run('history holds immutable detached snapshots in descending revision order',async()=>{
      const p=await a.save(fixture(),0);const q=await a.save({...p,name:'Revision two'},1);const history=await a.history(p.id);assert(history.length===2&&history[0].revision===2&&history[1].revision===1);assert(history[1].project.name===p.name);history[1].project.name='Changed';assert((await a.history(p.id))[1].project.name===p.name);assert(q.revision===2);
    });
    await run('play content changes reset that review and invalidate prior approval',async()=>{
      let p=fixture();p.video.url='media/demo.mp4';p=await a.save(p,0);p.plays[0].reviewed=true;p=await a.save(p,1);p.status='approved';p=await a.save(p,2);assert(p.status==='approved');p.plays[0].notes='Correction';p=await a.save(p,3);assert(p.status==='draft');assert(p.plays[0].reviewed===false);
    });
    await run('project-only edits invalidate approval while retaining unchanged play reviews',async()=>{
      let p=fixture();p.video.url='media/demo.mp4';p.plays[0].reviewed=true;p.status='approved';p=await a.save(p,0);p.name='New project title';p=await a.save(p,1);assert(p.status==='draft');assert(p.plays[0].reviewed===true);
    });
    await run('video rebinding clears every play review',async()=>{
      let p=fixture();p.plays[0].reviewed=true;p=await a.save(p,0);p.video.id=id('new-media');p=await a.save(p,1);assert(p.plays[0].reviewed===false&&p.status==='draft');
    });
    await run('approved local projects require the actual matching stored blob',async()=>{
      let p=fixture();p.plays[0].reviewed=true;p.status='approved';await rejects(()=>a.save(p,0),'MEDIA_MISSING');assert(await a.get(p.id)===null);assert((await a.history(p.id)).length===0);
      await a.putMedia(p.video.id,new Blob(['123']));p=await a.save(p,0);assert(p.status==='approved');assert(await(await a.getMedia(p.video.id)).text()==='123');
    });
    await run('different video byte size cannot satisfy approval',async()=>{
      const p=fixture();p.plays[0].reviewed=true;p.status='approved';await a.putMedia(p.video.id,new Blob(['123456']));await rejects(()=>a.save(p,0),'MEDIA_MISMATCH');assert(await a.get(p.id)===null);
    });
    await run('media IDs cannot be overwritten to bypass reviewed source binding',async()=>{
      const mediaId=id('immutable-media');await a.putMedia(mediaId,new Blob(['original']));await rejects(()=>b.putMedia(mediaId,new Blob(['replacement'])));assert(await(await a.getMedia(mediaId)).text()==='original');
    });
    await run('restore creates a new revision and preserves old history',async()=>{
      const initial=fixture();initial.plays[0].reviewed=true;initial.plays[0].sourceEvidence={record:{metrics:{gravity:1.8,leverage:.82},tracks:[{x:.2,y:.3}]},metricSemantics:{gravity:'source-defined'}};let p=await a.save(initial,0);const originalName=p.name;p=await a.save({...p,name:'Edited title'},1);p=await b.restore(p.id,1,2);assert(p.revision===3&&p.name===originalName&&p.status==='draft');assert(p.plays.every(play=>play.reviewed===false));assert(p.plays[0].sourceEvidence.record.metrics.gravity===1.8);assert(p.plays[0].sourceEvidence.record.tracks.length===1);const history=await a.history(p.id);assert(history.length===3&&history[1].name==='Edited title');await rejects(()=>a.restore(p.id,1,2),'CONFLICT');
    });
    await run('missing history restore leaves project and history unchanged',async()=>{
      const p=await a.save(fixture(),0);await rejects(()=>a.restore(p.id,99,1));assert((await a.get(p.id)).revision===1);assert((await a.history(p.id)).length===1);
    });
    await run('archive is revision checked and persists across database reopening',async()=>{
      const p=await a.save(fixture(),0);const archived=await a.archive(p.id,1);assert(archived.archived===true&&archived.revision===2);await rejects(()=>b.archive(p.id,1),'CONFLICT');a.close();await a.open();assert((await a.get(p.id)).archived===true);assert((await a.list()).some(x=>x.id===p.id));
    });
    await run('malformed and accessor-based objects are rejected before persistence',async()=>{
      let called=false;const p=fixture();Object.defineProperty(p,'name',{get(){called=true;return 'Unsafe';},enumerable:true});await rejects(()=>a.save(p,0),'VALIDATION');assert(called===false);const q=fixture();q.plays[0].start=-1;await rejects(()=>a.save(q,0),'VALIDATION');assert(await a.get(q.id)===null);
    });
    await run('unknown project/media reads return null and storage info is explicit',async()=>{
      assert(await a.get('nonexistent')===null);assert(await a.getMedia('nonexistent')===null);const info=await a.storageInfo();assert('usage' in info&&'quota' in info&&typeof info.persisted==='boolean');
    });
  } finally {
    a.close();b.close();
    await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(dbName);request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Test database cleanup was blocked.'));});
  }
  return {passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,total:results.length,results};
}
