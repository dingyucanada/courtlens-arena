/** UI boundary regression tests. These execute actual app handlers with deterministic
 * DOM/storage doubles; media decoding, IndexedDB and layout still require browser QA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as domain from './domain.mjs';
import * as exporter from './export.mjs';

const source=(await readFile(new URL('./app.mjs',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'').replace(/\ninit\(\);\s*$/,'');
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const fixture=(name='Audit')=>{const p=domain.createProject({name,source:'Manual'});p.plays=domain.parseImport(JSON.stringify([{id:'p1',start:1.23,end:5.345,shotTime:3.125,resultTime:4.25,shooter:'A',team:'H',points:2,made:null,xfg:.425,x:.1234,y:.5678,source:'Manual'}])).plays;p.playlist=[{id:'clip1',playId:'p1',in:1.23,out:5.345,title:'Original title'}];return p;};
function harness(){
  const records=new Map(),saved=[],docListeners=new Map(),winListeners=new Map(),nodes=new Map();
  const node=()=>({textContent:'',innerHTML:'',hidden:true,open:false,isConnected:true,dataset:{},listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn);},removeAttribute(){},load(){},pause(){},showModal(){this.open=true;},close(){this.open=false;}});
  for(const id of ['toast','main','page-label','navigation','active-project','dialog','dialog-content','video-file','data-file','backup-file'])nodes.set('#'+id,node());
  const location={hash:'#/overview'};
  const history={pushState(_a,_b,url){location.hash=url;},replaceState(_a,_b,url){location.hash=url;}};
  let getHook=null,pendingVideo=null;
  class FakeStore {async open(){}async save(p){const copy=structuredClone(p);saved.push(copy);records.set(p.id,copy);return copy;}async get(key){return getHook?getHook(key):structuredClone(records.get(key));}async list(){return [...records.values()];}async putMedia(){}async getMedia(){return new Blob(['local media']);}}
  const add=(map,type,fn)=>map.set(type,[...(map.get(type)||[]),fn]);
  const document={querySelector:s=>nodes.get(s)||null,querySelectorAll:s=>s.split(',').map(key=>nodes.get(key)).filter(Boolean),addEventListener:(type,fn)=>add(docListeners,type,fn),createElement(tag){assert.equal(tag,'video');pendingVideo={...node(),duration:15,videoWidth:1280,videoHeight:720};return pendingVideo;}};
  const window={history,scrollTo(){},addEventListener:(type,fn)=>add(winListeners,type,fn)};
  const localStorage={getItem(){return null;},setItem(){}};
  const app=new Function('deps',`const {createProject,demoProject,validateProject,parseImport,summarize,playerKey,toCSV,projectBackup,readBackup,id,makeReport,makeVTT,recordPlaylist,StudioStore,document,window,location,localStorage,setTimeout,clearTimeout}=deps;\n${source}\nreturn {state,field,playForm,sourceEvidenceHTML,filtersHTML,filteredPlays,playlistView,runAction,navigate,attachVideo,bindVideo,render,setBusy,setRender(fn){render=fn;}};`)({...domain,...exporter,StudioStore:FakeStore,document,window,location,localStorage,setTimeout:()=>1,clearTimeout:()=>{}});
  let renders=0;app.setRender(async()=>{renders++;});
  return {app,records,saved,nodes,location,get renders(){return renders;},get pendingVideo(){return pendingVideo;},setGet(fn){getHook=fn;},dispatch(type,event){for(const fn of docListeners.get(type)||[])fn(event);},hashchange(){for(const fn of winListeners.get('hashchange')||[])fn();},click(action){let prevented=false;const el={dataset:{action,id:'p1'}};const event={target:{closest:s=>s==='[data-action]'?el:null},preventDefault(){prevented=true;}};for(const fn of docListeners.get('click')||[])fn(event);return prevented;}};
}

test('validated backup IDs and field types remain inert in playlist HTML',()=>{
  const h=harness(),p=fixture();const payload='"><img src=x onerror="globalThis.auditMarker=1">';
  p.playlist[0].id=payload;const imported=domain.readBackup(JSON.stringify(domain.projectBackup(p)));
  assert.equal(domain.validateProject(imported).filter(i=>i.severity==='error').length,0);
  h.app.state.project=imported;h.app.state.route='playlist';
  const html=h.app.playlistView();assert.equal(html.includes('<img'),false);assert.match(html,/name="in-&quot;&gt;&lt;img/);
  assert.equal(h.app.field('Label','Name','Value',payload).includes('<img'),false);
});

test('valid imported precision remains editable without forced rounding',()=>{
  const h=harness(),p=fixture();h.app.state.project=p;h.app.state.route='playlist';
  for(const html of [h.app.playForm(p.plays[0]),h.app.playlistView()]){
    const inputs=[...html.matchAll(/<input\b[^>]*type="number"[^>]*>/g)].map(m=>m[0]);
    assert.ok(inputs.length>0);for(const input of inputs)assert.match(input,/step="any"/);
  }
  assert.match(h.app.playForm(p.plays[0]),/value="0.425"/);
});

test('dirty form action guards retain edits without saving or rendering',async()=>{
  for(const action of ['reports','add-play','add-all','clip-id','project-info','new','import-backup','attach-video','import-data']){
    const h=harness();h.app.state.project=fixture();h.app.state.dirty=true;
    assert.equal(h.click(action),true);await flush();assert.equal(h.app.state.dirty,true,action);assert.equal(h.saved.length,0,action);assert.equal(h.renders,0,action);assert.equal(h.location.hash,'#/overview',action);
  }
});

test('browser route changes are rolled back while dirty or a mutation is pending',()=>{
  for(const flag of ['dirty','busy','recording']){const h=harness();h.app.state[flag]=true;h.location.hash='#/reports/some-project';h.hashchange();assert.equal(h.location.hash,'#/overview');assert.equal(h.app.state[flag],true);assert.equal(h.renders,0);}
});

test('anchor and project picker cannot navigate during a pending mutation',async()=>{
  const h=harness();h.app.state.project=fixture();h.app.state.busy=true;let prevented=false;
  h.dispatch('click',{target:{closest:s=>s==='a[href^="#/"]'?{dataset:{}}:null},preventDefault(){prevented=true;}});assert.equal(prevented,true);
  h.setGet(()=>{throw new Error('picker must not fetch while busy');});
  h.dispatch('change',{target:{id:'active-project',value:'other'}});await flush();assert.equal(h.renders,0);
});

test('latest hash navigation wins when storage responses arrive out of order',async()=>{
  const h=harness(),a=fixture('A'),b=fixture('B'),da=defer(),db=defer();h.setGet(id=>id===a.id?da.promise:db.promise);
  h.location.hash='#/review/'+a.id;const first=h.app.navigate();h.location.hash='#/review/'+b.id;const second=h.app.navigate();db.resolve(b);await second;da.resolve(a);await first;
  assert.equal(h.app.state.project.id,b.id);assert.equal(h.renders,1);
});

test('video attachment keeps the target chosen before metadata resolves',async()=>{
  const h=harness(),a=fixture('A'),b=fixture('B');h.app.state.project=a;
  const file=new Blob(['metadata decoded by browser integration tests'],{type:'video/mp4'});Object.defineProperty(file,'name',{value:'A.mp4'});
  const attaching=h.app.attachVideo(file);h.app.state.project=b;h.pendingVideo.onloadedmetadata();await attaching;
  assert.equal(h.saved.length,1);assert.equal(h.saved[0].id,a.id);assert.equal(h.saved[0].video.name,'A.mp4');
});

test('stale project picker response cannot replace a newer active project',async()=>{
  const h=harness(),a=fixture('A'),b=fixture('B'),late=defer();h.app.state.project=a;h.setGet(id=>id===a.id?late.promise:structuredClone(b));
  h.dispatch('change',{target:{id:'active-project',value:a.id}});
  h.location.hash='#/review/'+b.id;await h.app.navigate();h.app.state.dirty=true;
  late.resolve(a);await flush();assert.equal(h.app.state.project.id,b.id);assert.equal(h.app.state.dirty,true);
});

test('detached video callbacks cannot touch a replacement page',async()=>{
  const h=harness(),p=fixture();p.video={id:'demo',name:'demo.mp4',size:0,duration:15,width:1280,height:720,sha256:'',url:'media/demo.mp4'};h.app.state.project=p;
  const callbacks=new Map(),video={isConnected:true,dataset:{},duration:15,currentTime:0,addEventListener(type,fn){callbacks.set(type,fn);},pause(){}};
  h.nodes.set('#review-video',video);await h.app.bindVideo();video.isConnected=false;h.nodes.delete('#review-video');
  for(const type of ['loadedmetadata','timeupdate','error'])assert.doesNotThrow(()=>callbacks.get(type)?.());
});


test('missing project routes release navigation and editor locks for recovery',async()=>{
  const h=harness();h.location.hash='#/review/missing';h.setGet(async()=>null);await h.app.navigate();
  assert.equal(h.app.state.navigating,false);assert.equal(h.nodes.get('#main').inert,false);
  assert.match(h.nodes.get('#main').innerHTML,/项目不存在/);
});

test('newly rendered forms retain the pending mutation lock',async()=>{
  const h=harness();h.app.state.project=fixture();h.app.state.route='review';
  const main=h.nodes.get('#main');let html='';
  Object.defineProperty(main,'innerHTML',{get(){return html;},set(value){html=value;if(value.includes('id="play-form"'))h.nodes.set('#play-form',{inert:false});}});
  h.app.setBusy(true);await h.app.render();
  assert.equal(h.app.state.busy,true);assert.equal(h.nodes.get('#play-form').inert,true);
  h.app.setBusy(false);assert.equal(h.nodes.get('#play-form').inert,false);
});


test('raw evidence values, metric names and source records stay inert in rendered HTML',()=>{
  const h=harness(),p=fixture(),payload='<img src=x onerror=alert(1)>';
  p.plays[0].sourceEvidence={record:{metrics:{[payload]:payload},notes:payload,tracks:[],annotations:[]},metricSemantics:{gravity:payload}};
  const html=h.app.sourceEvidenceHTML(p.plays[0]);assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert(html.includes('原始回合证据'));assert(html.includes('不参与 Studio 统计'));
});


test('player filtering separates identical names from different teams',()=>{
 const h=harness(),p=fixture();p.plays=[{...p.plays[0],shooter:'Alex',team:'A'},{...p.plays[0],id:'p2',shooter:'Alex',team:'B'}];h.app.state.project=p;
 const html=h.app.filtersHTML(p);assert(html.includes('Alex · A'));assert(html.includes('Alex · B'));
 h.app.state.filter.player=domain.playerKey(p.plays[1]);assert.deepEqual(h.app.filteredPlays(p).map(p=>p.id),['p2']);
});
