import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createProject,demoProject,validateProject,parseImport,summarize,toCSV,projectBackup,readBackup,id,MAX_IMPORT_BYTES} from './domain.mjs';
const raw = (changes = {}) => ({id:'p1',start:0,end:12,shotTime:9,resultTime:10,shooter:'A',team:'HOME',points:3,made:true,tag:'PnR',notes:'',xfg:.4,x:null,y:null,source:'manual review',...changes});
const play = (changes = {}) => ({...raw(changes),reviewed:false});
const parse = (rows,options = {}) => parseImport(JSON.stringify(rows),{format:'json',...options});
const project = () => ({...createProject({name:'Test',source:'manual footage'}),video:{id:'video1',name:'game.mp4',size:10,duration:60,width:1280,height:720,sha256:''},plays:[play()]});
const errors = value => validateProject(value).filter(item => item.severity === 'error');

test('new projects have independent IDs, revision zero and draft state',()=>{
  const p=createProject({name:'Game',scenario:'editor'}), q=createProject({name:'Game'});
  assert.equal(p.revision,0); assert.equal(p.status,'draft'); assert.notEqual(p.id,q.id); assert.deepEqual(errors(p),[]); assert.notEqual(id(),id());
});
test('create rejects invalid scenario and non-text fields',()=>{
  assert.throws(()=>createProject({name:'X',scenario:'cloud'}),/Scenario/); assert.throws(()=>createProject({name:{}}),/text/);
});
test('canonical JSON preserves explicit zero xFG and unknown outcome, never trusts review flag',()=>{
  const result=parse([raw({made:null,xfg:0,reviewed:true})]);
  assert.equal(result.plays[0].made,null); assert.equal(result.plays[0].xfg,0); assert.equal(result.plays[0].reviewed,false); assert(result.issues.some(i=>i.code==='UNKNOWN_RESULT'));
});
test('JSON wrapped plays and snake time aliases work',()=>{
  const row=raw();delete row.shotTime;delete row.resultTime;row.shot_time=8;row.result_time=11;
  const p=parse({plays:[row]}).plays[0];assert.equal(p.shotTime,8);assert.equal(p.resultTime,11);
});
test('missing times safely delay labels until play end and emit a warning',()=>{
  const row=raw();delete row.shotTime;delete row.resultTime;
  const result=parse([row]);assert.equal(result.plays[0].shotTime,12);assert.equal(result.plays[0].resultTime,12);assert(result.issues.some(i=>i.code==='ASSUMED_TIMING'));
});
test('CSV supports BOM, CRLF, escaped quotes, embedded lines and comma text',()=>{
  const text='\uFEFFid,start,end,shot_time,result_time,shooter,points,made,notes\r\np1,0,12,9,10,"A, B",3,false,"line 1\r\n""quoted"""\r\n';
  const p=parseImport(text,{format:'csv',source:'supplied file'}).plays[0];
  assert.equal(p.shooter,'A, B');assert.equal(p.notes,'line 1\r\n"quoted"');assert.equal(p.source,'supplied file');assert.equal(p.made,false);assert.equal(p.xfg,null);
});
test('CSV rejects malformed quotes, row widths and duplicate aliased headers',()=>{
  for (const csv of ['start,end,points\n0,2,"3','start,end,points\n0,2','start,end,points\n0,2,3,extra','start,end,points,shotTime,shot_time\n0,2,3,1,1','start,end,points\n0,2,"3"x']) assert.throws(()=>parseImport(csv,{format:'csv'}));
});
test('CSV rejects dangerous headers and ignores benign inherited-looking names safely',()=>{
  assert.throws(()=>parseImport('start,end,points,__proto__\n0,2,3,x',{format:'csv'}),/unsafe/);
  const r=parseImport('start,end,points,toString\n0,2,3,x',{format:'csv'});assert(r.issues.some(i=>i.code==='IGNORED_COLUMNS'));assert.equal(r.plays.length,1);
});
test('imports enforce max byte length, nonempty content, supported format and count',()=>{
  assert.throws(()=>parseImport(' '.repeat(MAX_IMPORT_BYTES+1)),/8 MiB/); assert.throws(()=>parseImport(''),/empty/);
  assert.throws(()=>parseImport('[]',{format:'xml'}),/format/);assert.throws(()=>parse([]),/1–2000/);assert.throws(()=>parse(Array.from({length:2001},(_,i)=>raw({id:`p${i}`}))),/2000/);
});
test('missing and nonnumeric shot values cannot silently become zero',()=>{
  for (const changes of [{start:null},{start:''},{start:false},{start:'0x12'},{start:'1,000'},{end:'Infinity'},{points:null},{points:0},{points:1},{points:2.5}]) assert.throws(()=>parse([raw(changes)]));
});
test('time order, negative times and duration bounds are enforced',()=>{
  for (const changes of [{start:-1},{end:0},{shotTime:13},{resultTime:8},{resultTime:13}]) assert.throws(()=>parse([raw(changes)]));
  assert.throws(()=>parse([raw()],{duration:11}),/duration/);assert.throws(()=>parse([raw()],{duration:0}),/duration/);
});
test('duplicate play IDs and non-object rows are rejected atomically',()=>{
  assert.throws(()=>parse([raw(),raw()]),/duplicate/);assert.throws(()=>parse([raw(),null]),/Row 2/);assert.throws(()=>parse([raw(),5]),/Row 2/);
});
test('unknown results remain null, common explicit result tokens are normalized',()=>{
  for (const value of [null,'','unknown','pending','null']) assert.equal(parse([raw({made:value})]).plays[0].made,null);
  for (const value of [true,'made','true','yes',1]) assert.equal(parse([raw({made:value})]).plays[0].made,true);
  for (const value of [false,'missed','false','no',0]) assert.equal(parse([raw({made:value})]).plays[0].made,false);
  assert.throws(()=>parse([raw({made:'probably'})]),/made\/result/);
});
test('conflicting time aliases and result representations are rejected',()=>{
  assert.throws(()=>parse([raw({shot_time:7})]),/Conflicting/);assert.throws(()=>parse([raw({result_time:12})]),/Conflicting/);assert.throws(()=>parse([raw({result:'missed'})]),/Conflicting/);
});
test('xFG and coordinates enforce their probability and normalized semantics',()=>{
  for (const changes of [{xfg:38},{xfg:-.1},{x:0.2,y:null},{x:null,y:.2},{x:2,y:.2}]) assert.throws(()=>parse([raw(changes)]));
  const p=parse([raw({x:0,y:1,xfg:1})]).plays[0];assert.equal(p.x,0);assert.equal(p.y,1);
});
test('existing dataset conversion preserves sources, actual shot points and no tracking-derived shot map',()=>{
  const dataset={provenance:{source:'manual dataset'},metric_semantics:{xfg_pct:'shot_make_probability'},possessions:[{id:'p',start:0,end:12,shot_time:9,result_time:10,shooter:'A',offense:'X',result:'missed',points:3,title:'Pick',metrics:{xfg_pct:.2},source_refs:['frame:10'],notes:['one','two'],tracks:[{x:.2,y:.3}]}]};
  const p=parse(dataset).plays[0];assert.equal(p.made,false);assert.equal(p.points,3);assert.equal(p.xfg,.2);assert.equal(p.source,'manual dataset · frame:10');assert.equal(p.team,'X');assert.equal(p.notes,'one\ntwo');assert.equal(p.x,null);
  dataset.metric_semantics.xfg_pct='percentage_0_100';assert.throws(()=>parse(dataset),/semantics/);
});
test('stats use only known outcomes as attempts and only known xFG as expected points',()=>{
  const s=summarize([play({made:true,points:3,xfg:.5}),play({id:'p2',made:false,points:2,xfg:null}),play({id:'p3',made:null,points:3,xfg:.2})]);
  assert.deepEqual([s.total,s.attempts,s.made,s.points,s.fgPct,s.efgPct,s.xfgCount],[3,2,1,3,.5,.75,2]);assert(Math.abs(s.expectedPoints-2.1)<1e-9);assert.equal(s.players[0].attempts,2);
});
test('all unknown outcomes and absent xFG produce null percentages and expectations',()=>{
  const s=summarize([play({made:null,xfg:null})]);assert.equal(s.fgPct,null);assert.equal(s.efgPct,null);assert.equal(s.expectedPoints,null);assert.equal(s.players[0].fgPct,null);
  assert.equal(summarize([]).fgPct,null);
});
test('zero xFG is real coverage; prototype-like player and tag names aggregate safely',()=>{
  const s=summarize([play({shooter:'__proto__',tag:'constructor',xfg:0}),play({id:'p2',shooter:'__proto__',tag:'constructor',made:null,xfg:null})]);
  assert.equal(s.expectedPoints,0);assert.equal(s.xfgCount,1);assert.equal(s.players.length,1);assert.equal(s.tags[0].count,2);
});
test('CSV protects formula payloads and preserves quotes and newlines',()=>{
  const csv=toCSV([play({shooter:' =SUM(1,2)',team:'@cmd',notes:'\tformula\n"detail"',tag:'-2+3',source:'+payload'})]);
  assert(csv.includes('"\' =SUM(1,2)"'));assert(csv.includes('"\'@cmd"'));assert(csv.includes('"\'-2+3"'));assert(csv.includes('"\'+payload"'));assert(csv.includes('"\'\tformula\n""detail"""'));
});
test('CSV roundtrip retains non-formula data and null statistics',()=>{
  const original=play({made:null,xfg:null,x:0,y:1,notes:'a,"b"\nc'});const restored=parseImport(toCSV([original]),{format:'csv'}).plays[0];
  for(const key of ['id','start','end','made','xfg','x','y','notes','source'])assert.equal(restored[key],original[key]);
});
test('approval requires video, source, nonempty plays and all play reviews',()=>{
  const p=project();p.status='approved';assert(errors(p).some(i=>i.code==='REVIEW_REQUIRED'));
  p.plays[0].reviewed=true;assert.deepEqual(errors(p),[]);
  p.video.needsReattach=true;assert(errors(p).some(i=>i.code==='VIDEO_REATTACH_REQUIRED'));
  p.video=null;p.source='';p.plays=[];const codes=errors(p).map(i=>i.code);for(const code of ['VIDEO_REQUIRED','SOURCE_REQUIRED','PLAYS_REQUIRED'])assert(codes.includes(code));
});
test('validation catches structure, nonfinite data, unsafe media URLs and playlist bounds',()=>{
  const p=project();p.video.url='https://example.test/video';p.playlist=[{id:'c',playId:'missing',in:0,out:2,title:'bad'}];const codes=errors(p).map(i=>i.code);assert(codes.includes('VIDEO_URL'));assert(codes.includes('CLIP_PLAY'));
  p.video.url='media/demo.mp4';p.playlist=[{id:'c',playId:'p1',in:1,out:13,title:'bad'}];assert(errors(p).some(i=>i.code==='CLIP_BOUNDS'));
  p.plays[0].xfg=NaN;assert(errors(p).some(i=>i.code==='UNSAFE_DATA'));
});
test('validation rejects polluted prototypes and accessors without running them',()=>{
  let called=false;const p=project();Object.defineProperty(p,'name',{get(){called=true;return 'bad';},enumerable:true});assert(errors(p).length);assert.equal(called,false);
  assert(errors(Object.assign(Object.create({evil:true}),project())).length);
  const cycle=project();cycle.activity.push(cycle);assert(errors(cycle).length);
});
test('validation rejects sparse arrays that JSON serialization would silently alter',()=>{
  const p=project();p.plays=new Array(2);assert(errors(p).some(i=>i.code==='UNSAFE_DATA'));
  p.plays=[];p.plays.extra='hidden';assert(errors(p).some(i=>i.code==='UNSAFE_DATA'));
});
test('JSON imports reject prototype keys at any depth without prototype pollution',()=>{
  for(const key of ['__proto__','constructor','prototype'])assert.throws(()=>parseImport(`{"plays":[],"nested":{"${key}":{"polluted":true}}}`),/unsafe/);
  assert.equal({}.polluted,undefined);
});
test('portable backup excludes runtime fields and cannot imply attached local video',()=>{
  const p=project();p.plays[0].reviewed=true;p.status='approved';p.runtime={secret:'omit'};
  const b=projectBackup(p);assert.equal(b.kind,'courtlens-project');assert.equal(b.project.status,'draft');assert.equal(b.project.video.needsReattach,true);assert.equal(b.project.runtime,undefined);assert.equal(p.status,'approved');
});
test('backup import creates fresh identities and resets attestation while preserving edits and clips',()=>{
  const p=project();p.playlist=[{id:'c',playId:'p1',in:1,out:11,title:'Chosen'}];p.plays[0].reviewed=true;
  const restored=readBackup(JSON.stringify(projectBackup(p)));assert.notEqual(restored.id,p.id);assert.notEqual(restored.video.id,p.video.id);assert.equal(restored.revision,0);assert.equal(restored.status,'draft');assert.equal(restored.plays[0].reviewed,false);assert.equal(restored.video.needsReattach,true);assert.deepEqual(restored.playlist,p.playlist);assert.equal(restored.plays[0].source,p.plays[0].source);
});
test('backup rejects malformed kind, schema, plays, playlists and forged media URL',()=>{
  const b=projectBackup(project());
  for(const mutate of [b=>b.kind='other',b=>b.schemaVersion=2,b=>b.project.revision=-1,b=>b.project.plays[0].made='maybe',b=>b.project.playlist=[{id:'c',playId:'p1',in:0,out:100,title:'Bad'}],b=>b.project.video.url='javascript:alert(1)']){const c=structuredClone(b);mutate(c);assert.throws(()=>readBackup(JSON.stringify(c)));}
});
test('actual bundled demo converts with honest synthetic provenance and safe portable URL',async()=>{
  const dataset=JSON.parse(await readFile(new URL('../data/demo.json',import.meta.url),'utf8'));const p=demoProject(dataset);
  assert.equal(p.plays.length,3);assert.equal(p.video.url,'media/demo.mp4');assert.match(p.source,/合成/);assert(p.plays.every(p=>p.reviewed===false&&p.x===null));assert.deepEqual(errors(p),[]);
  const restored=readBackup(JSON.stringify(projectBackup(p)));assert.equal(restored.video.url,'media/demo.mp4');assert.equal(restored.video.needsReattach,undefined);
});

