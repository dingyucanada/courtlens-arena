#!/usr/bin/env node
/** Node Canvas + FFmpeg release pipeline. No cloud account or OS speech API. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {verifyStoryPlan,renderIdentity,storyTimeMap,hashJSON} from '../pro/story-plan.mjs';
import {renderOverlay} from '../pro/render.mjs';
import {storyFrameAt,drawStoryArrows} from '../pro/camera-view.mjs';
import {vtt} from '../pro/director.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileHash=async file=>sha(await fs.readFile(file));
function run(program,args){const p=spawnSync(program,args,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});if(p.error||p.status!==0)throw new Error(`${program}: ${p.error?.message||p.stderr}`);return p.stdout;}
const probe=(file,ffprobe)=>JSON.parse(run(ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file]));
function wrap(ctx,text,maxWidth,maxLines=3){const lines=[''];for(const c of text){const last=lines.length-1;if(ctx.measureText(lines[last]+c).width>maxWidth&&lines[last])lines.push(c);else lines[last]+=c;}if(lines.length>maxLines)throw new Error('A caption exceeds three lines; shorten it before release.');return lines;}
async function canvasRuntime(){const require=createRequire(import.meta.url);try{return {runtime:await import('@napi-rs/canvas'),packagePath:require.resolve('@napi-rs/canvas/package.json')};}catch(error){if(!process.env.RUNTIME_NODE_MODULES)throw new Error('Install @napi-rs/canvas with npm install; it supports Linux, macOS and Windows.');const packagePath=path.join(process.env.RUNTIME_NODE_MODULES,'@napi-rs/canvas/package.json');return {runtime:await import(pathToFileURL(path.join(path.dirname(packagePath),'index.js')).href),packagePath};}}
async function executableHash(program){if(path.isAbsolute(program))return fileHash(program);for(const directory of (process.env.PATH??'').split(path.delimiter)){const candidate=path.join(directory,program);try{await fs.access(candidate);return fileHash(candidate);}catch{}}throw new Error(`Cannot locate ${program} binary for its actual asset hash.`);}
async function existingRelease(directory,identity,releaseIdentity,planHash){try{const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));const {manifestHash,...body}=manifest;if(manifest.renderIdentity!==identity||manifest.releaseIdentity!==releaseIdentity||manifest.storyPlanHash!==planHash||await hashJSON(body)!==manifestHash)throw new Error('Cached release manifest integrity failed.');for(const entry of manifest.outputs){const file=path.join(directory,entry.name);if(await fileHash(file)!==entry.sha256||(await fs.stat(file)).size!==entry.bytes)throw new Error('Cached release output integrity failed.');}return {directory,manifest: path.join(directory,'manifest.json'),video:path.join(directory,'film.mp4'),renderIdentity:identity,releaseIdentity,outputSha256:manifest.outputs.find(f=>f.name==='film.mp4').sha256,cacheHit:true};}catch(error){if(error.code==='ENOENT')return null;throw error;}}

export async function exportReviewedStoryPlan({plan,video,font,releaseDir,project=plan?.inputSnapshot?.project,width=1280,height=720,fps=25,ffmpeg='ffmpeg',ffprobe='ffprobe'}={}){
  await verifyStoryPlan(plan,project,{requireReviewed:true});
  if(!video||!font||!releaseDir)throw new Error('Provide local video, explicit CJK font file and release directory.');
  video=path.resolve(video);font=path.resolve(font);releaseDir=path.resolve(releaseDir);
  const sourceHash=await fileHash(video),fontHash=await fileHash(font),info=probe(video,ffprobe),stream=info.streams.find(s=>s.codec_type==='video');
  if(!stream)throw new Error('The source has no video track.');
  if(project.video?.sha256&&project.video.sha256!==sourceHash)throw new Error('The source bytes do not match the project video fingerprint.');
  const assets=await Promise.all(['tools/export_story_plan.mjs','pro/story-plan.mjs','pro/render.mjs','pro/calibration.mjs','pro/camera-view.mjs','pro/director.mjs','pro/model.mjs'].map(async name=>({name,sha256:await fileHash(path.join(ROOT,name))})));
  const {runtime,packagePath}=await canvasRuntime(),canvasDir=path.dirname(packagePath),canvasPackage=JSON.parse(await fs.readFile(packagePath,'utf8')),canvasRequire=createRequire(packagePath);
  assets.push({name:'ffmpeg-binary',sha256:await executableHash(ffmpeg)},{name:'ffprobe-binary',sha256:await executableHash(ffprobe)},{name:'ffmpeg-version',sha256:sha(run(ffmpeg,['-version']))},{name:'node-runtime',sha256:sha(JSON.stringify(process.versions))});
  for(const name of ['package.json','index.js','js-binding.js','load-image.js'])assets.push({name:`@napi-rs/canvas/${name}`,sha256:await fileHash(path.join(canvasDir,name))});
  let nativeAssets=0;for(const name of Object.keys(canvasPackage.optionalDependencies??{})){try{const file=canvasRequire.resolve(name);if(file.endsWith('.node')){assets.push({name,sha256:await fileHash(file)});nativeAssets++;}}catch{}}
  if(!nativeAssets)throw new Error('Cannot locate Canvas native asset for reproducible rendering identity.');
  const identity=await renderIdentity(plan,{sourceSha256:sourceHash,renderer:'courtlens-portable-canvas-ffmpeg/1',rendererSha256:assets[0].sha256,assets,font:{family:'Arena Reviewed',sha256:fontHash},audio:{mode:'silent'},width,height,fps});
  const releaseIdentity=await hashJSON({kind:'courtlens-release/1',renderIdentity:identity,storyPlanHash:plan.planHash});
  const destination=path.join(releaseDir,releaseIdentity),hit=await existingRelease(destination,identity,releaseIdentity,plan.planHash);if(hit)return hit;
  const map=storyTimeMap(plan);if(map.clips.some(c=>c.end>Number(info.format.duration)))throw new Error('A source clip exceeds the actual video duration.');
  for(const c of map.clips)if(Math.abs(Math.round(c.start*fps)-c.start*fps)>1e-6||Math.abs(Math.round(c.end*fps)-c.end*fps)>1e-6)throw new Error('Clip in/out times must lie on the selected fps grid; no implicit rounding.');
  const {createCanvas,loadImage,GlobalFonts}=runtime;if(!GlobalFonts.registerFromPath(font,'Arena Reviewed'))throw new Error('Cannot register the supplied font.');
  for(const name of ['Inter','Noto Sans SC','system-ui','sans-serif'])GlobalFonts.registerFromPath(font,name);
  const work=await fs.mkdtemp(path.join(os.tmpdir(),'courtlens-reviewed-'));
  const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');let frames=0;
  try{
    for(const [i,clip] of map.clips.entries()){
      const p=project.plays.find(p=>p.id===clip.playId),dir=path.join(work,`source-${i}`);await fs.mkdir(dir);
      const expected=Math.round((clip.end-clip.start)*fps);
      run(ffmpeg,['-v','error','-protocol_whitelist','file,pipe','-ss',String(clip.start),'-i',video,'-t',String(clip.end-clip.start),'-vf',`fps=${fps},scale=${width}:${height}`,'-frames:v',String(expected),path.join(dir,'%06d.png')]);
      const files=(await fs.readdir(dir)).filter(n=>n.endsWith('.png')).sort();if(files.length!==expected)throw new Error('Decoder produced an incomplete clip.');
      for(const [j,file] of files.entries()){
        const t=clip.start+j/fps,out=clip.outputStart+j/fps;
        ctx.drawImage(await loadImage(path.join(dir,file)),0,0,width,height);
        const frame=storyFrameAt(project,p,t,plan);
        renderOverlay(ctx,frame.play,t,{width,height,layers:plan.layers,focusPlayer:p.player,revealOutcome:false});
        drawStoryArrows(ctx,frame.arrows,width,height);
        ctx.fillStyle='rgba(8,14,26,.93)';ctx.fillRect(0,0,width,Math.max(24,height*.075));ctx.fillStyle='#FFFFFF';ctx.font=`bold ${Math.max(10,Math.round(width*.016))}px "Arena Reviewed"`;ctx.fillText(`CourtLens · ${project.provenance?.kind==='synthetic'?'合成演练':'输入来源未认证'} · ${t.toFixed(2)}s → ${out.toFixed(2)}s`,width*.02,height*.05);
        const active=map.cues.filter(c=>c.clipIndex===i&&c.start<=out&&out<c.end);
        if(active.length){ctx.font=`bold ${Math.max(10,Math.round(width*.022))}px "Arena Reviewed"`;const lines=wrap(ctx,active.map(c=>c.text).join(' '),width*.92);const lineHeight=height*.05,boxHeight=(lines.length+1)*lineHeight;ctx.fillStyle='rgba(8,14,26,.9)';ctx.fillRect(0,height-boxHeight,width,boxHeight);ctx.fillStyle='#FFFFFF';lines.forEach((line,k)=>ctx.fillText(line,width*.04,height-boxHeight+(k+1)*lineHeight));}
        await fs.writeFile(path.join(work,`frame-${String(++frames).padStart(6,'0')}.png`),canvas.toBuffer('image/png'));
      }
    }
    const film=path.join(work,'film.mp4');run(ffmpeg,['-v','error','-framerate',String(fps),'-i',path.join(work,'frame-%06d.png'),'-frames:v',String(frames),'-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart','-an',film]);
    const final=probe(film,ffprobe),actualDuration=Number(final.format.duration);
    if(final.streams.some(s=>s.codec_type==='audio')||Math.abs(actualDuration-map.duration)>1/fps+.001)throw new Error('Encoded release duration or silent-audio contract failed.');
    const staging=path.join(work,'release');await fs.mkdir(staging);
    await fs.copyFile(film,path.join(staging,'film.mp4'));
    await fs.writeFile(path.join(staging,'captions.vtt'),vtt(map));
    await fs.writeFile(path.join(staging,'story-plan.json'),JSON.stringify(plan,null,2)+'\n');
    const outputs=await Promise.all(['film.mp4','captions.vtt','story-plan.json'].map(async name=>{const file=path.join(staging,name);return {name,bytes:(await fs.stat(file)).size,sha256:await fileHash(file)};}));
    const manifest={schema:'courtlens-release/1',createdAt:new Date().toISOString(),renderIdentity:identity,releaseIdentity,storyPlanHash:plan.planHash,reviewedContentHash:plan.contentHash,inputHash:plan.inputHash,source:{sha256:sourceHash,bytes:(await fs.stat(video)).size,frameRate:stream.avg_frame_rate,authenticated:false},renderer:{name:'courtlens-portable-canvas-ffmpeg/1',assets,font:{sha256:fontHash,family:'Arena Reviewed'},audio:{mode:'silent'},width,height,fps},review:plan.review,outputs,timing:{basis:'constant-fps-resampling-grid',sourceToPresentation:map.clips,cues:map.cues,plannedDuration:map.duration,actualDuration,frames},validation:{hashesVerified:true,contentValidated:true,videoAIInference:false,frameAlignmentCertified:false},limitations:['No video AI inference or source authentication is asserted.','Human-reviewed prose and manual arrow geometry are retained, not automatically semantically certified.','Silent MP4; source audio is omitted. Variable-frame-rate footage needs separate frame review.']};
    manifest.manifestHash=await hashJSON(manifest);await fs.writeFile(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    await fs.mkdir(releaseDir,{recursive:true});
    // Copy to a sibling staging directory, then rename atomically on that filesystem.
    const prepared=await fs.mkdtemp(path.join(releaseDir,'.pending-'));try{for(const name of [...outputs.map(o=>o.name),'manifest.json'])await fs.copyFile(path.join(staging,name),path.join(prepared,name),0);await fs.rename(prepared,destination);}catch(error){await fs.rm(prepared,{recursive:true,force:true});const concurrent=await existingRelease(destination,identity,releaseIdentity,plan.planHash);if(concurrent)return concurrent;throw error;}
    return {directory:destination,manifest:path.join(destination,'manifest.json'),video:path.join(destination,'film.mp4'),renderIdentity:identity,releaseIdentity,outputSha256:outputs[0].sha256,cacheHit:false};
  }finally{await fs.rm(work,{recursive:true,force:true});}
}
export async function runStoryPlanExportCLI(args=process.argv.slice(2)) {
  const option=(key,fallback)=>{const i=args.indexOf(key);if(i>=0&&(!args[i+1]||args[i+1].startsWith('--')))throw new Error(`${key} needs a value.`);return i<0?fallback:args[i+1];};
  if(args.includes('--help')){console.log('Reviewed portable release: node tools/export_arena.mjs --story-plan reviewed.json --video source.mp4 --font /path/NotoSansCJK-Regular.ttc --release-dir releases [--width 1280 --height 720 --fps 25]');return;}
  const file=option('--story-plan',null);if(!file)throw new Error('--story-plan is required.');
  const plan=JSON.parse(await fs.readFile(path.resolve(file),'utf8')),projectFile=option('--project',null),project=projectFile?JSON.parse(await fs.readFile(path.resolve(projectFile),'utf8')):plan.inputSnapshot.project;
  const result=await exportReviewedStoryPlan({plan,project,video:option('--video',null),font:option('--font',process.env.ARENA_CJK_FONT),releaseDir:option('--release-dir',path.join(ROOT,'releases')),width:Number(option('--width',1280)),height:Number(option('--height',720)),fps:Number(option('--fps',25))});console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runStoryPlanExportCLI().catch(error=>{console.error(error.message);process.exitCode=1;});
