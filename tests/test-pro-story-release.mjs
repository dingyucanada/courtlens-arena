import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {exportReviewedStoryPlan} from '../tools/export_story_plan.mjs';
import {createLocalStoryPlan,reviewStoryPlan,reviseStoryPlan,hashJSON} from '../pro/story-plan.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const project=()=>({schema:'courtlens-arena/1',id:'portable-smoke',name:'Portable smoke',revision:0,provenance:{kind:'synthetic',source:'generated integration test'},plays:[{id:'p01',title:'Fixture',start:0,end:2,player:'Alice',team:'T',shotTime:.5,resultTime:1.5,shotValue:3,outcome:'made',tracking:{},tracks:[],metrics:{difficulty:{value:.5,semantics:'shot_make_probability',availableAt:.5,unit:'probability'}},provenance:{kind:'synthetic',source:'generated fixture'}}],playlist:[{playId:'p01',start:0,end:2}]});
test('portable exporter rejects unreviewed content before opening media',async()=>{const plan=await createLocalStoryPlan(project());await assert.rejects(()=>exportReviewedStoryPlan({plan,video:'/missing',font:'/missing',releaseDir:'/missing'}),/human review/);});

test('actual portable MP4 has immutable reviewed input, exact output hashes and separate cache revisions',{skip:process.env.ARENA_EXPORT_INTEGRATION!=='1'},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'courtlens-release-test-'));
  try{
    const video=path.join(dir,'source.mp4'),source=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=navy:s=320x180:r=10:d=2','-c:v','libx264','-pix_fmt','yuv420p','-an',video],{encoding:'utf8'});assert.equal(source.status,0,source.stderr);
    const input=project();input.video={sha256:sha(await fs.readFile(video)),duration:2};
    const plan=await reviewStoryPlan(await createLocalStoryPlan(input),{reviewer:'Integration test',reason:'Reviewed source identity, cue content and geometry.'});
    const options={plan,video,font:process.env.ARENA_CJK_FONT,releaseDir:path.join(dir,'releases'),width:320,height:180,fps:10};
    const first=await exportReviewedStoryPlan(options);assert.equal(first.cacheHit,false);
    const manifestFile=await fs.readFile(first.manifest),manifest=JSON.parse(manifestFile),{manifestHash,...body}=manifest;
    assert.equal(manifestHash,await hashJSON(body));assert.equal(manifest.reviewedContentHash,plan.contentHash);assert.equal(manifest.storyPlanHash,plan.planHash);assert.equal(manifest.validation.videoAIInference,false);assert.equal(manifest.timing.frames,20);assert.equal(manifest.timing.actualDuration,2);assert.equal(manifest.renderer.audio.mode,'silent');
    for(const output of manifest.outputs){const actual=await fs.readFile(path.join(first.directory,output.name));assert.equal(output.sha256,sha(actual));assert.equal(output.bytes,actual.length);}
    assert.equal(first.outputSha256,sha(await fs.readFile(first.video)));
    const probe=spawnSync('ffprobe',['-v','error','-show_streams','-of','json',first.video],{encoding:'utf8'});assert.equal(probe.status,0,probe.stderr);assert.equal(JSON.parse(probe.stdout).streams.some(s=>s.codec_type==='audio'),false);
    const repeat=await exportReviewedStoryPlan(options);assert.equal(repeat.cacheHit,true);assert.equal(repeat.renderIdentity,first.renderIdentity);assert.deepEqual(await fs.readFile(first.manifest),manifestFile);
    const cues=structuredClone(plan.cues);cues[1].text='输入概率为 50%。';cues[1].origin='manual';const edited=await reviewStoryPlan(await reviseStoryPlan(plan,{cues}),{reviewer:'Integration editor'});
    const second=await exportReviewedStoryPlan({...options,plan:edited});assert.notEqual(second.renderIdentity,first.renderIdentity);assert.notEqual(second.outputSha256,first.outputSha256);assert.deepEqual(await fs.readFile(first.manifest),manifestFile);
    await fs.appendFile(second.video,'corruption');await assert.rejects(()=>exportReviewedStoryPlan({...options,plan:edited}),/integrity failed/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});


