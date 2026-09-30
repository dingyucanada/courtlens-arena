import test from 'node:test';
import assert from 'node:assert/strict';
import {renderProductionDesk,renderClockTool} from '../broadcast/production_ui.mjs';

test('source evidence escapes untrusted descriptions and retains actionable window controls',()=>{
  const html=renderProductionDesk({selected:{id:'o1',description:'<img onerror="evil">',type:'shot',start:1,end:2,frameIds:['f1'],review:{status:'unreviewed'}},frames:[{id:'f1',url:'/private/frame',actualTime:1.5}],loop:{id:'o1'}});
  assert.ok(html.includes('&lt;img onerror='));assert.ok(!html.includes('<img onerror='));
  assert.ok(html.includes('data-action="loop-observation"'));assert.ok(html.includes('停止循环'));
  assert.ok(html.includes('尚未确认姓名'));assert.ok(html.includes('/private/frame'));
});
test('unknown cloud gates remain unknown, separate from successful local checks',()=>{
  const html=renderProductionDesk({tab:'delivery',report:{checks:[{id:'video',label:'视频',status:'pass',detail:'可解码'},{id:'cloudfront',label:'CloudFront',status:'unknown',detail:'等待比赛账号'}]}});
  assert.ok(html.includes('delivery-check unknown'));assert.ok(html.includes('未验证'));
  assert.ok(html.includes('download-preflight'));assert.ok(!html.includes('100%'));
});
test('clock tool disabled until two saved real frames exist and never fabricates a time',()=>{
  assert.ok(renderClockTool([]).includes('disabled'));
  const html=renderClockTool([{id:'f1',actualTime:1},{id:'f2',actualTime:3}],{mapping:{videoTime:2},uncertaintySeconds:1});
  assert.ok(html.includes('clock-preview'));assert.ok(html.includes('源片 2.00s'));assert.ok(html.includes('±1.00'));
});
test('voice budget distinguishes heuristic from actual measured report and explains timing cap',()=>{
  const report={rehearsal:{beats:[{beatId:'b1',cue:{sourceStart:2,sourceEnd:5,availableSeconds:2.92},text:'传球',estimate:{durationSeconds:1.1,fitsAtMaxTempo:true},measuredAudio:null}],issues:[]}};
  const html=renderProductionDesk({tab:'voice',report});assert.ok(html.includes('文字估时'));assert.ok(html.includes('1.15'));assert.ok(!html.includes('音频实测'));
});
