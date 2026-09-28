import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {analyzePossession,rankPossessions} from '../pro/analytics.mjs';

// Run the entire production lab function; only its unrelated visual panels are stubbed.
const source=readFileSync(new URL('../pro/app.mjs',import.meta.url),'utf8');
const start=source.indexOf('function lab(){'),end=source.indexOf('function director()',start);
assert.ok(start>=0&&end>start);
const metric=(value,semantics,extra={})=>({value,semantics,availableAt:5,
  provenance:{kind:'measured',source:'test fixture, no NBA claim'},...extra});
const play=(id,value,extra={})=>({id,title:id,start:0,end:10,shotTime:5,resultTime:6,
  team:'HOU',player:'H3',outcome:'unknown',tracks:[],tracking:{},metrics:{
    difficulty:metric(.42,'shot_make_probability',{unit:'probability'}),
    gravity:metric(value,'supplied_metric',{unit:'source-gravity',range:[0,100],higherIs:'more',definition:'Per-possession provider model v1',...extra}),
    leverage:metric(.7,'possession_win_probability_opportunity',{unit:'probability'}),
  }});

function labHTML(one,two,{compareId=two.id}={}){
  const state={project:{plays:[one,two]},analyses:{[one.id]:analyzePossession(one),[two.id]:analyzePossession(two)},compareId,time:0};
  const context=vm.createContext({state,play:()=>one,currentAnalysis:()=>state.analyses[one.id],
    rankPossessions,intro:()=>'',sources:()=>'',stage:()=>'',icon:()=>'',h:String,
    format:(value,digits)=>Number.isFinite(value)?value.toFixed(digits):'—',
    distanceChart:()=>'',opportunityWindows:()=>'',sourceBadge:()=>''});
  vm.runInContext(source.slice(start,end),context);
  return context.lab();
}
function rowValues(html,label){
  const row=html.match(new RegExp(`<tr><td>${label}</td><td class="num">([^<]*)</td><td class="num">([^<]*)</td></tr>`));
  assert.ok(row,'The actual lab comparison table must contain its metric row.');
  return row.slice(1);
}
const gravityValues=html=>rowValues(html,'球员引力');