test('native MP4 retains default UI arrows and renders only edited or explicitly cleared final geometry',{skip:process.env.ARENA_EXPORT_INTEGRATION!=='1'},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'courtlens-default-arrow-'));
  try{
    const video=path.join(dir,'source.mp4');let encoded=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=navy:s=320x180:r=10:d=2','-c:v','libx264','-pix_fmt','yuv420p','-an',video],{encoding:'utf8'});assert.equal(encoded.status,0,encoded.stderr);
    const input=project();input.video={sha256:sha(await fs.readFile(video)),duration:2};
    input.plays[0].annotations=[{id:'actual-ui-arrow',kind:'arrow',origin:'manual',source:'manual',start:0,end:2,points:[[.1,.4],[.9,.4]],frame_reviewed:true,evidence_id:'p01:manual',color:'#FF00FF'}];
    const layers={players:false,paths:true,labels:false,zones:false,ball:false,metrics:false,defenders:false};
    const original=await reviewStoryPlan(await createLocalStoryPlan(input,{layers}),{reviewer:'UI arrow pixel reviewer',reason:'Source normalized points and source window checked.'});
    const editedArrows=structuredClone(original.arrows);editedArrows[0].points=[{x:.1,y:.7},{x:.9,y:.7}];
    const edited=await reviewStoryPlan(await reviseStoryPlan(original,{arrows:editedArrows}),{reviewer:'Edited arrow pixel reviewer'});
    const cleared=await reviewStoryPlan(await createLocalStoryPlan(input,{layers,arrows:[]}),{reviewer:'Cleared arrow pixel reviewer'});
    const revisions=[original,edited,cleared],results=[];
    for(const plan of revisions)results.push(await exportReviewedStoryPlan({plan,video,font:process.env.ARENA_CJK_FONT,releaseDir:path.join(dir,'releases'),width:320,height:180,fps:10}));
    assert.equal(new Set(results.map(r=>r.renderIdentity)).size,3);
    const {createRequire}=await import('node:module'),{pathToFileURL}=await import('node:url');const require=createRequire(import.meta.url);let canvasRuntime;
    try{canvasRuntime=require('@napi-rs/canvas');}catch{canvasRuntime=await import(pathToFileURL(path.join(process.env.RUNTIME_NODE_MODULES,'@napi-rs/canvas/index.js')).href);}
    const pixels=[];
    for(const [i,result] of results.entries()){const png=path.join(dir,`film-${i}.png`),decode=spawnSync('ffmpeg',['-v','error','-ss','0.5','-i',result.video,'-frames:v','1',png],{encoding:'utf8'});assert.equal(decode.status,0,decode.stderr);const canvas=canvasRuntime.createCanvas(320,180),ctx=canvas.getContext('2d');ctx.drawImage(await canvasRuntime.loadImage(png),0,0);pixels.push(ctx.getImageData(0,0,320,180).data);}
    const magentaNear=(data,y)=>{let n=0;for(let yy=y-3;yy<=y+3;yy++)for(let x=100;x<=220;x++){const i=(yy*320+x)*4;if(data[i]>150&&data[i+1]<100&&data[i+2]>120)n++;}return n;};
    assert.ok(magentaNear(pixels[0],72)>30,'default UI arrow must survive native export at its original y=.4');
    assert.equal(magentaNear(pixels[0],126),0);
    assert.equal(magentaNear(pixels[1],72),0,'editing must remove the original source arrow');assert.ok(magentaNear(pixels[1],126)>30,'edited final arrow must render at y=.7');
    assert.equal(magentaNear(pixels[2],72),0,'explicit clearing must not revive source UI geometry');assert.equal(magentaNear(pixels[2],126),0);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
