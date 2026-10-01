import assert from 'node:assert/strict';
import test from 'node:test';
import {matchingWatchRelease,selectWatchLanguages,loadWatchLanguages,renderWatchLanguages,sourceTimeAfterLanguageSwitch,spokenPlaybackState} from '../broadcast/watch_languages.mjs';
const hash='a'.repeat(64);
function release(id,language='zh-CN',revision=1) {
  return {summary:{id,createdAt:`2026-10-01T00:00:${String(revision).padStart(2,'0')}Z`,videoUrl:`/release/${id}/film.mp4`,videoSha256:hash,voice:{mode:'minimax',language,audioSha256:hash}},manifest:{schema:'courtlens-broadcast-release/1',revision,source:{mediaSha256:hash},story:{language,sourceRange:{start:10,end:58},commentaryCues:[{id:'cue1',sourceStart:11,sourceEnd:14,text:'source text',observationIds:['obs1']},{id:'cue2',sourceStart:20,sourceEnd:23,text:'second source text',observationIds:['obs1']}]},compiledCommentaryCues:[{beatId:'cue1',compiledText:'actual spoken text'}],voice:{mode:'minimax',language,audioSha256:hash},evidence:{observations:[{id:'obs1',kind:'visual',text:'reviewed action'}],bindings:[],metrics:{records:[]}},validation:{durationVerified:true,sourceHashVerified:true,contentHash:`content${revision}`},review:{result:'approved',contentHash:`content${revision}`},outputs:[{name:'film.mp4',sha256:hash}]}};
}
const zh=release('zh'),en=release('en','en-US',2),yue=release('yue','yue-HK',3),project={id:'project',releases:[zh.summary,en.summary,yue.summary]};
test('real translations can have different revisions, but source, reviewed facts and publication must match',()=>{
  assert.equal(matchingWatchRelease(zh,en),true);
  assert.deepEqual(selectWatchLanguages(zh,project,[en,yue]).map(r=>r.summary.id),['zh','en','yue']);
  for(const mutate of [r=>r.manifest.source.mediaSha256='b'.repeat(64),r=>r.manifest.story.sourceRange.end=59,r=>r.manifest.evidence.observations[0].text='changed facts',r=>r.manifest.review.contentHash='stale',r=>r.manifest.validation.durationVerified=false,r=>r.manifest.voice.audioSha256='changed',r=>r.summary.voice.mode='silent',r=>r.manifest.outputs[0].sha256='bad']) {
    const changed=structuredClone(en);mutate(changed);assert.equal(matchingWatchRelease(zh,changed),false);
  }
  assert.deepEqual(selectWatchLanguages(zh,{releases:[zh.summary]},[en]).map(r=>r.summary.id),['zh']);
  assert.deepEqual(selectWatchLanguages(zh,{releases:[]},[en]),[]);
  const newest=release('en-new','en-US',4);
  assert.deepEqual(selectWatchLanguages(zh,{releases:[...project.releases,newest.summary]},[en,newest]).map(r=>r.summary.id),['zh','en-new']);
  assert.equal(selectWatchLanguages(en,project,[zh,yue])[1],en,'keep requested current release');
});
test('public cloud and denied access never expose private sibling releases',async()=>{
  let calls=0;const fail=async()=>{calls++;throw new Error('permission denied');};
  assert.deepEqual(await loadWatchLanguages({reference:zh,cloud:true,listProjects:fail,readProject:fail,readRelease:fail}),[]);
  assert.equal(calls,0);
  assert.deepEqual(await loadWatchLanguages({reference:zh,listProjects:fail,readProject:fail,readRelease:fail}),[]);
  assert.equal(calls,1);
});
test('local viewer discovers owner and tolerates unavailable older releases',async()=>{
  const read=[];
  const rows=await loadWatchLanguages({reference:zh,listProjects:async()=>({projects:[{id:'other'},{id:'project',latestReleaseId:'zh'}]}),readProject:async id=>{read.push(id);return project;},readRelease:async id=>{if(id==='yue')throw new Error('unavailable');return en;}});
  assert.deepEqual(read,['project']);assert.deepEqual(rows.map(r=>r.summary.id),['zh','en']);
  assert.equal(renderWatchLanguages([zh],'zh'),'');
  const html=renderWatchLanguages([zh,en],'en');assert.match(html,/value="en" selected/);assert.match(html,/普通话/);assert.match(html,/英语/);assert.doesNotMatch(html,/粤语/);
  const unsafe=structuredClone(en);unsafe.summary.id='" onclick="bad';assert.doesNotMatch(renderWatchLanguages([zh,unsafe],'zh'),/value="" onclick=/);
});
test('spoken lane follows each actual cue and treats silence as an ordinary gap',()=>{
  assert.equal(spokenPlaybackState({story:{}},20),null,'legacy visual-only release retains fallback');
  assert.equal(spokenPlaybackState(zh.manifest,9).phase,'before');
  assert.equal(spokenPlaybackState(zh.manifest,10).phase,'between');
  assert.equal(spokenPlaybackState(zh.manifest,11).text,'actual spoken text');
  assert.equal(spokenPlaybackState(zh.manifest,14).phase,'between','cue end must clear prior spoken sentence');
  assert.equal(spokenPlaybackState(zh.manifest,21).cue.id,'cue2');
  assert.equal(spokenPlaybackState(zh.manifest,21).index,1);
  assert.equal(spokenPlaybackState(zh.manifest,12).cue.id,'cue1','backward seek recomputes');
  assert.equal(spokenPlaybackState(zh.manifest,58).phase,'after');
  assert.equal(spokenPlaybackState({...zh.manifest,story:{...zh.manifest.story,commentaryCues:[]}},20).phase,'between');
  assert.equal(sourceTimeAfterLanguageSwitch(32,en.manifest),32);assert.equal(sourceTimeAfterLanguageSwitch(0,en.manifest),10);assert.equal(sourceTimeAfterLanguageSwitch(90,en.manifest),58);
});
