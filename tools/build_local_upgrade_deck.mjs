#!/usr/bin/env node
/** Rebuild the separate 10-slide local 4.1 acceptance deck. Source assets are real captures. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const WORK=path.resolve(REPO,'../offline-20260928');
const BUILD=path.join(WORK,'deck-build');
const PACKED=path.join(REPO,'docs/local-4.1-assets');
const RUNTIME_NODE_MODULES=process.env.RUNTIME_NODE_MODULES;
const SKILL=process.env.PRESENTATIONS_SKILL_DIR;
const PYTHON=process.env.RUNTIME_PYTHON||'python3';
if(!RUNTIME_NODE_MODULES||!SKILL)throw new Error('Set RUNTIME_NODE_MODULES, PRESENTATIONS_SKILL_DIR and RUNTIME_PYTHON from the bundled workspace runtime.');
const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];},draft=args.includes('--draft'),liveAssets=args.includes('--live-assets');
const output=path.resolve(arg('--output',path.join(REPO,'docs/CourtLens-Arena-4.1-本地产品验收.pptx')));
let defaultConfig=path.join(BUILD,'config.json');try{await fs.access(path.join(PACKED,'deck-config.json'));defaultConfig=path.join(PACKED,'deck-config.json');}catch{}
const configFile=path.resolve(arg('--config',defaultConfig));
let config={};try{config=JSON.parse(await fs.readFile(configFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(!draft&&(!Number.isSafeInteger(config.nodePassed)||!Number.isSafeInteger(config.pythonPassed)))throw new Error('Final build requires measured nodePassed and pythonPassed in --config.');
const {Presentation,PresentationFile,FileBlob}=await import(pathToFileURL(path.join(RUNTIME_NODE_MODULES,'@oai/artifact-tool/dist/artifact_tool.mjs')).href);
const {resolvePresentationFont,applyPresentationChartFont,finalizePresentation}=await import(pathToFileURL(path.join(SKILL,'container_tools/artifact_tool_utils.mjs')).href);
const {rehearsalProject}=await import(pathToFileURL(path.join(REPO,'pro/model.mjs')).href);
const {analyzePossession}=await import(pathToFileURL(path.join(REPO,'pro/analytics.mjs')).href);
const {projectAt}=await import(pathToFileURL(path.join(REPO,'pro/calibration.mjs')).href);
const FONT=resolvePresentationFont({fontFamily:'PingFang SC'});
const C={navy:'#0B1933',blue:'#17408B',red:'#C9082A',white:'#FFFFFF',ink:'#14243D',muted:'#596A82',light:'#E5EAF1'};
await fs.mkdir(BUILD,{recursive:true});await fs.mkdir(path.dirname(output),{recursive:true});
try{await fs.symlink(RUNTIME_NODE_MODULES,path.join(BUILD,'node_modules'));}catch(e){if(e.code!=='EEXIST')throw e;}
const project=rehearsalProject(JSON.parse(await fs.readFile(path.join(REPO,'data/demo.json'),'utf8')));
const rows=project.plays.map(play=>({play,analysis:analyzePossession(play)}));
const evidenceFile=async(name,fallback)=>{if(liveAssets)return fallback;try{await fs.access(path.join(PACKED,name));return path.join(PACKED,name);}catch{return fallback;}};
const browser=JSON.parse(await fs.readFile(await evidenceFile('browser-audit.json',path.join(WORK,'browser/results.json')),'utf8'));
let film=JSON.parse(await fs.readFile(await evidenceFile('browser-film-audit.json',path.join(WORK,'browser/browser-film-audit.json')),'utf8'));
const nativeFile=config.nativeManifest?await evidenceFile('native-manifest.json',config.nativeManifest):null;
let nativeManifest=null;
if(nativeFile){nativeManifest=JSON.parse(await fs.readFile(nativeFile,'utf8'));const video=nativeManifest.outputs.find(o=>o.name==='film.mp4');film={mime:'video/mp4',duration:nativeManifest.timing.actualDuration,frameCount:nativeManifest.timing.frames,bytes:video.bytes,sha256:video.sha256};}
const cameraFixture=JSON.parse(await fs.readFile(path.join(REPO,'tests/fixtures/dynamic-camera.json'),'utf8'));
const calibration=cameraFixture.play.calibration??cameraFixture.calibration;
const cameraTimes=[.25,1.75,2,2.25],cameraPoints=cameraTimes.map(t=>projectAt(calibration,t,[20,20]));
const browserPass=browser.checks.filter(c=>c.status==='pass').length,expectedBrowser=config.browserExpected??config.browserPassed;
if(!draft&&(browserPass<10||browser.errors.length||browser.checks.some(c=>c.status!=='pass')||(expectedBrowser!=null&&browserPass!==expectedBrowser)))throw new Error('Final build requires the completed, passing browser audit matching the frozen acceptance count; a partial rerun is not final evidence.');
const paths={dynamic:await evidenceFile('dynamic.png',path.join(WORK,'browser-p1-final/dynamic-editor.png')),frame0:await evidenceFile('frame0.png',path.join(WORK,'video-evidence/frame-00.png')),frame1:await evidenceFile('frame1.png',path.join(WORK,'video-evidence/frame-01.png')),frame2:await evidenceFile('frame2.png',path.join(WORK,'video-evidence/frame-02.png')),film:await evidenceFile('film.png',nativeFile?path.join(BUILD,'native-film-frame.png'):path.join(BUILD,'browser-film-frame.png')),watch:await evidenceFile('watch.png',path.join(WORK,'browser/watch-desktop.png')),mobile:await evidenceFile('mobile.png',path.join(WORK,'browser/watch-mobile.png')),director:await evidenceFile('director.png',path.join(WORK,'browser/director-desktop.png'))};
for(const [key,file] of Object.entries(config.assets??{}))try{await fs.access(file);paths[key]=file;}catch{}
for(const [key,file] of Object.entries(paths)){await fs.access(file);paths[key]=path.resolve(file);}
let packedCaptures=false;try{await fs.access(path.join(PACKED,'watch.png'));packedCaptures=!liveAssets;}catch{}
if(!packedCaptures)for(const [key,file] of [['watch','watch-viewport.png'],['director','director-viewport.png']])try{await fs.access(path.join(WORK,'browser',file));paths[key]=path.join(WORK,'browser',file);}catch{}
const P=Presentation.create({slideSize:{width:1280,height:720}}),slides=[];
function text(s,value,x,y,w,h,size=26,color=C.ink,bold=false,extra={}){const shape=s.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});shape.text=value;shape.text.style={typeface:FONT,fontSize:size,color,bold,autoFit:'none',...extra};return shape;}
function base(title,{dark=false,footnote=''}={}){const s=P.slides.add();slides.push(s);s.background.fill=dark?C.navy:C.white;if(title)text(s,title,48,35,1184,72,45,dark?C.white:C.navy,true);text(s,`${String(slides.length).padStart(2,'0')}  CourtLens Arena 4.1`,48,682,440,24,15,dark?'#C7D3E5':C.muted);if(footnote)text(s,footnote,530,675,702,38,16,dark?'#C7D3E5':C.muted,false,{alignment:'right'});return s;}
function notes(s,body,sources=[]){s.speakerNotes.textFrame.setText(body+'\n\n来源\n'+sources.join('\n'));}
async function image(s,key,x,y,w,h,crop=null){const bytes=await fs.readFile(paths[key]),sw=bytes.readUInt32BE(16),sh=bytes.readUInt32BE(20),cw=sw*(1-(crop?.left??0)-(crop?.right??0)),ch=sh*(1-(crop?.top??0)-(crop?.bottom??0)),scale=Math.min(w/cw,h/ch);const obj=s.images.add({blob:new Uint8Array(bytes),contentType:'image/png',alt:`Actual CourtLens capture: ${key}; synthetic local demonstration`,fit:'contain',position:{left:x+(w-cw*scale)/2,top:y+(h-ch*scale)/2,width:cw*scale,height:ch*scale}});if(crop)obj.crop=crop;return obj;}
function table(s,values,{x=48,y=146,w=1184,h=430,widths,fontSize=24}={}){const t=s.tables.add({rows:values.length,columns:values[0].length,left:x,top:y,width:w,height:h,values,...(widths?{columnWidths:widths}:{})});t.borders.assign({style:'solid',fill:C.light,width:1});for(let r=0;r<values.length;r++)for(let c=0;c<values[0].length;c++){const cell=t.getCell(r,c);cell.fill=r===0?C.blue:C.white;cell.text.style={typeface:FONT,fontSize,color:r===0?C.white:C.ink,bold:r===0,autoFit:'none'};}return t;}
const chartText={typeface:FONT,fontSize:22,fill:C.ink};
function chart(s,kind,options){const c=s.charts.add(kind,options);applyPresentationChartFont(c,{fontFamily:FONT});return c;}
function box(s,title,detail,x,y,w=250,h=120,color=C.blue){const shape=s.shapes.add({geometry:'rect',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:color,width:2}});text(s,title,x+15,y+14,w-30,38,25,color,true);text(s,detail,x+15,y+60,w-30,h-65,21,C.ink);return shape;}
function connect(s,a,b,from='right',to='left',color=C.blue){s.shapes.connect(a,b,{kind:'straight',fromSide:from,toSide:to,line:{fill:color,width:2},tail:{type:'triangle',width:'sm',length:'sm'}});}

// 1. Product subject, one real decoded source frame, minimal cover.
{
 const s=base('',{dark:true,footnote:'本地产品验收说明，非最终决赛提交版'});
 text(s,'CourtLens\nArena 4.1',48,66,530,165,70,C.white,true);
 text(s,'这一球，\n为什么这样打？',48,263,520,168,53,C.white,true);
 await image(s,'frame0',575,89,655,415);
 text(s,'本地产品验收\n与 AWS 接入准备',575,541,655,82,33,C.white,true);
 text(s,'画面、指标与轨迹为合成演练',48,544,490,44,25,'#C7D3E5');
 notes(s,'这份新增10页材料说明4.1的本地产品能力与AWS迁移准备，不能替代正式决赛提交物。画面为从现有H.264源文件实际解码的8秒帧，素材为自行生成的合成演练，球员标识不能当作真实NBA身份。核心产品问题是解释一次篮球选择。',[paths.frame0,'data/demo.json','video-evidence/packet.json']);
}
// 2. Actual desktop and mobile product views, with native image crops.
{
 const s=base('观众先看比赛，再看解释',{footnote:'真实本地界面，390px 移动端已检查'});
 const viewport=(await fs.readFile(paths.watch)).readUInt32BE(20)<=1050;
 await image(s,'watch',48,129,926,455,viewport?{left:0,top:.275,right:0,bottom:0}:{left:0,top:.195,right:0,bottom:.31});
 await image(s,'mobile',1010,126,222,455,{left:0,top:.205,right:0,bottom:.423});
 text(s,'原片对照与增强画面共用播放时钟',48,602,1184,43,30,C.blue,true);
 notes(s,'实际浏览器录屏检查了H.264解码、原片/增强模式保持9秒、指标可用时间、字幕与源证据、390px移动端布局。显示单次出手概率时按原始定义解释，提前不宣布结果。图片保留原始PNG内容，PowerPoint仅应用原生裁剪。',[paths.watch,paths.mobile,'browser/results.json','pro/app.mjs','pro/playback.mjs']);
}
// 3. Actual editor, not a drawn mockup.
{
 const s=base('编辑修改与发布前复核',{footnote:'修改文句或箭头后，旧审阅与成片状态失效'});
 const viewport=(await fs.readFile(paths.director)).readUInt32BE(20)<=1050;
 await image(s,'director',48,133,883,467,viewport?{left:0,top:.27,right:0,bottom:0}:{left:0,top:.113,right:0,bottom:.49});
 text(s,'选片段入出点\n\n逐句查看证据\n\n修正图层和解说\n\n重新审阅并导出',966,147,265,444,26,C.blue,true);
 notes(s,'真实导演界面包含片单入出点、逐句源时间与证据、人工编辑、画面标注和发布前复核。浏览器实际检查修改后旧成片状态及审阅失效；截图显示历史成片需要重新导出的状态。保留可回退成片，但不将旧成片冒称当前版本。',[paths.director,'browser/results.json','pro/app.mjs','pro/story-plan.mjs']);
}
// 4. Editable source-granularity contract comparison.
{
 const s=base('指标粒度与解释范围',{footnote:'本地适配契约，正式数据字典仍待提供'});
 table(s,[['输入粒度','可解释的对象','在故事中的约束'],['单次出手 shot','这一球的命中概率或难度','明确单位、出手身份与可用时刻'],['逐事件 event','有球或无球的对应球员','保留事件ID与指标有效区间'],['单回合 possession','本回合的来源指标','只在定义兼容时参与回合比较'],['球员 player','给定统计区间的背景','保留范围，不替代瞬时球场变化'],['赛季 season','球员或球队的赛季背景','范围与身份匹配，不进入瞬时排序']],{y:145,h:432,widths:[290,416,478],fontSize:24});
 text(s,'未知口径保留原值，缺失保留 null',48,607,1184,42,29,C.blue,true);
 notes(s,'五种粒度来自本地metrics-v2导入契约，不冒称赛方已提供正式字典。原值、单位、来源、字典版本、身份、观察/可用/有效时间完整保留。防守距离不能当作Gravity，未知Leverage不能按便利范围归一化。球员/赛季汇总不能解释瞬时牵制。',[path.join(REPO,'docs/Arena-metrics-v2.md'),'pro/metrics-v2.mjs','pro/analytics.mjs']);
}
// 5. Native quantitative chart directly calculated from the current demo.
{
 const s=base('输入概率与实际投篮结果',{footnote:'合成演练数据，不是 NBA 真实比赛统计'});
 chart(s,'bar',{position:{left:48,top:147,width:760,height:423},categories:rows.map(r=>r.play.id),series:[{name:'输入 xFG 概率',values:rows.map(r=>r.analysis.metrics.difficulty.value),valuesFormatCode:'0%',fill:C.blue}],hasLegend:false,barOptions:{direction:'column',grouping:'clustered',gapWidth:130},xAxis:{textStyle:chartText},yAxis:{min:0,max:1,majorUnit:.25,numberFormatCode:'0%',textStyle:chartText,majorGridlines:{fill:C.light,width:1}},dataLabels:{showValue:true,position:'outEnd',textStyle:{...chartText,bold:true}},chartFill:C.white,plotAreaFill:C.white});
 table(s,[['回合','输入结果'],...rows.map(r=>[r.play.id,r.play.outcome==='made'?'命中':r.play.outcome==='missed'?'未中':'未知'])],{x:873,y:168,w:359,h:309,widths:[145,214],fontSize:26});
 text(s,'概率描述预期，结果在独立时刻揭晓',48,607,1184,44,30,C.blue,true);
 notes(s,'图表实际读取data/demo.json，经过rehearsalProject与analyzePossession，不手抄或伪造数字。概率为输入单次出手记录，结果来自独立事件字段，两者不是同一个量。原生图表与右侧原生表可编辑；图表有从完整字面值建立的工作簿快照。数据为synthetic/schematic，不提供真实NBA准确率结论。',['data/demo.json','pro/model.mjs','pro/analytics.mjs']);
}
// 6. Native camera evidence chart and independently decoded source observation.
{
 const s=base('动态镜头的投影与失效保护',{footnote:'人工关键帧与独立检查，未运行自动光流或身份识别'});
 chart(s,'scatter',{position:{left:48,top:145,width:703,height:397},categories:cameraTimes.map(t=>`${t.toFixed(2)}s`),series:[{name:'画面 x',xValues:cameraTimes,values:cameraPoints.map(p=>Number(p.x.toFixed(6))),fill:C.blue,marker:{symbol:'circle',size:9}},{name:'画面 y',xValues:cameraTimes,values:cameraPoints.map(p=>Number(p.y.toFixed(6))),fill:C.red,marker:{symbol:'square',size:9}}],scatterOptions:{style:'marker'},hasLegend:true,legend:{position:'bottom',textStyle:chartText},xAxis:{min:0,max:2.5,majorUnit:.5,numberFormatCode:'0.0"s"',textStyle:chartText},yAxis:{min:.2,max:.55,majorUnit:.05,numberFormatCode:'0.00',textStyle:chartText,majorGridlines:{fill:C.light,width:1}},dataLabels:{showValue:false},chartFill:C.white,plotAreaFill:C.white});
 await image(s,'frame2',801,156,431,263);
 await image(s,'dynamic',801,414,431,136,{left:400/1440,top:146/1000,right:400/1440,bottom:652/1000});
 text(s,'人工关键帧与独立检查',805,557,425,34,24,C.ink,true);
 text(s,'固定球员 A 的球场坐标不变，画面投影随平移、缩放与切镜改变',48,607,1184,43,27,C.blue,true);
 notes(s,'左图保留6位小数以兼容Excel原生图表，未四舍五入的计算结果保存在statistics.json。使用tests/fixtures/dynamic-camera.json，球员A固定在球场(20,20)，调用projectAt实际生成0.25/1.75/2/2.25秒归一化画面x/y，2秒换镜头。它是独立合成fixture，不是右侧源片轨迹。右上图从演练源视频请求10.5秒，实际PTS10.48秒，属于真实解码帧观察。右下为真实动态编辑器截图，浏览器实际4点保存保留原pan-zoom镜头编号与6个关键帧；展示人工工具，不是自动模型能力。动态方案按镜头人工关键帧插值，独立非拟合检查点验证，遮挡、切镜、超阈值或外推时关闭错误位置/路径；不自动识别球员或切镜。平面投影不恢复空中球3D。',[path.join(REPO,'docs/Arena-dynamic-camera.md'),'tests/fixtures/dynamic-camera.json','pro/calibration.mjs',paths.frame2,paths.dynamic]);
}
// 7. Editable reviewed-content and cache workflow.
{
 const s=base('StoryPlan、人工审阅与缓存',{footnote:'模型提议可以导入，默认生成仍是确定性证据编排'});
 const labels=[['输入','项目与证据'],['提议','文句和图层'],['校验','身份 数字 时间'],['人审','最终内容版本'],['成片','版本与字节哈希']];
 const nodes=labels.map(([a,b],i)=>box(s,a,b,48+i*243,170,211,121,i===3?C.red:C.blue));for(let i=0;i<nodes.length-1;i++)connect(s,nodes[i],nodes[i+1]);
 text(s,'推理缓存',48,393,220,45,30,C.blue,true);text(s,'输入、模型、提示词与参数',286,393,920,45,28);
 text(s,'渲染缓存',48,467,220,45,30,C.red,true);text(s,'最终文句、箭头、图层、时间、音频、字体与资产',286,467,920,80,28);
 text(s,'人工改动保留父版本与原始提议，新的内容必须重新审阅',48,598,1184,48,28,C.blue,true);
 notes(s,'StoryPlan保存原项目/证据/原文快照、inputHash、原始proposal、提供者/模型/提示词及参数、人工change history、review与contentHash/planHash。默认model=none，execution=deterministic-local。外部提议execution=imported-proposal，不代表应用已运行真实模型。生成与渲染身份分开；渲染绑定最终已审内容及实际源片、字体、代码和资产哈希。releaseIdentity再绑定具体planHash，以保留审阅和来源修订。结构校验不能认证篮球因果或所有自然语言语义。',['pro/story-plan.mjs','tools/export_story_plan.mjs','docs/Arena-story-plan.md']);
}
// 8. Actual output frame plus native test readout.
{
 const s=base('本地实测与真实成片',{footnote:'macOS 本机实测，Linux、AWS 与正式数据待验证'});
 await image(s,'film',48,146,696,389);
 const measured=config.nodePassed!=null&&config.pythonPassed!=null;
 if(measured)chart(s,'bar',{position:{left:790,top:158,width:442,height:379},categories:['Node 测试','Python 测试','浏览器检查'],series:[{name:'通过数',values:[config.nodePassed,config.pythonPassed,browserPass],valuesFormatCode:'0',fill:C.blue}],hasLegend:false,barOptions:{direction:'bar',grouping:'clustered',gapWidth:100},xAxis:{min:0,textStyle:chartText,majorGridlines:{fill:C.light,width:1}},yAxis:{textStyle:chartText},dataLabels:{showValue:true,position:'outEnd',textStyle:{...chartText,bold:true}},chartFill:C.white,plotAreaFill:C.white});
 else text(s,`浏览器检查 ${browserPass} 项通过\n\n完整 Node / Python 数量待复验`,805,182,420,248,29,C.blue,true);
 if(measured&&config.pythonSkipped)text(s,`Python ${config.pythonSkipped} 项跳过，未计入通过数`,795,542,437,32,20,C.muted);
 text(s,`${film.duration} 秒   ${film.frameCount} 帧   ${(film.bytes/1024/1024).toFixed(2)} MiB   静音 ${nativeFile?'MP4':'WebM'}`,48,581,1184,43,29,C.blue,true);
 text(s,'成片、字幕和 StoryPlan 共同绑定不可变发布清单',48,632,1184,34,25);
 notes(s,`成片图来自实际${nativeFile?'Canvas+FFmpeg原生MP4':'浏览器WebM'}的${config.filmFrameTime??4.4}秒解码帧。实测文件${film.bytes}bytes，实际${film.duration}秒，${film.frameCount}帧，1280×720，无音轨，SHA-256=${film.sha256}。浏览器最终通过${browserPass}项。Node通过${config.nodePassed??'未冻结'}=${config.nodeNew??'未冻结'}新版+${config.nodeLegacy??'未冻结'}历史套件，skip=${config.nodeSkipped??'未冻结'}；Python ${config.pythonTotal??'未冻结'}tests=${config.pythonPassed??'未冻结'}pass+${config.pythonSkipped??'未冻结'}skip，跳过项不算通过。按配置日志来源记录。便携Canvas+FFmpeg路径已在当前macOS实际渲染测试，代码不依赖macOS语音服务。没有Linux实机结果，不声称Linux已验收。自动测试、合成样本不能推导真实NBA数据或视频模型准确率。`,[paths.film,nativeFile??'browser/browser-film-audit.json','browser/results.json',config.testSource??'最终测试配置','tests/test-pro-story-release.mjs','tests/test-pro-camera-view.mjs']);
}
// 9. Editable proposed AWS path, clearly separated from local completion.
{
 const s=base('AWS 接入准备与目标架构',{footnote:'尚未部署，账号、区域、模型和服务以 Portal 确认为准'});
 const a=box(s,'私有 S3 输入','原片与数据版本',48,150),b=box(s,'API 与任务','身份校验和编排',359,150),c=box(s,'AWS Agent','Portal 确认后接入',670,150),d=box(s,'StoryPlan 人审','冻结最终内容',982,150,250,120,C.red);
 connect(s,a,b);connect(s,b,c);connect(s,c,d);
 const e=box(s,'ECS 成片','Canvas 与 FFmpeg',982,383),f=box(s,'私有 S3 发布','MP4 与版本清单',670,383),g=box(s,'CloudFront','正式作品入口',359,383),h=box(s,'独立访问检查','播放与当前版本',48,383);
 connect(s,d,e,'bottom','top',C.red);connect(s,e,f,'left','right');connect(s,f,g,'left','right');connect(s,g,h,'left','right');
 text(s,'正式输入与模型能力、CDK 部署、Portal 绑定和提交回执仍待实测',48,580,1184,68,29,C.red,true);
 notes(s,'该架构来自本地AWS迁移方案，是目标设计而非已部署资源。Agent服务优先技术候选AgentCore Runtime，但赛方Portal未确认服务、账号、allowedRegion、模型ID与视觉/工具能力。S3/CloudFront/API/任务编排和ECS只描述计划职责，不宣传真实云执行。当前没有正式数据、赛事App绑定或平台提交回执。仅本地通过不能抵消正式云硬项。',['docs/培训后AWS架构与迁移方案.md','docs/培训后开发任务与验收.md']);
}
// 10. Editable operational timeline of goals, not a passed drill.
{
 const s=base('现场 120 分钟的收敛目标',{footnote:'目标尚未做陌生正式素材的完整计时验收'});
 const times=['T+50','T+70','T+90','T+120'];
 const names=['可信事件','可播放版本','可评云版本','提交与回执'];
 const detail=['没有完整计划时\n缩至一个有证据事件','配音超窗或失败时\n使用已测字幕版','独立浏览器可播放\nCloudFront 当前版本','核对代码与作品URL\n保存版本和平台回执'];
 const nodes=times.map((time,i)=>{text(s,time,48+i*306,158,264,80,60,i===2?C.red:C.blue,true);return box(s,names[i],detail[i],48+i*306,278,264,192,i===2?C.red:C.blue);});for(let i=0;i<nodes.length-1;i++)connect(s,nodes[i],nodes[i+1]);
 text(s,'云服务或正式输入身份缺失，仍属于正式交付阻塞',48,569,1184,63,31,C.red,true);
 notes(s,'T+50/T+70/T+90来自团队现场执行手册：没有可信计划时收缩故事，配音失败切字幕，90分钟目标是已独立检查的CloudFront可评考试版本，剩余30分钟必要修订和提交核对。T+120为120分钟结束前完成实际回执目标。所有时间都是内部目标，不是已完成陌生片演练成绩。不能用训练片、本机备用或历史成片抵消AWS Agent/CDK/CloudFront、Portal私有库绑定和正式素材身份等硬项。',['docs/现场执行手册.md','docs/培训后开发任务与验收.md']);
}

const stats={kind:'synthetic-local-acceptance',slides:slides.length,source:'data/demo.json + rehearsalProject + analyzePossession',xfg:rows.map(r=>({playId:r.play.id,probability:r.analysis.metrics.difficulty.value,outcome:r.play.outcome})),camera:cameraTimes.map((t,i)=>({t,...cameraPoints[i]})),browserPass,film:{duration:film.duration,frames:film.frameCount,bytes:film.bytes,sha256:film.sha256},config,assets:paths};
await fs.writeFile(path.join(BUILD,'statistics.json'),JSON.stringify(stats,null,2));
if(!draft){await fs.mkdir(PACKED,{recursive:true});for(const [key,file] of Object.entries(paths)){const target=path.join(PACKED,`${key}.png`);if(path.resolve(file)!==target)await fs.copyFile(file,target);}await fs.writeFile(path.join(PACKED,'browser-audit.json'),JSON.stringify(browser,null,2)+'\n');await fs.writeFile(path.join(PACKED,'browser-film-audit.json'),JSON.stringify(film,null,2)+'\n');if(nativeManifest)await fs.writeFile(path.join(PACKED,'native-manifest.json'),JSON.stringify(nativeManifest,null,2)+'\n');const packedConfig={...config,assets:Object.fromEntries(Object.keys(paths).map(key=>[key,path.join(PACKED,`${key}.png`)]))};await fs.writeFile(path.join(PACKED,'deck-config.json'),JSON.stringify(packedConfig,null,2)+'\n');await fs.writeFile(path.join(PACKED,'statistics.json'),JSON.stringify({...stats,config:packedConfig,assets:packedConfig.assets},null,2)+'\n');}
const stamp=Date.now(),candidate=path.join(BUILD,`candidate-${stamp}.pptx`);await(await PresentationFile.exportPptx(P)).save(candidate);
const previews=path.join(BUILD,draft?'draft-previews':'final-previews');await fs.mkdir(previews,{recursive:true});
let final=P;
if(!draft){const staged=path.join(BUILD,`output-${stamp}`,`CourtLens-Arena-4.1-${stamp}.pptx`);await fs.mkdir(path.dirname(staged),{recursive:true});await finalizePresentation({workspaceDir:path.resolve(REPO,'..'),candidatePath:candidate,finalPath:staged,pythonExecutable:PYTHON,integrityValidatorPath:path.join(SKILL,'container_tools/inspect_presentation_package_integrity.py'),layoutValidatorPath:path.join(SKILL,'container_tools/inspect_presentation_layout_geometry.py'),layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit','--require-native-table-slide','4','--require-native-table-slide','5'],explicitTotalSlideCount:10,requiredNativeTableOwnerSlides:[4,5],requiredNativeChartOwnerSlides:[5,6,8],materializeLiteralChartWorkbooks:true,fontPolicy:{basis:'design',families:[FONT]},verifyArtifactToolImport:true,receiptPath:path.join(BUILD,`validation-${stamp}.json`)});await fs.copyFile(staged,output);final=await PresentationFile.importPptx(await FileBlob.load(staged));}
for(const [i,s] of final.slides.items.entries()){const png=await final.export({slide:s,format:'png',scale:1});await fs.writeFile(path.join(previews,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await png.arrayBuffer()));const layout=await s.export({format:'layout'});await fs.writeFile(path.join(previews,`slide-${String(i+1).padStart(2,'0')}.layout.json`),await layout.text());}
const contactSheet=path.join(BUILD,draft?'draft-contact-sheet.png':'contact-sheet.png');
await promisify(execFile)(PYTHON,['-c',`from PIL import Image
from pathlib import Path
import sys
folder=Path(sys.argv[1]);canvas=Image.new('RGB',(1280,1800),'#E5EAF1')
for i in range(10):
 im=Image.open(folder/f'slide-{i+1:02d}.png').convert('RGB');im.thumbnail((640,360),Image.Resampling.LANCZOS);canvas.paste(im,((i%2)*640,(i//2)*360))
canvas.save(sys.argv[2])`,previews,contactSheet]);
if(!draft){await fs.copyFile(contactSheet,path.join(REPO,'docs/CourtLens-Arena-4.1-预览.png'));await fs.copyFile(path.join(previews,'slide-01.png'),path.join(REPO,'docs/CourtLens-Arena-4.1-封面.png'));}
console.log(JSON.stringify({output:draft?null:output,candidate,previews,contactSheet,slides:slides.length}));