test('advanced source records and metric semantics survive import and backup without silently entering statistics',async()=>{
  const dataset=JSON.parse(await readFile(new URL('../data/demo.json',import.meta.url),'utf8'));
  const imported=parse(dataset);assert(imported.issues.some(i=>i.code==='EVIDENCE_ARCHIVED'));
  assert.deepEqual(imported.plays[0].sourceEvidence.record,dataset.possessions[0]);
  assert.deepEqual(imported.plays[0].sourceEvidence.metricSemantics,dataset.metric_semantics);
  const p=demoProject(dataset);p.plays[0].notes='New review';
  const restored=readBackup(JSON.stringify(projectBackup(p)));
  assert.deepEqual(restored.plays[0].sourceEvidence.record,dataset.possessions[0]);
  assert.equal(restored.plays[0].notes,'New review');
  assert.equal(summarize(restored.plays).gravity,undefined);
  assert.equal(restored.plays[0].x,null);
});

test('canonical JSON reports unknown fields and rejects malformed source evidence',()=>{
  const r=parse([raw({mysteryMetric:42})]);assert(r.issues.some(i=>i.code==='IGNORED_FIELDS'));
  assert.throws(()=>parse([raw({sourceEvidence:{record:[],metricSemantics:{}}})]),/sourceEvidence/);
  const evidence={record:{metrics:{gravity:1.8},notes:'<img src=x onerror=alert(1)>'},metricSemantics:{gravity:'source-defined'}};
  assert.deepEqual(parse([raw({sourceEvidence:evidence})]).plays[0].sourceEvidence,evidence);
});

