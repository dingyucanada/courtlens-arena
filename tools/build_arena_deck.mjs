#!/usr/bin/env node
/**
 * Build an editable 18-slide Arena deck from actual UI screenshots and the
 * executable evidence kernel. No illustrations or charts are raster-drawn.
 *
 * Draft: node tools/build_arena_deck.mjs --draft
 * Final: node tools/build_arena_deck.mjs
 * Optional: --config /absolute/path/deck-config.json --output /absolute/file.pptx
 * The final build refuses missing required screenshot assets. Config can contain
 * assets:{key:filename}, crops:{key:{left,top,right,bottom}}, demoUrl, repoUrl,
 * tests:[{scope,passed,note}], export:{...}. Crops are native PPT source insets.
 * Requires RUNTIME_NODE_MODULES and PRESENTATIONS_SKILL_DIR pointing to a
 * compatible presentation runtime; RUNTIME_PYTHON defaults to python3.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_NODE_MODULES = process.env.RUNTIME_NODE_MODULES;
const RUNTIME_PYTHON = process.env.RUNTIME_PYTHON || 'python3';
const SKILL_DIR = process.env.PRESENTATIONS_SKILL_DIR;
if(!RUNTIME_NODE_MODULES||!SKILL_DIR)throw new Error('PPT rebuild requires RUNTIME_NODE_MODULES and PRESENTATIONS_SKILL_DIR. The delivered PPTX can be opened directly without this optional build runtime.');
process.env.RUNTIME_NODE_MODULES ||= RUNTIME_NODE_MODULES;
process.env.RUNTIME_PYTHON ||= RUNTIME_PYTHON;
const BUILD = path.resolve(REPO, '../pro-research/arena-deck-build');
const ASSETS = path.join(REPO, 'docs/arena-assets');
const ARGS = process.argv.slice(2);
const DRAFT = ARGS.includes('--draft');
const arg = name => {const i=ARGS.indexOf(name);return i===-1?null:ARGS[i+1];};
const OUTPUT = path.resolve(arg('--output') || path.join(REPO,'docs/CourtLens-Arena-产品与参赛方案.pptx'));
const CONFIG = path.resolve(arg('--config') || path.join(ASSETS, 'deck-config.json'));
const {Presentation, PresentationFile, FileBlob} = await import(pathToFileURL(path.join(RUNTIME_NODE_MODULES,'@oai/artifact-tool/dist/artifact_tool.mjs')).href);
const {resolvePresentationFont, applyPresentationChartFont, finalizePresentation} = await import(pathToFileURL(path.join(SKILL_DIR,'container_tools/artifact_tool_utils.mjs')).href);
const {rehearsalProject} = await import(pathToFileURL(path.join(REPO,'pro/model.mjs')).href);
const {analyzePossession, buildNarration} = await import(pathToFileURL(path.join(REPO,'pro/analytics.mjs')).href);
await fs.mkdir(BUILD,{recursive:true});
await fs.mkdir(ASSETS,{recursive:true});
await fs.mkdir(path.dirname(OUTPUT),{recursive:true});
// Bare imports in privately copied tools/finalizer helpers resolve the runtime.
try {await fs.symlink(RUNTIME_NODE_MODULES,path.join(BUILD,'node_modules'));} catch(error) {if(error.code!=='EEXIST')throw error;}
let config={};
try {config=JSON.parse(await fs.readFile(CONFIG,'utf8'));} catch(error) {if(error.code!=='ENOENT')throw error;}
const FONT=resolvePresentationFont({fontFamily:'PingFang SC'});
const C={navy:'#0B1933',blue:'#17408B',red:'#C9082A',white:'#FFFFFF',ink:'#14243D',muted:'#596A82',light:'#E5EAF1',grey:'#AAB7C7'};
const S={
 contest:'https://builderx.csdn.net/bcast-code#challenge',
 nbaAws:'https://pr.nba.com/nba-aws-partnership/',
 sony:'https://pr.nba.com/nba-sony-hawk-eye-innovations-partnership/',
 secondSpectrum:'https://pr.nba.com/nba-genius-sports-second-spectrum-expanded-partnership/',
 xfg:'https://www.nba.com/news/intro-to-expected-field-goal-percentage',
 gravity:'https://www.nba.com/inside-the-game/player/gravity',
 leverage:'https://www.nba.com/news/leverage-stat-explainer',
 awsLeverage:'https://aws.amazon.com/blogs/media/how-the-nba-and-aws-built-an-ai-system-to-measure-what-actually-wins-basketball-games/',
 synergy:'https://support.synergysports.com/support/solutions/articles/77000565958-insights-package',
 hudl:'https://www.hudl.com/sports/basketball',
 curry:'https://cdn-uat.nba.com/news/how-stephen-curry-maintains-peak-conditioning',
 noah:'https://www.noahbasketball.com/methodology',
 homecourt:'https://www.homecourt.ai/faq',
 epv:'https://arxiv.org/abs/1408.0777',
 nfl:'https://www.amazon.science/publications/feeling-the-pressure-a-unified-framework-for-automating-pass-rushing-statistics-in-nfl-games',
 ollama:'https://docs.ollama.com/capabilities/tool-calling',
 bedrock:'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html',
};
const DEMO_URL=config.demoUrl||'https://dingyucanada.github.io/courtlens/';
const REPO_URL=config.repoUrl||'https://github.com/dingyucanada/courtlens';
const project=rehearsalProject(JSON.parse(await fs.readFile(path.join(REPO,'data/demo.json'),'utf8')));
const rows=project.plays.map(play=>({play,analysis:analyzePossession(play),fan:buildNarration(play,analyzePossession(play),{audience:'fan'}),analyst:buildNarration(play,analyzePossession(play),{audience:'analyst'})}));
const p03=rows.find(row=>row.play.id==='p03')||rows.at(-1);
const window=p03.analysis.temporal.opportunityWindows.find(row=>row.playerId===p03.play.player)||p03.analysis.temporal.opportunityWindows[0];
if(!window)throw new Error('The executable rehearsal fixture has no space window for the deck.');
const spacing=p03.analysis.temporal.samples.map(sample=>({t:sample.t,distance:sample.openPlayers.find(player=>player.id===window.playerId)?.nearestDefender?.distanceFt})).filter(sample=>Number.isFinite(sample.distance));
const stats={generatedAt:new Date().toISOString(),source:'data/demo.json + pro/model.mjs rehearsalProject + pro/analytics.mjs',kind:'synthetic-and-schematic',
 plays:rows.map(row=>({id:row.play.id,xfg:row.analysis.metrics.difficulty.value,result:row.play.outcome,frames:row.analysis.temporal.samples.length,
 cues:row.fan.cues,evidence:row.analysis.evidence})),window,spacing};
await fs.writeFile(path.join(ASSETS,'deck-demo-statistics.json'),JSON.stringify(stats,null,2));
const screenshotKeys=['cover','watch','pipeline','ranking','decision','window','fan','analyst','compare','evidence','director','export-frame','projects'];
const paths={};
const missing=[];
// Manually reviewed source insets. Images remain intact in the PPTX; these
// native crops remove long-page padding or enlarge the specific UI evidence.
// Apply only to the exact inspected image size; refreshed captures can override.
const reviewedCrops={
 cover:{size:[1440,1000],crop:{left:270/1440,top:0.084,right:20/1440,bottom:0.445}},
 watch:{size:[1440,1000],crop:{left:270/1440,top:0.084,right:20/1440,bottom:0.17}},
 ranking:{size:[1371,952],crop:{left:383/1371,top:248/952,right:379/1371,bottom:232/952}},
 decision:{size:[1440,1000],crop:{left:400/1440,top:0.151,right:400/1440,bottom:0.15}},
 window:{size:[1440,1761],crop:{left:447/1440,top:510/1761,right:737/1440,bottom:1067/1761}},
 fan:{size:[1440,1000],crop:{left:270/1440,top:0.084,right:20/1440,bottom:0.17}},
 analyst:{size:[1440,1000],crop:{left:270/1440,top:0.388,right:20/1440,bottom:0}},
 evidence:{size:[1440,1000],crop:{left:400/1440,top:0.60,right:400/1440,bottom:0.238}},
};
for(const key of screenshotKeys){
 const configured=config.assets?.[key];
 const candidates=configured?[path.isAbsolute(configured)?configured:path.join(ASSETS,configured)]:[path.join(ASSETS,`${key}.png`),path.join(ASSETS,`arena-${key}.png`),path.join(ASSETS,`${key}.jpg`)];
 for(const candidate of candidates){try{await fs.access(candidate);paths[key]=candidate;break;}catch{}}
 if(!paths[key])missing.push(key);
}
// Reuse a current actual capture when a new browser capture is unavailable;
// native process diagrams take over workflow-only pages without fake UI.
if(!config.assets?.cover&&paths.fan)paths.cover=paths.fan;
if(!paths.watch&&paths.fan)paths.watch=paths.fan;
const required=['cover','watch','ranking','decision','window','fan','analyst','compare','evidence','export-frame'];
const unresolved=required.filter(key=>!paths[key]);
if(!DRAFT&&unresolved.length)throw new Error(`Final deck requires genuine screenshots: ${unresolved.join(', ')}. Use --draft only for outline review.`);
if(!DRAFT&&(!Number.isFinite(config.export?.durationSeconds)||config.export.durationSeconds<=0||!Number.isSafeInteger(config.export?.bytes)||config.export.bytes<1)){
 throw new Error('Final deck requires measured export.durationSeconds and export.bytes; unresolved media placeholders are not publishable.');
}
const referenceSource=process.env.SMARTSHOT_REFERENCE_IMAGE||path.join(ASSETS,'smartshot-reference.jpg');
const reference=path.join(ASSETS,'smartshot-reference.jpg');
try{await fs.access(reference);}catch{try{await fs.copyFile(referenceSource,reference);}catch{}}
const presentation=Presentation.create({slideSize:{width:1280,height:720}});
const slides=[];
const titleSize=43;
function text(slide,content,x,y,w,h,size=24,color=C.ink,bold=false,extra={}){
 const shape=slide.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
 shape.text=content;shape.text.style={typeface:FONT,fontSize:size,color,bold,autoFit:'none',...extra};return shape;
}
function base(title,{dark=false,note=''}={}){
 const slide=presentation.slides.add();slides.push(slide);slide.background.fill=dark?C.navy:C.white;
 if(title)text(slide,title,64,40,1152,66,titleSize,dark?C.white:C.navy,true);
 text(slide,`${String(slides.length).padStart(2,'0')}  CourtLens Arena`,64,678,400,24,16,dark?'#C7D3E5':C.muted);
 if(note)text(slide,note,520,668,696,44,16,dark?'#C7D3E5':C.muted,false,{alignment:'right'});
 return slide;
}
function notes(slide,body,links=[]){slide.speakerNotes.textFrame.setText(`${body}\n\n来源（访问日期 2026-09-28）\n${links.join('\n')}`);}
async function screenshot(slide,key,x,y,w,h){
 const asset=paths[key];
 if(!asset){text(slide,`产品截图待接入：${key}`,x,y,w,h,28,C.muted);return;}
 const bytes=await fs.readFile(asset);
 const reviewed=reviewedCrops[key];
 const source=imageInfo(bytes);
 const matchesSize=reviewed&&source.width===reviewed.size[0]&&source.height===reviewed.size[1];
 const crop=config.crops?.[key]!==undefined?config.crops[key]:(matchesSize?reviewed.crop:undefined);
 // Keep screenshot bytes unchanged. Crop inside the editable PowerPoint image,
 // and size its frame to the retained source ratio instead of stretching UI.
 const sw=source.width*(1-(crop?.left||0)-(crop?.right||0));
 const sh=source.height*(1-(crop?.top||0)-(crop?.bottom||0));
 const scale=Math.min(w/sw,h/sh);
 const frame=crop?{left:x+(w-sw*scale)/2,top:y+(h-sh*scale)/2,width:sw*scale,height:sh*scale}:{left:x,top:y,width:w,height:h};
 const picture=slide.images.add({blob:new Uint8Array(bytes),contentType:source.contentType,alt:`CourtLens Arena ${key} actual product screenshot, synthetic rehearsal`,fit:crop?'cover':'contain',position:frame});
 if(crop)picture.crop=crop;
}
function imageInfo(bytes){
 if(bytes.length>24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return{contentType:'image/png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 if(bytes[0]===0xff&&bytes[1]===0xd8){
  for(let i=2;i+8<bytes.length;){
   if(bytes[i++]!==0xff)continue;
   while(bytes[i]===0xff)i++;
   const marker=bytes[i++];
   if(marker===0xd9||marker===0xda)break;
   if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
   const length=bytes.readUInt16BE(i);
   if(length<2||i+length>bytes.length)break;
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{contentType:'image/jpeg',height:bytes.readUInt16BE(i+3),width:bytes.readUInt16BE(i+5)};
   i+=length;
  }
 }
 throw new Error('Screenshot must contain a recognized PNG or JPEG with readable dimensions.');
}
function nativeTable(slide,values,{x=64,y=150,w=1152,h=430,widths,fontSize=24}={}){
 const table=slide.tables.add({rows:values.length,columns:values[0].length,left:x,top:y,width:w,height:h,values,...(widths?{columnWidths:widths}:{})});
 table.borders.assign({style:'solid',fill:C.light,width:1});
 for(let r=0;r<values.length;r++)for(let c=0;c<values[0].length;c++){
   const cell=table.getCell(r,c);cell.fill=r===0?C.blue:C.white;
   cell.text.style={typeface:FONT,fontSize:r===0?fontSize:fontSize,color:r===0?C.white:C.ink,bold:r===0,autoFit:'none'};
 }
 return table;
}
function chartFont(chart){applyPresentationChartFont(chart,{fontFamily:FONT});return chart;}
const chartText={typeface:FONT,fontSize:22,fill:C.ink};

// 01 Minimal title with the actual product as evidence.
{
 const slide=base('',{dark:true,note:'独立参赛作品，当前画面为合成演练'});
 text(slide,'CourtLens Arena',64,36,1152,83,72,C.white,true);
 text(slide,'读懂每一次篮球选择',66,122,1100,48,32,C.white);
 await screenshot(slide,'cover',64,190,1152,438);
 notes(slide,'作品围绕比赛视频与深度赛场数据，把可核对解释带回原画面。封面为实际产品截图，内置视频、球员标识、指标与轨迹均为自行生成的合成演练。官方历史比赛素材尚待主办方提供。独立作品不代表 NBA 授权产品。',[S.contest]);
}
// 02 Explicit competition coverage, without inventing unpublished judging weights.
{
 const slide=base('比赛要求与可见交付',{note:'赛题完整数据格式与评审细则尚待更新'});
 nativeTable(slide,[['赛题要求','作品中的可见交付'],['比赛视频与深度数据','素材接入与来源记录'],['AI Agent 解读关键回合','证据检索与回合故事'],['箭头、区域、球员标注','原画面上的可控图层'],['同步篮球解说','逐句字幕与时间锚点'],['可运行作品和交付物','网页、源码、文档与视频']],{x:64,y:145,w:520,h:435,widths:[210,310],fontSize:23});
 await screenshot(slide,'watch',620,145,596,435);
 text(slide,'正式接入后沿用同一流程，逐段复核官方画面与数据',64,606,1152,42,24,C.blue,true);
 notes(slide,'赛题依据用户提供的官网完整赛题文字。完整赛题、数据说明、提交规范和评审细则页面仍注明待更新，本稿没有虚构评分权重或正式数据格式。截图为实际运行的合成演练。',[S.contest]);
}
// 03 The user-provided tennis reference, alongside primary professional sources.
{
 const slide=base('专业科技的借鉴与边界',{note:'训练科技的使用不能单独证明夺冠因果'});
 try{const bytes=await fs.readFile(reference);slide.images.add({blob:new Uint8Array(bytes),contentType:'image/jpeg',alt:'User supplied Smartshot tennis recording and analysis workflow poster',fit:'contain',position:{left:64,top:136,width:340,height:486}});}catch{if(!DRAFT)throw new Error('The user supplied Smartshot reference photograph is missing.');text(slide,'Smartshot 网球参考照片',64,136,340,486,26,C.muted);}
 nativeTable(slide,[['专业依据','本版借鉴'],['NBA 与 AWS','模型指标与比赛画面对应'],['Synergy / Hudl','结论直接打开视频证据'],['Noah 与 Curry','用可测量记录复核出手'],['Smartshot 网球参考','录制、监测、报告的完整流程']],{x:445,y:153,w:771,h:408,widths:[240,531],fontSize:25});
 text(slide,'保留真实口径，不复制专有模型或宣称获胜因果',445,592,771,47,25,C.blue,true);
 notes(slide,'照片为用户提供的 Smartshot 展会现场材料，说明录制、赛中监测与赛后分析流程。NBA/AWS 2025-10-01 宣布 Inside the Game；NBA/Sony 2023-03-09 宣布 Hawk-Eye 追踪合作；NBA/Second Spectrum 2023-03-09 公告分析与增强观赛合作。Synergy 官方 Insights 文档与 Hudl 篮球产品把统计连接到片段。NBA 2022-06-13 对 Curry、训练师与助教的采访报道 Noah 使用情况。它支持“使用该技术”，不支持“该技术导致冠军”的因果断言。厂商方法页面也不能代替独立效用实验。',[S.nbaAws,S.sony,S.secondSpectrum,S.synergy,S.hudl,S.curry,S.noah,S.homecourt]);
}
// 04 Native editable operational workflow; captures are used when available.
{
 const slide=base('完整产品流程',{note:'数据与视频留在当前设备，可备份项目并恢复修订'});
 const stages=[['01','视频与数据接入'],['02','时间轴与镜头标定'],['03','回合分析与证据故事'],['04','人工复核与片单编排'],['05','成片、字幕与报告']];
 stages.forEach(([number,label],i)=>{text(slide,number,64,150+i*89,66,48,34,C.red,true);text(slide,label,146,154+i*89,370,44,27,C.ink,true);});
 if(paths.pipeline){
  await screenshot(slide,'pipeline',536,145,680,448);
 }else{
  const a=text(slide,'视频、数据与来源',620,149,522,69,31,C.blue,true);
  const b=text(slide,'回合证据 + 原画面',620,291,522,69,31,C.blue,true);
  const c=text(slide,'修订后的故事片单',620,433,522,69,31,C.blue,true);
  const d=text(slide,'编码视频 · 字幕 · 报告',620,568,522,47,29,C.red,true);
  for(const [from,to]of[[a,b],[b,c],[c,d]])slide.shapes.connect(from,to,{kind:'straight',fromSide:'bottom',toSide:'top',line:{fill:C.blue,width:2},tail:{type:'triangle',width:'sm',length:'sm'}});
 }
 notes(slide,'依据实际 pro/app.mjs、pro/model.mjs、pro/store.mjs、pro/calibration.mjs、pro/director.mjs 流程。视频绑定、来源定义、同步锚点、固定镜头平面标定、回合编辑、项目修订、解说复核与实际录制均属于当前单设备产品范围。用户人工标注与来源声明都有明确标记。浏览器录制需要支持 MediaRecorder 并保持页面前台。不是公开多租户 SaaS 或自动从视频识别全部战术。',['pro/app.mjs','pro/store.mjs','pro/calibration.mjs','pro/director.mjs']);
}
// 05 Native quantitative chart from executable, explicitly synthetic records.
{
 const slide=base('投篮预期与实际结果',{note:'合成演练，概率来自输入记录，不代表真实 NBA 测量'});
 chartFont(slide.charts.add('bar',{position:{left:64,top:159,width:560,height:378},title:'输入预期命中概率',titleTextStyle:{...chartText,fontSize:25,bold:true},
   categories:rows.map(row=>`${row.play.id} ${row.play.outcome==='made'?'命中':'未中'}`),series:[{name:'输入预期命中概率',values:rows.map(row=>row.analysis.metrics.difficulty.value),valuesFormatCode:'0%',fill:C.blue}],
   barOptions:{direction:'column',grouping:'clustered',gapWidth:130},hasLegend:false,
   yAxis:{min:0,max:1,majorUnit:0.25,numberFormatCode:'0%',textStyle:chartText,majorGridlines:{fill:C.light,width:1}},xAxis:{textStyle:chartText},
   dataLabels:{showValue:true,position:'outEnd',textStyle:{...chartText,bold:true},},chartFill:C.white,plotAreaFill:C.white}));
 await screenshot(slide,'ranking',655,154,561,395);
 text(slide,'71% 的出手仍然可能投丢',64,581,1152,46,32,C.blue,true);
 notes(slide,'原生可编辑图表数据由 data/demo.json、pro/model.mjs 的 rehearsalProject 和 pro/analytics.mjs 的 analyzePossession 当次执行得到。p01=0.38，p02=0.71，p03=0.62。输入结果分别 made、missed、made。所有数据为合成演练。图表仅说明概率与单次结果应分别解读，不能证明真实球员的选择质量、概率校准或任何算法精度。编辑优先级不使用结果作为排序依据。',['data/demo.json','pro/model.mjs','pro/analytics.mjs',S.xfg]);
}
// 06 Product interaction, not a hypothetical storyboard.
{
 const slide=base('先选择，再揭晓结果',{note:'须有有效出手时刻；未知或矛盾时不开放判断'});
 await screenshot(slide,'decision',64,135,552,466);
 text(slide,'当前信息下的判断',673,172,543,48,31,C.blue,true);
 text(slide,'01  直接出手\n02  继续寻找传球点\n03  信息不足',673,252,543,192,32,C.ink,true,{lineSpacing:1.55});
 text(slide,'揭晓结果后，重新核对自己的理由',673,471,543,85,26,C.muted);
 text(slide,'先记录自己的选择，再回看比赛结果',64,613,1152,43,27,C.blue,true);
 notes(slide,'实际产品“结果揭晓前·决策冻结”交互。需要有效且无矛盾的shotTime。未知shotTime在项目数据中保持null，不以end-.2代替。仅有resultTime的回合仍可按有效结果时刻正常解读，但不开放出手前判断。已有shotTime但结果非法或矛盾时拒绝，只有有效shotTime且结果缺失可开启，结果仍未知。有效字段不构成来源认证。浏览器检查请求32.50秒，实际显示32.52秒解码帧，短播后暂停，只用最近32.50秒采样，近防距离4.4ft，0/3指标可用，未来指标与结果隐藏。分析器按asOf过滤未来availableAt、轨迹和结果；用户先记录选择再揭晓，不证明替代选择一定更优。截图仍为合成演练。',['docs/arena-assets/decision-final.png','pro/model.mjs','pro/app.mjs decisionDialog','pro/analytics.mjs analyzePossession']);
}
// 07 Real geometric calculation, shown as native chart and original UI state.
{
 const slide=base('采样中的空间机会',{note:'合成坐标，6 ft 为可修改的几何阈值'});
 const upper=Math.max(8,Math.ceil(Math.max(...spacing.map(p=>p.distance))+1));
 chartFont(slide.charts.add('scatter',{position:{left:64,top:148,width:592,height:405},title:'H5 最近已记录防守者距离',titleTextStyle:{...chartText,fontSize:25,bold:true},
   series:[{name:'输入样本',xValues:spacing.map(p=>p.t),values:spacing.map(p=>Number(p.distance.toFixed(3))),valuesFormatCode:'0.000',line:{fill:C.blue,width:3},marker:{symbol:'circle',size:4}},
           {name:'6 ft 自定义阈值',xValues:[p03.play.start,p03.play.end],values:[6,6],line:{fill:C.red,width:2},marker:{symbol:'none'}}],
   scatterOptions:{style:'lineWithMarkers'},hasLegend:true,legend:{position:'bottom',textStyle:{...chartText,fontSize:19}},
   xAxis:{min:p03.play.start,max:p03.play.end,majorUnit:2,title:{text:'视频绝对秒',textStyle:chartText},textStyle:chartText},
   yAxis:{min:0,max:upper,majorUnit:2,title:{text:'ft',textStyle:chartText},textStyle:chartText,majorGridlines:{fill:C.light,width:1}},chartFill:C.white,plotAreaFill:C.white}));
 nativeTable(slide,[['内核计算结果','p03 · H5'],['观察区间',`${window.start.toFixed(1)}–${window.end.toFixed(1)} s`],['样本内持续长度',`${window.duration.toFixed(1)} s`],['最低近防距离',`${window.minDistanceFt.toFixed(3)} ft`],['有效样本数',String(window.sampleCount)],['最大样本间隔',`${window.maxGap.toFixed(1)} s`]],{x:696,y:151,w:520,h:393,widths:[275,245],fontSize:25});
 text(slide,`${window.start.toFixed(1)}–${window.end.toFixed(1)} 秒`,64,580,620,49,34,C.blue,true);
 text(slide,`${window.duration.toFixed(1)} 秒观察窗，采样间隔 ${window.maxGap.toFixed(1)} 秒`,700,581,516,49,26,C.ink);
 notes(slide,`当次执行内核所得 p03 ${window.playerId} 窗口：start=${window.start}, end=${window.end}, duration=${window.duration}s，minDistanceFt=${window.minDistanceFt}，sampleCount=${window.sampleCount}，maxGap=${window.maxGap}s，timingUncertaintySec=${window.timingUncertaintySec}s。定义为完整防守名单的离散样本内最近防守距离不低于 6 ft，不能确认间隙内持续空位或传球可完成。几何距离不替代官方 Gravity。首次读数与完整窗口分别在证据可用后叙述，避免未来样本泄漏。所有坐标为合成演练。原生 scatter chart 保留全部采样点，距离保留三位小数以适配 Excel 工作簿，未舍入计算记录另存统计 JSON。`,['docs/arena-assets/deck-demo-statistics.json','pro/analytics.mjs opportunityWindows',S.gravity]);
}
// 08 A deliberate comparison using two distinct UI captures.
{
 const slide=base('同一证据，两种观看视角',{note:'内容按观看者调整，证据 ID 与时刻保持一致'});
 text(slide,'普通球迷',64,131,560,41,29,C.blue,true);
 text(slide,'专业解读',656,131,560,41,29,C.red,true);
 await screenshot(slide,'fan',64,182,560,382);
 await screenshot(slide,'analyst',656,182,560,382);
 text(slide,'空间和选择，用直观语言说明',64,592,560,52,25,C.ink);
 text(slide,'显示口径、样本间隔和引用',656,592,560,52,25,C.ink);
 notes(slide,'截图分别来自当前产品的 fan 与 analyst 视角，使用不同状态的真实产品画面，不是生成的界面概念。buildNarration 改变措辞与证据展示密度，引用同一分析记录。当前中文本地解说为确定性编排，不宣称语言模型已运行。专业模式还显示输入引力口径、采样阵形变化及相关限制。',['pro/analytics.mjs buildNarration','pro/app.mjs']);
}
// 09 Full screenshot, readable product evidence.
{
 const slide=base('双回合同屏比较',{note:'两条源时间轴，来源与样本各自保留'});
 await screenshot(slide,'compare',64,140,1152,464);
 text(slide,'分别定位两个片段，再比较出手、空间与防守关系',64,613,1152,43,26,C.blue,true);
 notes(slide,'实际产品双回合比较页面，截图保留两段独立源视频秒数，不作为相同战术时刻或帧对齐精度的测量证据。产品提供相对回合进度回放，但不能把相对播放进度误称完全相同战术时刻。两个回合各自保留来源与证据。比较当前项目提供的片段，不宣称访问 NBA Play Finder 私有历史库。两支球队、运动、结果与指标均为合成演练。',['pro/app.mjs compare']);
}
// 10 Native evidence timeline with invisible offsets and explicit data lineage.
{
 const slide=base('逐句解说的画面锚点',{note:'原视频绝对秒与成片相对秒分别记录'});
 const cues=p03.fan.cues;
 const labels=['进攻开始','首次空间读数','完整观察窗','出手指标','结果揭晓'].slice(0,cues.length);
 const chartCues=[...cues].reverse();
 chartFont(slide.charts.add('bar',{position:{left:64,top:155,width:565,height:388},title:'p03 解说时间线 · 回合内秒',titleTextStyle:{...chartText,fontSize:25,bold:true},
   categories:[...labels].reverse(),series:[{name:'开始偏移',values:chartCues.map(cue=>cue.start-p03.play.start),fill:'none',line:{fill:'none',width:0}},
                           {name:'字幕停留',values:chartCues.map(cue=>cue.end-cue.start),fill:C.blue}],
   barOptions:{direction:'bar',grouping:'stacked',overlap:100,gapWidth:75},hasLegend:false,
   xAxis:{textStyle:{...chartText,fontSize:21}},
   yAxis:{min:0,max:p03.play.end-p03.play.start,majorUnit:3,title:{text:'回合内秒数',textStyle:chartText},textStyle:chartText,majorGridlines:{fill:C.light,width:1}},dataLabels:{showValue:false,position:'center'},chartFill:C.white,plotAreaFill:C.white}));
 text(slide,'逐条查看字段、来源与视频时刻',664,177,552,51,27,C.blue,true);
 await screenshot(slide,'evidence',664,243,552,282);
 text(slide,'选择一条解释，立即回到对应画面与来源字段',64,588,1152,47,28,C.blue,true);
 notes(slide,'时间线由 p03 buildNarration fan.cues 原样生成。开始偏移系列透明且不显示标签，只负责放置蓝色字幕持续条。真实区间保留在可编辑原生图表的工作簿中，单位秒。每句 evidenceIds 对应输入字段与 t 时间。结果只从 resultTime 起显示。发布故事可选模型仅选择既有 ID，服务端重新从输入证据值编译文字，不采用模型自由生成数值。结构验证不认证官方来源。',['docs/arena-assets/deck-demo-statistics.json','pro/analytics.mjs buildNarration','core/arena_agent.py']);
}
// 11 Real editing workflow.
{
 const slide=base('故事制作与发布复核',{note:'人工修改与标注都保留身份，修改后重新核对'});
 if(paths.director){
  await screenshot(slide,'director',64,137,1152,467);
 }else{
  const steps=[['01','选入片单','设置原视频入出点'],['02','逐句复核','修改文字，保留人工标记'],['03','画面标注','箭头、区域与球员标签'],['04','编码交付','成片、VTT 与证据 JSON']];
  steps.forEach(([n,title,caption],i)=>{text(slide,n,64,164+i*105,62,49,32,C.red,true);text(slide,title,143,166+i*105,433,48,30,C.blue,true);text(slide,caption,143,208+i*105,433,44,24,C.muted);});
  text(slide,'回合解释 · 实际观看页',640,134,576,45,26,C.blue,true);
  await screenshot(slide,'watch',640,189,576,398);
 }
 text(slide,'片段入出点、顺序、解说与画面标注可继续编辑',64,613,1152,43,27,C.blue,true);
 notes(slide,`${paths.director?'本页为实际制作页截图。':'本页为依据实际模块绘制的可编辑制作流程，右侧使用实际观看页截图，不冒称制作页界面。'}产品支持逐句编辑、人工箭头/区域/标签、片单入出点、顺序调整、回合复核与导出入口。人工标注不冒称自动识别，用户复核勾选属于操作者声明。导出片单把原视频秒转换成成片相对秒，并保留 sourceStart/sourceEnd。项目备份和修订支持继续工作。`,['pro/app.mjs director','pro/director.mjs playlistPlan','pro/store.mjs']);
}
// 12 Actual encoded output and honest media limitations.
{
 const exported=config.export||{};
 const format=exported.format||'WebM';
 const audio=exported.hasAudio?`${exported.audioCodec||'编码音轨'} · 中文配音`:'当前无音轨';
 const slide=base(exported.browserRecording?'实机跑通的有声战术成片':'真实编码的战术成片',{note:exported.browserRecording?'浏览器录制、配音、保存与下载均已实测':'中文配音已编码到实际视频文件'});
 await screenshot(slide,'export-frame',64,150,775,439);
 nativeTable(slide,[['交付','当前内容'],['战术视频',format],['画布尺寸',exported.resolution||'1280 × 720'],['编码时长',exported.durationSeconds!=null?`${Number(exported.durationSeconds).toFixed(6)} 秒`:'以交付视频元数据核对'],['音频',audio],['实际帧数',exported.frames!=null?`${exported.frames} 视频帧`:'见媒体探测']],{x:875,y:155,w:341,h:408,widths:[130,211],fontSize:23});
 const size=exported.bytes!=null?`实际 ${Number(exported.bytes).toLocaleString('en-US')} 字节 · 下载指纹核对一致`:'原画面叠加与字幕写入编码视频';
 text(slide,size,64,613,1152,42,26,C.blue,true);
 notes(slide,`成片截帧来自实际编码的视频文件。${exported.browserRecording===true?'本片完整实跑Arena浏览器录制→本机Tingting配音→HTTP持久素材库→浏览器原生下载，下载文件SHA-256核对一致。1280×720、H264/AAC、300视频帧、容器12.008333秒，平均帧率4500/181，不是恒定25fps。源帧24.00至35.96秒，最大已观察源帧间隔0.04秒。计划12秒、输入WebM12.008秒，漂移0.008秒、统一近似时长缩放1.000666667。':'本片是离线共享Arena内核编码，链路另列。'}原片音轨省略；本机中文声音真实编码到AAC。不把浏览器试听当成成片配音，实际功能成功也不证明逐句画面语义认证或真实NBA解说精度。5句短文已人工精简复核并有证据ID，未实调LLM。字幕VTT、分镜证据JSON、HTML和项目备份分别交付。另有离线12秒/300帧/25fps成片，不能将它的恒帧率标签套用本片。实测输出元数据：${JSON.stringify(exported)}。`,['pro/app.mjs exportVideo','pro/director.mjs',...(exported.sourceFiles||[])]);
}
// 13 Native editable definitions table.
{
 const slide=base('指标定义与证据边界',{note:'合成演练的 Leverage 口径与官方新指标不同'});
 nativeTable(slide,[['指标','官方定义依据','本版处理'],['出手概率 / xFG','联盟平均参考球员的出手概率','读取原值、单位与定义版本'],['Gravity','实际与预期防守注意力的差别','保留来源模型值，另列几何描述'],['Leverage','事件结果翻转的胜负机会影响','先核对具体口径与适用尺度'],['几何观察窗','输入样本中的近防距离和时段','标记阈值、采样间隔与来源']],{x:64,y:153,w:1152,h:412,widths:[280,430,442],fontSize:25});
 text(slide,'缺失保持缺失，不用近防距离冒算官方引力',64,603,1152,46,28,C.blue,true);
 notes(slide,'NBA xFG 专题说明使用联盟平均参考，不直接表示球员个人真实命中率。Gravity 对比实际防守关注与基于位置的预期关注，近防距离不能复刻它。官方 Leverage 以事件反事实结果产生的胜负机会影响为基础，不应当作开始到结束的简单实际胜率差。AWS Leverage 技术说明对模型应用有进一步描述。合成演练中的 0–1 possession_win_probability_opportunity 是项目声明的不同输入语义，原值不会靠重命名变成官方统计。实验室跨回合比较同时核对语义、单位与definition；即使语义和单位相同，definition不同也拒绝比较。投篮概率乘分值也不能冒充包含传球、失误、篮板和犯规的完整 EPV。',[S.xfg,S.gravity,S.leverage,S.awsLeverage,S.epv,'pro/analytics.mjs']);
}
// 14 Explicitly requested editable architecture diagram; no illustrative art.
{
 const slide=base('Agent 与视频制作架构',{note:'本地引擎实际工作，可选模型服务需要用户连接'});
 const input=text(slide,'比赛视频\n数据与时间字典',64,181,245,105,31,C.blue,true);
 const browser=text(slide,'浏览器项目\n证据分析与原画面叠加',438,181,365,105,31,C.blue,true);
 const output=text(slide,'故事片单\n视频与证据报告',933,181,283,105,31,C.blue,true);
 const model=text(slide,'可选模型 Agent\n检索、读取、选择已有声明',427,412,386,115,29,C.red,true);
 presentation.slides; // Deliberately use native connectors for the architecture.
 slide.shapes.connect(input,browser,{kind:'straight',fromSide:'right',toSide:'left',line:{fill:C.blue,width:3},tail:{type:'triangle',width:'sm',length:'sm'}});
 slide.shapes.connect(browser,output,{kind:'straight',fromSide:'right',toSide:'left',line:{fill:C.blue,width:3},tail:{type:'triangle',width:'sm',length:'sm'}});
 slide.shapes.connect(browser,model,{kind:'straight',fromSide:'bottom',toSide:'top',line:{fill:C.red,width:2},head:{type:'triangle',width:'sm',length:'sm'},tail:{type:'triangle',width:'sm',length:'sm'}});
 text(slide,'来源与同步',72,131,245,44,23,C.muted);
 text(slide,'本地保存、逐句引用',460,131,343,44,23,C.muted);
 text(slide,'实际录制编码',953,131,263,44,23,C.muted);
 text(slide,'服务端校验引用、归属与时序，再从输入证据编译公开文字',119,582,1054,66,27,C.ink,true);
 notes(slide,'架构图以可编辑原生文字与连接器表示实际模块关系。浏览器 pro/model.mjs、analytics.mjs、render.mjs、director.mjs、store.mjs 完成数据合同、本地证据内核、画面叠加、制作与保存。可选 core/arena_agent.py 对 Bedrock Converse 或固定 127.0.0.1:11434 Ollama 执行 read_evidence/search_plays/publish_story 工具循环，最多 4 轮、8 声明，输入不超过100000 bytes。模型选择 ID，服务端拒绝不存在、未读取、时刻未可用的声明，并从字段值生成文字。浏览器数据经结构、引用、单位和时序验证，不等于服务器重算全部轨迹或认证 NBA 来源。当前未声称模型真实实调成功。原视频不随模型请求发送。',[S.bedrock,S.ollama,'core/arena_agent.py','pro/analytics.mjs']);
}
// 15 Actual tests, carefully separated from data accuracy or cloud verification.
{
 const slide=base('验证范围与实测证据',{note:'自动化功能验收不等于真实 NBA 分析准确率'});
 const tests=config.tests||[{scope:'模型 Agent 离线协议',passed:23,note:'mock Bedrock / Ollama'},
                           {scope:'前后端分析接口',passed:3,note:'3 个合成回合互通'}];
 const testDetails=config.testDetails||{};
 const values=[['已测范围','通过数','证据与边界'],...tests.map(test=>[test.scope,String(test.passed),test.note])];
 nativeTable(slide,values,{x:64,y:150,w:609,h:408,widths:[240,100,269],fontSize:23});
 if(paths.projects){
  await screenshot(slide,'projects',707,152,509,400);
 }else{
  const a=text(slide,'读取已存在的证据',749,157,467,67,30,C.blue,true);
  const b=text(slide,'校验引用、归属与时间',749,303,467,67,30,C.blue,true);
  const c=text(slide,'从字段值编译公开文字',749,447,467,67,30,C.red,true);
  for(const[from,to]of[[a,b],[b,c]])slide.shapes.connect(from,to,{kind:'straight',fromSide:'bottom',toSide:'top',line:{fill:C.blue,width:2},tail:{type:'triangle',width:'sm',length:'sm'}});
 }
 text(slide,'模型只测协议；成片库含 6 项真实 HTTP 验证',64,596,1152,49,28,C.blue,true);
 notes(slide,`最终实际复跑：Arena JS${testDetails.arena}、Studio/site${testDetails.studioSite}、旧入口CJS${testDetails.legacyCjs}，Node合计${testDetails.nodeTotal}，skip=${testDetails.nodeSkipped}。本轮新增事件语义${testDetails.eventSemanticsWithinArena}、出手标记${testDetails.shotMarkersWithinArena}、实验室指标合同${testDetails.labDefinitionWithinArena}，合计${testDetails.releaseRegressionWithinArena}项，均已计入Arena${testDetails.arena}。既有决策时刻边界${testDetails.shotTimeBoundarySuiteWithinArena}项也在Arena范围内。原macOS环境提供实际捕获WebM的Python完整${testDetails.pythonTotal}项，skip=${testDetails.pythonSkipped}；清包独立macOS验收Python${testDetails.packagedPythonPassed}项通过、${testDetails.packagedPythonSkipped}项因原始捕获WebM未入包而跳过，不算通过。随包转码MP4不能代替该原始输入。publicsite${testDetails.publicSite}项通过。Python${testDetails.pythonTotal}内含Agent${testDetails.arenaAgentWithinPython}、voice${testDetails.arenaVoiceWithinPython}、artifacts${testDetails.arenaArtifactsWithinPython}，其中${testDetails.actualHttpWithinArtifacts}项实际HTTP，不重复计数。确切配置：${JSON.stringify(tests)}。模型提供方仍是mock，不宣传为真实云模型效果。3回合内核接口验证使用75帧合成位置、实际buildNarration输出与服务端验证。覆盖未知或跨回合ID、先读后发布、未来证据、缺失、非有限值、字节/轮数/工具/截止预算和连接失败。回归覆盖未知shotTime保持null、result-only正常解读与决策冻结限制、实验室未知语义、缺Gravity单位/定义、不同方向、definition、range与来源类型不兼容（含无排序signature的原始读数）拒绝比较；Gravity缺单位/定义同时不赋归一化值或排序分量，以及窄屏项目切换可见。浏览器中文配音→持久保存→原生下载已经实机跑通，736735字节MP4，SHA7587b302d1cfdef6e0ee530d56d78499ad935a7b453b51f367bf5e9c405a0e2f；连续两段27–29/33–35秒实机播放结束在34.96秒暂停。来源声明仍不构成认证；未验收真实NBA数据、LLM推理或逐帧语义。`,['docs/Arena-使用与验收.md','docs/arena-assets/browser-export-validation.json','tests/test-pro-model.mjs','tests/test-pro-analytics.mjs','tests/test-pro-decision-attack.mjs','tests/test_arena_agent.py','tests/test_arena_artifacts.py','tests/test_arena_voice.py']);
}
// 16 Field-ready intake procedure; no invented official schema.
{
 const slide=base('官方素材的现场接入',{note:'当前接口是项目中间格式，正式赛方字典尚待提供'});
 nativeTable(slide,[['检查内容','现场操作','继续工作的条件'],['原始素材与授权范围','保留原文件、来源与版本','视频可播放且允许比赛使用'],['数据字典与指标口径','核对 xFG、Gravity、Leverage','单位、含义和尺度明确'],['时间轴对应关系','画面锚点同步源时钟','出手与结果时刻人工核对'],['坐标系与镜头','区分球场坐标和画面坐标','固定镜头分段标定'],['逐回合复核','查轨迹缺口与逐句证据','缺失保留空值，修改留修订'],['最终作品检查','回放导出视频与字幕','编码文件、引用和同步一致']],{x:64,y:150,w:1152,h:453,widths:[295,423,434],fontSize:24});
 notes(slide,'主办方素材接入清单。官网完整数据格式尚待提供，项目 JSON/CSV 中间格式不冒称官方接口。镜头平面变换只适用于地面点，球员头部与空中球需要3D或其他模型，不用平面标定代替。镜头移动、缩放或切换需要新标定或停用不可靠图层。单条同步锚点仅固定偏移，多条不外推。对来源字典的未说明字段保持 unknown，不猜单位或缺失值。选择编辑优先级是明确的编辑规则，不是模型准确率。',[S.contest,'pro/model.mjs','pro/calibration.mjs','pro/analytics.mjs']);
}
// 17 Real contexts, without made-up market size or claimed paid customers.
{
 const slide=base('真实使用场景',{note:'产品当前面向单设备工作，自有或获准素材'});
 nativeTable(slide,[['使用者','工作任务','交付结果'],['赛事解说与内容编辑','赛前准备、赛后战术片段','可核对的故事片单和成片'],['篮球媒体与创作者','解释无球空间与出手选择','普通球迷或专业版本解说'],['篮球教学与社团','先讨论决策，再观看结果','逐句证据和对比片段'],['训练与球队复盘','分析自有比赛和训练视频','项目修订、素材记录和报告']],{x:64,y:159,w:1152,h:383,widths:[280,430,442],fontSize:27});
 text(slide,'商业验证下一步：带真实授权素材做试用，测编辑时间与观众理解',64,585,1152,72,29,C.blue,true);
 notes(slide,'使用场景属于产品适用建议，未声称已有 NBA 球队部署、付费客户、市场规模或商业合作。商业验证指标建议为完成同一片段所需编辑时间、证据复核错误和观众理解，不预先声称改善幅度。训练复盘仅描述动作和比赛记录，不提供医疗诊断、伤病预测或“科技导致冠军”的归因。对球队材料要先确认权限，产品当前单设备范围不冒称多人团队云系统。',[S.synergy,S.hudl,S.noah,S.homecourt]);
}
// 18 Concrete working links and clean finish.
{
 const slide=base('',{dark:true,note:'官方素材接入后，按同一流程复核并交付'});
 text(slide,'CourtLens Arena',64,88,1152,90,70,C.white,true);
 text(slide,'让每一次解释，都回到比赛画面',64,202,1152,70,42,C.white,true);
 text(slide,'在线演示',64,354,220,42,26,'#B8CAE5',true);
 text(slide,DEMO_URL,64,403,1152,52,29,C.white);
 text(slide,'完整源码与可运行交付',64,505,440,42,26,'#B8CAE5',true);
 text(slide,REPO_URL,64,554,1152,52,29,C.white);
 notes(slide,`公开演示链接：${DEMO_URL}\n源码仓库：${REPO_URL}\n交付包含可运行网页与本机服务、源码、方法与接入说明、演示视频、证据报告、字幕与项目备份。产品截图和所有图表演练数据为自行生成。正式NBA视频与数据还需要主办方许可与现场复核。`,[S.contest,DEMO_URL,REPO_URL]);
}

await fs.writeFile(path.join(BUILD,'deck-statistics.json'),JSON.stringify(stats,null,2));
await fs.writeFile(path.join(BUILD,'missing-assets.json'),JSON.stringify({unresolvedRequired:unresolved,optionalMissing:missing.filter(key=>!required.includes(key)),assets:paths},null,2));
const candidate=path.join(BUILD,DRAFT?'outline-draft.pptx':`candidate-${Date.now()}.pptx`);
await (await PresentationFile.exportPptx(presentation)).save(candidate);
const previewDir=path.join(BUILD,DRAFT?'draft-previews':'final-previews');
await fs.mkdir(previewDir,{recursive:true});
for(let i=0;i<slides.length;i++){
 const preview=await presentation.export({slide:slides[i],format:'png',scale:1});
 await fs.writeFile(path.join(previewDir,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await preview.arrayBuffer()));
 const layout=await slides[i].export({format:'layout'});
 await fs.writeFile(path.join(previewDir,`slide-${String(i+1).padStart(2,'0')}.layout.json`),await layout.text());
}
if(!DRAFT){
 const finalDir=path.join(BUILD,'final-output');
 await fs.mkdir(finalDir,{recursive:true});
 const finalStaged=path.join(finalDir,`final-${Date.now()}.pptx`);
 await finalizePresentation({workspaceDir:path.resolve(REPO,'..'),candidatePath:candidate,finalPath:finalStaged,pythonExecutable:RUNTIME_PYTHON,
   integrityValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_package_integrity.py'),
   layoutValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_layout_geometry.py'),
   layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-bullet-geometry','--validate-heading-fit',...[2,3,7,12,13,15,16,17].flatMap(number=>['--require-native-table-slide',String(number)])],
   explicitTotalSlideCount:18,requiredNativeTableOwnerSlides:[2,3,7,12,13,15,16,17],requiredNativeChartOwnerSlides:[5,7,10],
   materializeLiteralChartWorkbooks:true,fontPolicy:{basis:'design',families:[FONT]},verifyArtifactToolImport:true,
   receiptPath:path.join(BUILD,`validation-${Date.now()}.json`)});
 await fs.copyFile(finalStaged,OUTPUT);
 // Inspect pixels produced from the exact finalized file, including its native
 // workbook snapshots; do not equate a successful package check with visuals.
 const finalized=await PresentationFile.importPptx(await FileBlob.load(finalStaged));
 for(let i=0;i<finalized.slides.items.length;i++){
  const preview=await finalized.export({slide:finalized.slides.items[i],format:'png',scale:1});
  await fs.writeFile(path.join(previewDir,`slide-${String(i+1).padStart(2,'0')}.png`),new Uint8Array(await preview.arrayBuffer()));
  const layout=await finalized.slides.items[i].export({format:'layout'});
  await fs.writeFile(path.join(previewDir,`slide-${String(i+1).padStart(2,'0')}.layout.json`),await layout.text());
 }
}
process.stdout.write(JSON.stringify({mode:DRAFT?'draft':'final',slides:slides.length,candidate,output:DRAFT?null:OUTPUT,previews:previewDir,missingAssets:unresolved},null,2)+'\n');