test('lab blocks same-unit Gravity readings with different definitions as ranking already does',()=>{
  const one=play('p01',12),two=play('p02',84,{definition:'Season cumulative provider model v1'});
  assert.ok(rankPossessions([one,two])[0].rank.incompatibleFields.includes('gravity'));
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('lab blocks different Gravity scales even when labels and units match',()=>{
  const one=play('p01',12),two=play('p02',84,{range:[0,200]});
  assert.ok(rankPossessions([one,two])[0].rank.incompatibleFields.includes('gravity'));
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('lab blocks differing source definitions even when no ranking scale was supplied',()=>{
  const one=play('p01',12,{range:undefined}),two=play('p02',84,{range:undefined,definition:'Season cumulative provider model v1'});
  assert.equal(analyzePossession(one).metrics.gravity.signature,null);
  assert.equal(analyzePossession(two).metrics.gravity.signature,null);
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('lab retains direct readings when Gravity definition, scale, unit and source class agree',()=>{
  const one=play('p01',12),two=play('p02',84);
  assert.ok(!rankPossessions([one,two])[0].rank.incompatibleFields.includes('gravity'));
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','84.000']);
});

test('lab obeys the kernel boundary between schematic and measured Gravity records',()=>{
  const one=play('p01',12),two=play('p02',84,{provenance:{kind:'synthetic',source:'synthetic fixture'}});
  assert.ok(rankPossessions([one,two])[0].rank.incompatibleFields.includes('gravity'));
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('lab cannot advertise a comparison when the current source reading is missing',()=>{
  const one=play('p01',null),two=play('p02',84);
  assert.deepEqual(gravityValues(labHTML(one,two)),['未提供','不可直接比较']);
});

test('stale selection of the current play resolves another play before pair compatibility analysis',()=>{
  const one=play('p01',12),two=play('p02',84);
  const html=labHTML(one,two,{compareId:one.id});
  assert.match(html,/<th>p01<\/th><th>p02<\/th>/);
  assert.deepEqual(gravityValues(html),['12.000','84.000']);
});

test('lab blocks measured and synthetic raw readings even without ranking signatures',()=>{
  const one=play('p01',12,{range:undefined,higherIs:undefined});
  const two=play('p02',84,{range:undefined,higherIs:undefined,provenance:{kind:'synthetic',source:'synthetic fixture'}});
  assert.equal(analyzePossession(one).metrics.gravity.signature,null);
  assert.equal(analyzePossession(two).metrics.gravity.signature,null);
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('lab blocks different declared ranges when raw readings cannot be ranked',()=>{
  const one=play('p01',12,{higherIs:undefined});
  const two=play('p02',84,{range:[0,200],higherIs:undefined});
  assert.equal(analyzePossession(one).metrics.gravity.signature,null);
  assert.equal(analyzePossession(two).metrics.gravity.signature,null);
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('lab blocks a declared scale compared with an unspecified scale',()=>{
  const one=play('p01',12,{higherIs:undefined});
  const two=play('p02',84,{range:undefined,higherIs:undefined});
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('lab retains same-basis raw readings without implying a ranking score',()=>{
  const one=play('p01',12,{range:undefined,higherIs:undefined});
  const two=play('p02',84,{range:undefined,higherIs:undefined});
  assert.equal(analyzePossession(one).metrics.gravity.normalized,null);
  assert.equal(analyzePossession(two).metrics.gravity.normalized,null);
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','84.000']);
});

test('lab preserves unknown Gravity reading but refuses unknown semantics comparison',()=>{
  const one=play('p01',12),two=play('p02',84);
  one.metrics.gravity={value:12,semantics:'unknown',availableAt:4};
  two.metrics.gravity={value:84,semantics:'unknown',availableAt:4};
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('metadata cannot make an unknown Gravity semantic professionally comparable',()=>{
  const one=play('p01',12,{semantics:'unknown'}),two=play('p02',84,{semantics:'unknown'});
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('Gravity missing an explicit definition is neither ranked nor compared',()=>{
  const one=play('p01',12,{definition:undefined}),two=play('p02',84,{definition:undefined});
  assert.equal(analyzePossession(one).metrics.gravity.signature,null);
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('Gravity missing an explicit unit is neither ranked nor compared',()=>{
  const one=play('p01',12,{unit:undefined}),two=play('p02',84,{unit:undefined});
  assert.equal(analyzePossession(one).metrics.gravity.signature,null);
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('whitespace-only Gravity definition is unknown for comparison',()=>{
  const one=play('p01',12,{definition:'  '}),two=play('p02',84,{definition:'  '});
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('unknown Difficulty semantics cannot be compared through matching metadata',()=>{
  const one=play('p01',12),two=play('p02',84);
  for(const p of [one,two])p.metrics.difficulty=metric(.42,'unknown',{unit:'probability',definition:'Undefined provider field'});
  assert.deepEqual(rowValues(labHTML(one,two),'difficulty（来源指标）'),['0.420','不可直接比较']);
});

test('unknown Leverage semantics cannot be compared through matching metadata',()=>{
  const one=play('p01',12),two=play('p02',84);
  for(const p of [one,two])p.metrics.leverage=metric(.7,'unknown',{unit:'probability',definition:'Undefined provider field'});
  assert.deepEqual(rowValues(labHTML(one,two),'Leverage（来源指标）'),['0.700','不可直接比较']);
});

test('blank Gravity unit cannot be used as an explicit comparison basis',()=>{
  const one=play('p01',12,{unit:'  '}),two=play('p02',84,{unit:'  '});
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('opposite declared Gravity directions cannot be compared as one basis',()=>{
  const one=play('p01',12),two=play('p02',84,{higherIs:'less'});
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});

test('a declared Gravity direction compared with missing direction is unknown even without signatures',()=>{
  const one=play('p01',12,{range:undefined,higherIs:'less'}),two=play('p02',84,{range:undefined,higherIs:undefined});
  assert.equal(analyzePossession(one).metrics.gravity.signature,null);
  assert.equal(analyzePossession(two).metrics.gravity.signature,null);
  assert.deepEqual(gravityValues(labHTML(one,two)),['12.000','不可直接比较']);
});