test('large valid project backups can exceed the smaller single-import limit',()=>{
  const p=project();p.plays[0].sourceEvidence={record:{chunks:Array(90).fill('x'.repeat(100000))},metricSemantics:{}};
  const text=JSON.stringify(projectBackup(p));assert(text.length>MAX_IMPORT_BYTES);
  assert.equal(readBackup(text).plays[0].sourceEvidence.record.chunks.length,90);
  p.plays[0].sourceEvidence.record.chunks=Array(340).fill('x'.repeat(100000));
  assert(errors(p).some(i=>i.code==='PROJECT_SIZE'));assert.throws(()=>projectBackup(p),/32 MiB/);
});

test('repeated metric semantics are budgeted before source evidence expands',()=>{
  const dataset={metric_semantics:{description:'x'.repeat(350000)},possessions:Array.from({length:100},(_,i)=>({...raw(),id:`p${i}`}))};
  assert(JSON.stringify(dataset).length<MAX_IMPORT_BYTES);
  assert.throws(()=>parse(dataset),/16 MiB import budget/);
});

test('backup envelope does not reject valid project evidence at the nesting limit',()=>{
  const p=project();let nested={value:'leaf'};for(let i=0;i<35;i++)nested={child:nested};
  p.plays[0].sourceEvidence={record:{nested},metricSemantics:{}};
  assert.deepEqual(errors(p),[]);
  const restored=readBackup(JSON.stringify(projectBackup(p)));
  assert.deepEqual(restored.plays[0].sourceEvidence,p.plays[0].sourceEvidence);
});


test('same-name players on different teams retain separate shooting totals',()=>{
 const stats=summarize([play({shooter:'Alex',team:'A',made:true,points:3}),play({id:'p2',shooter:'Alex',team:'B',made:false,points:2})]);
 assert.equal(stats.players.length,2);assert.equal(stats.players.find(p=>p.team==='A').points,3);assert.equal(stats.players.find(p=>p.team==='B').fgPct,0);assert.equal(stats.points,3);
});
