import assert from 'node:assert/strict';
import {dataReadiness} from '../broadcast/data_readiness.mjs';

// The current real-game project has 22 roster rows, 25 sourced PBP rows, and no depth-metric bundle.
const real={context:{gameId:'0022400460',roster:Array(22).fill({}),playByPlay:{source:{gameId:'0022400460'},entries:Array(25).fill({})}},metrics:null};
const current=dataReadiness(real);
assert.equal(current.rosterCount,22);
assert.equal(current.pbpCount,25);
assert.ok(current.categories.every(row=>row.status==='missing' && row.mappedCount===0),'real footage has no imported depth metrics');

const definitions={
  xfg:{role:'difficulty',semantics:'official_xfg',granularity:'shot'},
  makeProbability:{role:'difficulty',semantics:'shot_make_probability',granularity:'shot'},
  on:{role:'gravity',ballState:'on-ball',granularity:'event'},
  off:{role:'gravity',ballState:'off-ball',granularity:'event'},
  lvg:{role:'leverage',semantics:'provider_lvg_score',granularity:'event'},
  oldOpportunity:{role:'leverage',semantics:'possession_win_probability_opportunity',granularity:'event'},
  context:{role:'gravity',ballState:'on-ball',granularity:'season'},
  combined:{role:'gravity',ballState:'combined',granularity:'event'},
};
const event=(id,metricId,granularity='event')=>({id,metricId,value:1,scope:{granularity,playId:'play-1'},time:{availableAt:2}});
const fixture={context:{gameId:'game-1',roster:[{id:'p-1'}],playByPlay:{source:{gameId:'game-1'},entries:[{id:'pbp-1'}]}},
  metrics:{dictionary:{provenance:{kind:'synthetic',source:'fixture'},metrics:definitions},plays:[{id:'play-1',gameId:'game-1'}],
    records:[event('x-1','xfg','shot'),event('make-1','makeProbability','shot'),event('on-1','on'),event('off-1','off'),{...event('lv-1','lvg'),value:-1.4},event('old-1','oldOpportunity'),event('season-1','context','season'),event('combined-1','combined')]},
  observations:[{id:'obs-1',review:{status:'accepted'}}],bindings:[]};
assert.ok(dataReadiness(fixture).categories.every(row=>row.status==='test'),'fixture must never be presented as official');
fixture.metrics.dictionary.provenance={kind:'provider',source:'Source-requiring-verification'};
const pending=dataReadiness(fixture);
assert.ok(pending.categories.every(row=>row.status==='pending' && row.mappedCount===0),'imported events remain unbound');
assert.equal(pending.categories.find(row=>row.id==='xfg').importedCount,2,'declared shot make probability counts as xFG');
assert.equal(pending.categories.find(row=>row.id==='lvg').importedCount,1,'negative provider LVG is eligible; old opportunity probability is not LVG');
assert.equal(pending.categories.find(row=>row.id==='gravity-on').importedCount,1,'season and combined gravity cannot become on-ball events');
fixture.bindings=[{id:'bind-1',status:'confirmed',gameId:'game-1',observationId:'obs-1',metricRecordIds:['x-1','on-1']}];
const mapped=dataReadiness(fixture);
assert.equal(mapped.categories.find(row=>row.id==='xfg').status,'mapped');
assert.equal(mapped.categories.find(row=>row.id==='gravity-on').mappedCount,1);
assert.equal(mapped.categories.find(row=>row.id==='gravity-off').status,'pending');
fixture.bindings[0].gameId='another-game';
assert.equal(dataReadiness(fixture).categories.find(row=>row.id==='xfg').mappedCount,0,'other-game binding cannot count');
fixture.context.playByPlay.source.gameId='another-game';
assert.equal(dataReadiness(fixture).pbpCount,0,'other-game PBP cannot count');
console.log('data readiness counts and provenance gates passed');
