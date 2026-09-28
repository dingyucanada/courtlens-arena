#!/usr/bin/env node
/** Offline artifact rendering, using the same Arena overlays and cue contract.
 * This does not control a browser or certify the source's authenticity.
 * Install @napi-rs/canvas with npm install, then node tools/export_arena.mjs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {rehearsalProject, parseInput, validateProject} from '../pro/model.mjs';
import {analyzePossession, buildNarration} from '../pro/analytics.mjs';
import {renderOverlay} from '../pro/render.mjs';
import {playlistPlan, vtt, report} from '../pro/director.mjs';
import {validateStoryPlan, storyPlayAt, wrapStoryCaption} from '../pro/export-video.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
// Reviewed portable releases use their own content contract; the historic demo
// path below keeps its existing authored fixture and output behavior.
if(args.includes('--story-plan')){
  const {runStoryPlanExportCLI}=await import('./export_story_plan.mjs');
  await runStoryPlanExportCLI(args);
  process.exit(0);
}
if(args.includes('--help')){
  process.stdout.write('CourtLens Arena 离线成片\n用法：node tools/export_arena.mjs [--project 项目.json] [--video 原片.mp4] [--output 成片.mp4] [--font 中文字体文件]\n默认使用明确标记的合成演练；中文字体须可用，入出点须落在 25fps 网格。\n');
  process.exit(0);
}
const option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const output=path.resolve(option('--output',path.join(ROOT,'media/arena-story-silent.mp4')));
const input=option('--project',null),video=path.resolve(option('--video',path.join(ROOT,'media/demo.mp4')));
const fps=25,width=1280,height=720;
function run(program,argv){const p=spawnSync(program,argv,{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});if(p.error||p.status!==0)throw new Error(`${program} failed: ${p.error?.message||p.stderr}`);return p.stdout;}
const probe=filename=>JSON.parse(run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',filename]));
let canvasModule;
try{canvasModule=await import('@napi-rs/canvas');}catch(error){if(!process.env.RUNTIME_NODE_MODULES)throw new Error('请先运行 npm install 安装离线渲染依赖。');canvasModule=await import(pathToFileURL(path.join(process.env.RUNTIME_NODE_MODULES,'@napi-rs/canvas/index.js')).href);}
const {createCanvas,loadImage,GlobalFonts}=canvasModule;
let chineseFont=null;
for(const candidate of [option('--font',null),process.env.ARENA_CJK_FONT,'/System/Library/Fonts/STHeiti Medium.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','C:/Windows/Fonts/msyh.ttc'].filter(Boolean)){
  try{await fs.access(candidate);if(GlobalFonts.registerFromPath(candidate,'Arena Chinese')){chineseFont=candidate;for(const alias of ['PingFang SC','system-ui','sans-serif'])GlobalFonts.registerFromPath(candidate,alias);break;}}catch{}
}
if(!chineseFont)throw new Error('离线中文渲染需要可用字体，请通过 --font 指定 CJK 字体文件。');
const source=await fs.readFile(video),sourceHash=createHash('sha256').update(source).digest('hex'),sourceInfo=probe(video);
const sourceStream=sourceInfo.streams.find(s=>s.codec_type==='video');
if(!sourceStream)throw new Error('原片没有可解码视频轨。');
const project=input?parseInput(await fs.readFile(path.resolve(input),'utf8'),path.basename(input)).project:rehearsalProject(JSON.parse(await fs.readFile(path.join(ROOT,'data/demo.json'),'utf8')));
if(project.video?.sha256&&project.video.sha256!==sourceHash)throw new Error('原片指纹与项目不一致。');
if(!input){
  // This authored demonstration is intentionally synthetic and manually reviewed.
  if(project.provenance.kind!=='synthetic')throw new Error('默认示例只能是合成演练。');
  project.playlist=[{playId:'p03',start:24,end:36}];
  project.plays.find(p=>p.id==='p03').reviewed=true;
}
validateProject(project);
const analyses={},narrations={};
for(const p of project.plays){analyses[p.id]=analyzePossession(p);const n=buildNarration(p,analyses[p.id],{audience:'fan'});n.cues=n.cues.map(c=>{const edited=project.narrationEdits?.[`fan:${p.id}:${c.start}`]??project.narrationEdits?.[`${p.id}:${c.start}`];return {...c,originalText:c.text,text:edited??c.text,origin:edited==null?'evidence-engine':'manual'};});narrations[p.id]=n;}
if(!input){
  const texts=['合成演练，红队进攻。','五号附近出现空间窗。','七个采样，观察窗三秒。','预期命中率，六成二。','三分命中。'];
  const n=narrations.p03;
  if(n.cues.length!==5||analyses.p03.metrics.difficulty.value!==.62)throw new Error('演练数据已改变，请重新核对演示文句。');
  n.cues=n.cues.map((c,i)=>({...c,text:texts[i],origin:'manual'}));
}
const plan=playlistPlan(project,narrations);validateStoryPlan(plan,project);
if(plan.clips.some(c=>c.end>Number(sourceInfo.format.duration)))throw new Error('片单超出原片时长。');
const work=await fs.mkdtemp(path.join(os.tmpdir(),'courtlens-arena-render-'));
const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');let frames=0;
const rendered=[];
await fs.mkdir(path.dirname(output),{recursive:true});
try{
  for(let i=0;i<plan.clips.length;i++){
    const clip=plan.clips[i],p=project.plays.find(p=>p.id===clip.playId),dir=path.join(work,`source-${i}`);await fs.mkdir(dir);
    const expected=Math.round((clip.end-clip.start)*fps);
    if(Math.abs(expected/fps-(clip.end-clip.start))>.000001)throw new Error('离线输出入出点须落在 25fps 网格上；未擅自修改裁剪时间。');
    run('ffmpeg',['-v','error','-protocol_whitelist','file,pipe','-ss',String(clip.start),'-i',video,'-t',String(clip.end-clip.start),'-vf',`fps=${fps},scale=${width}:${height}`,'-frames:v',String(expected),path.join(dir,'%06d.png')]);
    const files=(await fs.readdir(dir)).filter(n=>n.endsWith('.png')).sort();if(files.length!==expected)throw new Error('原片解码未得到完整计划帧数。');
    for(let j=0;j<files.length;j++){
      const t=clip.start+j/fps,outputTime=clip.outputStart+j/fps;
      ctx.drawImage(await loadImage(path.join(dir,files[j])),0,0,width,height);
      const safe=storyPlayAt(p,t,project);
      const overlay=renderOverlay(ctx,safe,t,{width,height,layers:{paths:true,labels:true,zones:true,defenders:true,ball:true,metrics:false},focusPlayer:p.player});
      ctx.fillStyle='rgba(8,14,26,.93)';ctx.fillRect(0,0,width,54);
      ctx.font='bold 22px "PingFang SC", sans-serif';ctx.fillStyle='#FFFFFF';ctx.fillText('COURTLENS ARENA',24,35);
      ctx.font='18px "PingFang SC", sans-serif';ctx.fillStyle='#FFB454';ctx.fillText(project.provenance.kind==='synthetic'?'合成功能演练 · 非真实 NBA 事件':'来源由项目提供者声明 · 未认证',330,35);
      ctx.fillStyle='#FFFFFF';ctx.fillText(`源 ${t.toFixed(2)}s / 成片 ${outputTime.toFixed(2)}s`,975,35);
      const active=narrations[p.id].cues.filter(c=>t>=c.start&&t<c.end);
      if(active.length){ctx.fillStyle='rgba(8,14,26,.88)';ctx.fillRect(0,height-108,width,108);ctx.font='bold 28px "PingFang SC", sans-serif';ctx.fillStyle='#FFFFFF';const lines=wrapStoryCaption(ctx,active.map(c=>c.text).join(' '),width-90,2);lines.forEach((line,k)=>ctx.fillText(line,45,height-66+k*36));}
      frames++;const target=path.join(work,`frame-${String(frames).padStart(6,'0')}.png`);await fs.writeFile(target,canvas.toBuffer('image/png'));
      if(!input&&i===0&&Math.abs(t-28)<.000001){await fs.mkdir(path.join(ROOT,'docs/arena-assets'),{recursive:true});await fs.writeFile(path.join(ROOT,'docs/arena-assets/export-frame.png'),canvas.toBuffer('image/png'));}
      rendered.push({outputTime,sourceTime:t,playId:p.id,overlayItems:overlay.drawn.length,cueEvidenceIds:active.flatMap(c=>c.evidenceIds)});
    }
  }
  const encoded=path.join(work,'encoded.mp4');
  run('ffmpeg',['-v','error','-framerate',String(fps),'-i',path.join(work,'frame-%06d.png'),'-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart','-an',encoded]);
  await fs.writeFile(output,await fs.readFile(encoded));
  const bytes=await fs.readFile(output),actual=probe(output);
  const metadata={renderer:'offline-shared-arena-canvas',browserRecording:false,sourceAuthenticated:false,cueFrameAlignmentVerified:false,frameTimeBasis:'constant-25fps-resampling-grid',sourceFrameRate:sourceStream.avg_frame_rate,sourceSha256:sourceHash,sourceProvenance:project.provenance,plannedDurationSeconds:plan.duration,durationSeconds:Number(actual.format.duration),frames,width,height,fps,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),hasAudio:false,clips:plan.clips,cues:plan.cues,frameAudit:rendered,limitations:['输出按25fps重采样；对可变帧率原片应另行逐帧核对。','演示文句为标明来源的人工精简，不代表模型推理已验收。','原片声音未写入；中文配音通过本机语音服务另行合成。']};
  await fs.writeFile(output+'.json',JSON.stringify(metadata,null,2));
  await fs.writeFile(output+'.vtt',vtt(plan));
  await fs.writeFile(output+'.html',report(project,analyses,narrations));
  console.log(JSON.stringify({output,frames,durationSeconds:metadata.durationSeconds,bytes:bytes.length,sha256:metadata.sha256}));
}finally{await fs.rm(work,{recursive:true,force:true});}
