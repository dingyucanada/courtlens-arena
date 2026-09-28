import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../pro/app.mjs',import.meta.url),'utf8');
const begin=source.indexOf('function opportunityWindows('),end=source.indexOf('function lab()',begin);
assert.ok(begin>=0&&end>begin);
const context=vm.createContext({h:String,format:(n,d)=>n.toFixed(d)});
vm.runInContext(source.slice(begin,end),context);
const analysis={temporal:{opportunityWindows:[{playerId:'H1',start:2,end:5,duration:3,minDistanceFt:6,thresholdFt:6}]}};
for(const shotTime of [null,undefined,NaN]){
  test(`sampled-space chart has no invented shot marker for ${String(shotTime)}`,()=>{
    const html=context.opportunityWindows({start:0,end:10,shotTime},analysis);
    assert.match(html,/window-track/);
    assert.doesNotMatch(html,/<i\s+style=/);
  });
}
for(const [shotTime,left] of [[5,50],[10,100]]){
  test(`known shot at ${shotTime}s retains its ${left}% chart marker`,()=>{
    const html=context.opportunityWindows({start:0,end:10,shotTime},analysis);
    assert.ok(html.includes(`<i style="left:${left}%"></i>`));
  });
}
