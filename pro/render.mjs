/** Evidence-bound Canvas rendering. No coordinates or player identities are invented. */
import {projectPoint,createCalibrationSelector} from './calibration.mjs';

const finite = value => typeof value==='number'&&Number.isFinite(value);
const PALETTE = {navy:'#081326',floor:'#112B49',white:'#F5F8FE',muted:'#94A6C0',hou:'#F04457',dal:'#438CFF',ball:'#FFAF58',accent:'#74D7EA'};
const DEFAULT_LAYERS = {players:true,paths:true,labels:true,zones:true,defenders:false,ball:true,metrics:false};
const FONT = 'Inter, "Noto Sans SC", system-ui, sans-serif';
const segmentId = frame => frame?.segmentId??frame?.cameraId??frame?.segment_id??frame?.camera_id??null;
const identity = player => `${String(player.id)}\u0000${String(player.team??'')}`;
const position = player => player&&finite(player.x)&&finite(player.y);
const reliablePosition = player => position(player)&&player.reliable!==false&&player.identityReliable!==false&&player.positionReliable!==false&&player.occluded!==true&&(!('confidence' in player)||(finite(player.confidence)&&player.confidence>=.5));
const reliableFrame = frame => frame?.reliable!==false&&frame?.identityReliable!==false&&frame?.positionReliable!==false&&frame?.occluded!==true;
const imagePosition = player => position(player)&&player.x>=0&&player.x<=1&&player.y>=0&&player.y<=1;
const physicalUnit = units => ['ft','feet'].includes(units)?'ft':['m','meters'].includes(units)?'m':null;
const feetPerUnit = units => units==='m'?1/0.3048:1;

/** x spans court width; y spans court length. Missing physical extents stay unknown. */
function courtSpace(play) {
  const tracking=play?.tracking??{},court=tracking.court??play?.court??{};
  const normalized=tracking.units==='normalized',unit=physicalUnit(normalized?court.units:tracking.units);
  if (tracking.coordinateSystem!=='court'||!unit) return null;
  const dimensionUnit=physicalUnit(court.units??unit);
  const factor=dimensionUnit?feetPerUnit(dimensionUnit)/feetPerUnit(unit):null;
  const extent=value=>finite(value)&&value>0&&factor!==null&&finite(value*factor)&&value*factor*feetPerUnit(unit)<=1000?value*factor:null;
  const width=extent(court.width),length=extent(court.length);
  if (normalized&&(width===null||length===null)) return null;
  return {unit,normalized,width,length,scaleX:normalized?width:1,scaleY:normalized?length:1};
}

function physicalTracks(list,space) {
  const transform=item=>{
    if (!position(item)||(space.normalized&&!imagePosition(item))) return null;
    const x=item.x*space.scaleX,y=item.y*space.scaleY;
    return finite(x)&&finite(y)?{...item,x,y}:null;
  };
  return list.map(frame=>({...frame,players:frame.players.map(transform).filter(Boolean),ball:transform(frame.ball)}));
}

const clockCache=new WeakMap();
function videoClock(play){
  if(play?.tracking?.timeBase!=='possession'||!finite(play.start))return play;
  const old=clockCache.get(play);if(old)return old;
  const normalized={...play,tracking:{...play.tracking,timeBase:'video'},tracks:(play.tracks||[]).map(f=>({...f,t:finite(f.t)?f.t+play.start:f.t}))};
  clockCache.set(play,normalized);return normalized;
}

function enabled(layers,key) {
  if (Array.isArray(layers)) return layers.includes(key);
  if (layers instanceof Set) return layers.has(key);
  const aliases = {paths:'arrows',defenders:'nearestDefender',labels:'tags',players:'tracking'};
  return layers?.[key]??layers?.[aliases[key]]??DEFAULT_LAYERS[key];
}

function teamColor(team) {
  const value=String(team??'').toLowerCase();
  if (/hou|rockets|火箭/.test(value)) return PALETTE.hou;
  if (/dal|mavericks|独行侠/.test(value)) return PALETTE.dal;
  return PALETTE.accent;
}

function clonePosition(item) { return reliablePosition(item)?{...item}:null; }

/** Bounded interpolation of matching identities; no extrapolation or gap filling. */
export function frameAt(list,t,maxGap=.75) {
  if (!Array.isArray(list)||!finite(t)||!finite(maxGap)||maxGap<0) return null;
  const rows=list.filter(frame=>frame&&finite(frame.t)&&Array.isArray(frame.players)).slice().sort((a,b)=>a.t-b.t);
  if (!rows.length) return null;
  for (let i=1;i<rows.length;i++) if (rows[i].t===rows[i-1].t) return null;
  const clean = frame => {
    if (!reliableFrame(frame)) return {...frame,t,players:[],ball:null,interpolated:false,sourceTimes:[frame.t]};
    const counts=new Map();
    for (const player of frame.players) if (reliablePosition(player)&&player.id!=null&&player.id!=='') counts.set(identity(player),(counts.get(identity(player))??0)+1);
    const players=frame.players.filter(player=>{
      if (!reliablePosition(player)||player.id==null||player.id==='') return false;
      return counts.get(identity(player))===1;
    }).map(player=>({...player}));
    return {...frame,t,players,ball:clonePosition(frame.ball),interpolated:false,sourceTimes:[frame.t]};
  };
  const exact=rows.find(frame=>frame.t===t);
  if (exact) return clean(exact);
  if (t<rows[0].t||t>rows.at(-1).t) return null;
  let afterIndex=rows.findIndex(frame=>frame.t>t);
  if (afterIndex<1) return null;
  const before=rows[afterIndex-1],after=rows[afterIndex];
  if (after.t-before.t>maxGap||segmentId(before)!==segmentId(after)||after.cut===true||after.cameraCut===true) return null;
  const a=clean(before),b=clean(after),ratio=(t-before.t)/(after.t-before.t);
  const right=new Map(b.players.map(player=>[identity(player),player]));
  const interpolate=(left,right)=>{
    const p={...left,x:left.x+(right.x-left.x)*ratio,y:left.y+(right.y-left.y)*ratio};
    if (finite(left.z)&&finite(right.z)) p.z=left.z+(right.z-left.z)*ratio;
    return p;
  };
  const players=a.players.filter(player=>right.has(identity(player))).map(player=>interpolate(player,right.get(identity(player))));
  const ball=a.ball&&b.ball?interpolate(a.ball,b.ball):null;
  return {t,players,ball,segmentId:segmentId(before),interpolated:true,sourceTimes:[before.t,after.t]};
}

function playContains(play,t) {
  return !!play&&finite(t)&&(!finite(play.start)||t>=play.start)&&(!finite(play.end)||t<play.end);
}

function cameraFor(play,t,requireCalibration=true) {
  const declared=play.cameraSegments??play.camera_segments??[];
  const dynamic=play.calibration?.mode==='dynamic'||Array.isArray(play.calibration?.segments);
  const segments=Array.isArray(declared)&&declared.length?declared:dynamic?play.calibration.segments:[];
  if (!Array.isArray(segments)||!segments.length) return {segment:null,valid:true,warnings:['未提供镜头分段；画面位置按输入来源显示。']};
  const active=segments.filter(segment=>finite(segment.start)&&finite(segment.end)&&segment.start<=t&&t<segment.end);
  if (active.length!==1) return {segment:null,valid:false,warnings:['当前时刻没有唯一的镜头区间，自动叠加暂停。']};
  const calibrationSegment=dynamic?play.calibration.segments?.find(segment=>String(segment.id)===String(active[0].id??active[0].segmentId)):null;
  const invalid=[];
  if (requireCalibration) {
    if (!reliableFrame(active[0])||(calibrationSegment&&!reliableFrame(calibrationSegment))) return {segment:active[0],valid:false,warnings:['当前镜头已标记为遮挡或身份不可靠，自动叠加暂停。']};
    const declaredIntervals=[active[0].invalidIntervals??[],...(calibrationSegment&&calibrationSegment!==active[0]?[calibrationSegment.invalidIntervals??[]]:[])];
    if (declaredIntervals.some(rows=>!Array.isArray(rows))) return {segment:active[0],valid:false,warnings:['镜头失效区间无效，自动叠加暂停。']};
    invalid.push(...declaredIntervals.flat());
    if (invalid.some(row=>!row||!finite(row.start)||!finite(row.end)||row.end<=row.start)) return {segment:active[0],valid:false,warnings:['镜头失效区间无效，自动叠加暂停。']};
    const blocked=invalid.find(row=>row.start<=t&&t<row.end);
    if (blocked) return {segment:active[0],valid:false,warnings:[`当前区间暂停：${blocked.reason??'遮挡或身份不可靠'}`]};
  }
  if (requireCalibration&&active[0].calibrated!==true&&!(dynamic&&active[0].reviewed===true&&active[0].calibrated!==false)) return {segment:active[0],valid:false,warnings:['当前镜头未核对，自动叠加暂停。']};
  return {segment:active[0],valid:true,warnings:[],invalidIntervals:invalid};
}

function filterSegment(list,segment,playEnd=null) {
  const frames=(Array.isArray(list)?list:[]).filter(frame=>frame&&finite(frame.t)&&Array.isArray(frame.players));
  if (!segment) return frames;
  const includeEnd=finite(playEnd)&&segment.end===playEnd;
  return frames.filter(frame=>frame.t>=segment.start&&(frame.t<segment.end||(includeEnd&&frame.t===segment.end))&&
    (segmentId(frame)===null||String(segmentId(frame))===String(segment.id??segment.segmentId)));
}

function screenedRows(list,camera) {
  const intervals=camera.invalidIntervals??[];
  if (!intervals.length) return list;
  const rows=list.slice().sort((a,b)=>a.t-b.t);
  return rows.map((frame,index)=>{
    const blocked=intervals.some(row=>row.start<=frame.t&&frame.t<row.end);
    const bridge=index>0&&intervals.some(row=>row.start<frame.t&&row.end>rows[index-1].t);
    return {...frame,...(blocked?{players:[],ball:null}:{}),...(bridge?{cut:true}:{})};
  });
}

function courtToScreen(play,t,camera) {
  const calibration=play.calibration;
  const selectedId=camera.segment?.id??camera.segment?.segmentId;
  const selectCalibration=createCalibrationSelector(calibration);
  const checked=selectCalibration(t,{segmentId:selectedId});
  if (!checked.valid) return {list:[],source:'unavailable',warnings:[checked.reason]};
  const space=courtSpace(play);
  if (!space) return {list:[],source:'unavailable',warnings:['球场轨迹需要明确的物理单位；归一化坐标还须提供场地宽度与长度。']};
  // Legacy imported matrices preserve their source physical unit. The editor's
  // manual calibration has always asked for feet; new records declare it explicitly.
  const activeCalibration=calibration.segments?.find(segment=>segment.id===checked.segmentId)??calibration;
  const declaredUnit=activeCalibration.court?.units??activeCalibration.units??calibration.court?.units??calibration.units;
  const calibrationUnit=declaredUnit==null?(calibration.source==='manual'||calibration.origin==='manual'?'ft':space.unit):physicalUnit(declaredUnit);
  if (!calibrationUnit) return {list:[],source:'unavailable',warnings:['人工标定的球场物理单位无效。']};
  const scale=feetPerUnit(space.unit)/feetPerUnit(calibrationUnit);
  const matrix=checked.matrix.map((value,index)=>[0,1,3,4,6,7].includes(index)?value*scale:value);
  if (calibration.start!=null&&(t<calibration.start||t>=calibration.end)) return {list:[],source:'unavailable',warnings:['当前时刻超出人工标定范围。']};
  const wanted=checked.segmentId??calibration.segmentId??calibration.cameraId;
  if (wanted!=null&&(!camera.segment||String(wanted)!==String(camera.segment.id??camera.segment.segmentId))) {
    return {list:[],source:'unavailable',warnings:['人工标定属于另一个镜头。']};
  }
  const segments=play.cameraSegments??play.camera_segments??[];
  if (segments.length>1&&wanted==null&&calibration.start==null) return {list:[],source:'unavailable',warnings:['多镜头视频需要逐镜头人工标定。']};
  const transform=item=>{
    try { return position(item)?{...item,...projectPoint(matrix,item)}:null; } catch { return null; }
  };
  const courtList=screenedRows(physicalTracks(filterSegment(play.tracks,camera.segment,play.end),space).map(frame=>{
    const at=selectCalibration(frame.t,{segmentId:selectedId});
    // Preserve empty rows to break trails and interpolation across failed intervals.
    const finalSupport=frame.t===play.end&&frame.t===(activeCalibration.end??calibration.end);
    return (at.valid||finalSupport)&&reliableFrame(frame)?frame:{...frame,players:[],ball:null};
  }),{invalidIntervals:[...(camera.invalidIntervals??[]),...(activeCalibration.invalidIntervals??[])]});
  const list=courtList.map(frame=>({...frame,
    players:frame.players.map(transform).filter(Boolean),ball:null}));
  const warnings=[...(checked.warnings??[])];
  if ((play.tracks??[]).some(frame=>frame.ball)) warnings.push('平面标定不恢复空中球的位置，视频球图层未绘制。');
  return {list,courtList,matrix,calibrationSelection:checked,source:'calibrated-court',warnings};
}

function screenSource(play,t) {
  const camera=cameraFor(play,t);
  if (!camera.valid) return {list:[],source:'unavailable',warnings:camera.warnings,segment:camera.segment};
  if (Array.isArray(play.screenTracks)&&play.screenTracks.length) {
    return {list:screenedRows(filterSegment(play.screenTracks,camera.segment,play.end),camera),source:'screen-tracks',warnings:camera.warnings,segment:camera.segment};
  }
  if (Array.isArray(play.tracks)&&play.tracks.length) {
    if (play.tracking?.coordinateSystem!=='court') return {list:[],source:'unavailable',warnings:['轨迹坐标系未定义为球场坐标，不能投影到视频。'],segment:camera.segment};
    return {...courtToScreen(play,t,camera),segment:camera.segment};
  }
  return {list:[],source:'unavailable',warnings:['未提供画面轨迹；不会生成球员位置。'],segment:camera.segment};
}

function focused(player,focus) {
  if (focus==null||focus==='') return false;
  if (typeof focus==='object') return [player.id,player.name,player.player].some(value=>value!=null&&String(value)===String(focus.id))&&
    (focus.team==null||String(player.team).toLowerCase()===String(focus.team).toLowerCase());
  return [player.id,player.name,player.player].some(value=>value!=null&&String(value)===String(focus));
}

function focusFor(play,requested) {
  if (requested&&typeof requested==='object') return requested;
  const target=requested??play?.player;
  if (target==null||target==='') return null;
  return play?.team!=null&&play.team!==''?{id:target,team:play.team}:target;
}

function canvasPoint(p,width,height) { return {x:p.x*width,y:p.y*height}; }

function roundedBox(ctx,x,y,width,height,radius=8) {
  if (typeof ctx.roundRect==='function') ctx.roundRect(x,y,width,height,radius);
  else ctx.rect(x,y,width,height);
}

function drawTag(ctx,label,p,width,height,style={}) {
  const scale=Math.max(.65,Math.min(1.5,width/1200)),fontSize=Math.round((style.small?11:13)*scale);
  const text=String(label??'').slice(0,60);
  if (!text) return;
  ctx.font=`600 ${fontSize}px ${FONT}`;
  const textWidth=ctx.measureText(text).width,boxWidth=Math.min(textWidth+18*scale,width-8),boxHeight=26*scale;
  const x=Math.max(4,Math.min(width-boxWidth-4,p.x-boxWidth/2));
  const y=Math.max(4,Math.min(height-boxHeight-4,p.y-36*scale));
  ctx.beginPath();roundedBox(ctx,x,y,boxWidth,boxHeight,5*scale);
  ctx.fillStyle='rgba(8,19,38,.91)';ctx.fill();ctx.strokeStyle=style.color??'rgba(175,200,239,.38)';ctx.lineWidth=1;ctx.stroke();
  ctx.fillStyle=PALETTE.white;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,x+boxWidth/2,y+boxHeight/2,boxWidth-8);
}

function line(ctx,points,color,width=2,alpha=1) {
  if (points.length<2) return;
  ctx.save();ctx.globalAlpha=alpha;ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.lineCap='round';
  ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();ctx.restore();
}

function arrow(ctx,points,color,width=3) {
  line(ctx,points,color,width);
  const p=points.at(-1),q=points.at(-2);
  if (!p||!q||Math.hypot(p.x-q.x,p.y-q.y)<2) return;
  const angle=Math.atan2(p.y-q.y,p.x-q.x),size=Math.max(9,width*3.5);
  ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(p.x,p.y);
  ctx.lineTo(p.x-size*Math.cos(angle-.45),p.y-size*Math.sin(angle-.45));
  ctx.lineTo(p.x-size*Math.cos(angle+.45),p.y-size*Math.sin(angle+.45));ctx.closePath();ctx.fill();
}

function annotationPoints(annotation) {
  const raw=annotation.points??(finite(annotation.x)&&finite(annotation.y)?[{x:annotation.x,y:annotation.y}]:[]);
  if (!Array.isArray(raw)) return [];
  const points=raw.map(p=>Array.isArray(p)?{x:p[0],y:p[1]}:p);
  return points.length&&points.every(imagePosition)?points.map(p=>({x:p.x,y:p.y})):[];
}

function annotationActive(annotation,t) {
  const start=annotation.start??annotation.startTime,end=annotation.end??annotation.endTime;
  return finite(start)&&finite(end)&&start<=t&&t<end&&end>start;
}

function drawAnnotations(ctx,play,t,options,summary,hasAutomaticFrame) {
  const {width,height,layers}=options;
  const annotations=options.annotations??play.annotations??[];
  if (!Array.isArray(annotations)) return;
  for (const annotation of annotations.slice(0,100)) {
    if (!annotation||typeof annotation!=='object') continue;
    if (!annotationActive(annotation,t)) continue;
    const manual=annotation.origin==='manual'||annotation.source==='manual';
    if (!manual&&!hasAutomaticFrame) continue;
    const points=annotationPoints(annotation),kind=annotation.kind==='text'?'tag':annotation.kind;
    if (!points.length) continue;
    const mapped=points.map(p=>canvasPoint(p,width,height));
    const color=manual?PALETTE.accent:PALETTE.ball;
    if (kind==='arrow'&&points.length>=2&&enabled(layers,'paths')) arrow(ctx,mapped,color,Math.max(2,width/430));
    else if (kind==='zone'&&points.length>=2&&enabled(layers,'zones')) {
      const polygon=mapped.length===2?[mapped[0],{x:mapped[1].x,y:mapped[0].y},mapped[1],{x:mapped[0].x,y:mapped[1].y}]:mapped;
      ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();
      ctx.fillStyle=manual?'rgba(116,215,234,.14)':'rgba(255,175,88,.16)';ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle=color;ctx.stroke();
    } else if (!(kind==='tag'&&enabled(layers,'labels'))) continue;
    if (enabled(layers,'labels')&&(annotation.label||annotation.text)) drawTag(ctx,annotation.label??annotation.text,mapped[0],width,height,{color});
    summary.drawn.push({kind,id:annotation.id??null,label:String(annotation.label??annotation.text??''),points,
      source:manual?'manual-image-annotation':'supplied-image-annotation'});
  }
}

function histories(list,t,players,maxGap=.75,currentOverride=null) {
  const rows=list.filter(frame=>frame.t>=t-2&&frame.t<=t).slice().sort((a,b)=>a.t-b.t);
  const current=currentOverride??frameAt(list,t,maxGap);
  if (current&&!rows.some(frame=>frame.t===t)) rows.push(current);
  return players.map(player=>{
    const segments=[];let path=[],lastTime=null,lastSegment=null;
    for (const frame of rows) {
      const p=reliableFrame(frame)?frame.players.find(candidate=>reliablePosition(candidate)&&candidate.id!=null&&identity(candidate)===identity(player)):null;
      if (!position(p)||(lastTime!==null&&(frame.t-lastTime>maxGap||segmentId(frame)!==lastSegment||frame.cut===true||frame.cameraCut===true))) {if(path.length>1)segments.push(path);path=[];}
      if (position(p)) {path.push({...p,t:frame.t});lastTime=frame.t;lastSegment=segmentId(frame);} else {lastTime=null;lastSegment=null;}
    }
    if (path.length>1) segments.push(path);
    return {player,segments};
  });
}

function marker(ctx,player,p,selected,width,showName=true) {
  const scale=Math.max(.65,Math.min(1.5,width/1000)),color=teamColor(player.team),radius=(selected?12:8)*scale;
  ctx.save();
  if (selected) {ctx.beginPath();ctx.ellipse(p.x,p.y+radius*.5,radius*1.9,radius*.7,0,0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();}
  ctx.beginPath();ctx.arc(p.x,p.y,radius,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
  ctx.strokeStyle=selected?PALETTE.white:'rgba(255,255,255,.72)';ctx.lineWidth=selected?2.3:1.2;ctx.stroke();
  ctx.font=`700 ${Math.round(9*scale)}px ${FONT}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=PALETTE.white;
  ctx.fillText(String(player.jerseyNumber??player.number??player.id).slice(0,4),p.x,p.y,radius*1.6);
  ctx.restore();
  if (showName) drawTag(ctx,player.name??player.id,p,width,width*2,{color,small:!selected});
}

function summaryAt(t) {return {time:t,status:'empty',source:'unavailable',drawn:[],players:[],playerCount:0,warnings:[]};}

function sourceFrame(source,t,maxGap) {
  if (!source.courtList) return frameAt(source.list,t,maxGap);
  // Linear motion is interpolated in court units before nonlinear perspective projection.
  const frame=frameAt(source.courtList,t,maxGap);
  if (!frame) return null;
  const players=frame.players.map(player=>{
    try { return {...player,...projectPoint(source.matrix,player)}; } catch { return null; }
  }).filter(Boolean);
  return {...frame,players,ball:null};
}

function nearestRelation(play,t,players,owner,width,height) {
  const space=courtSpace(play);
  if (space) {
    const camera=cameraFor(play,t,false);
    const list=camera.valid?physicalTracks(filterSegment(play.tracks,camera.segment,play.end),space):[];
    const frame=frameAt(list,t,play.tracking?.maxGap??.75);
    const courtOwner=frame?.players.find(player=>identity(player)===identity(owner));
    if (courtOwner) {
      const shown=new Map(players.map(player=>[identity(player),player]));
      const opponents=frame.players.filter(player=>player.team!=null&&String(player.team)!==String(courtOwner.team)&&shown.has(identity(player)));
      const nearest=opponents.sort((a,b)=>Math.hypot(a.x-courtOwner.x,a.y-courtOwner.y)-Math.hypot(b.x-courtOwner.x,b.y-courtOwner.y))[0];
      if (nearest) return {player:shown.get(identity(nearest)),kind:'nearest-court-defender',distance:Math.hypot(nearest.x-courtOwner.x,nearest.y-courtOwner.y),unit:space.unit,
        source:play.tracking.kind==='schematic'?'schematic-court':'supplied-court',label:'来源球场坐标的最近防守者，不判断防守责任'};
    }
  }
  const opponents=players.filter(player=>player.team!=null&&String(player.team)!==String(owner.team));
  const nearest=opponents.sort((a,b)=>Math.hypot((a.x-owner.x)*width,(a.y-owner.y)*height)-Math.hypot((b.x-owner.x)*width,(b.y-owner.y)*height))[0];
  return nearest?{player:nearest,kind:'nearest-image-defender',source:'screen-tracks',label:'画面最近防守者；不是球场距离或防守责任判断'}:null;
}

/** Draw onto an overlay or an already painted video frame; deliberately never clears. */
export function renderOverlay(ctx,play,t,options={}) {
  play=videoClock(play);
  const width=options.width??ctx?.canvas?.width,height=options.height??ctx?.canvas?.height;
  const summary=summaryAt(t);
  if (!ctx||!finite(width)||!finite(height)||width<=0||height<=0) {summary.warnings=['画面尺寸无效。'];return summary;}
  if (!playContains(play,t)) {summary.status='outside-play';return summary;}
  const source=screenSource(play,t),frame=sourceFrame(source,t,play.tracking?.maxGap??.75);
  summary.source=source.source;summary.warnings=[...source.warnings];
  if (source.calibrationSelection) summary.calibration={segmentId:source.calibrationSelection.segmentId,keyframeIds:source.calibrationSelection.keyframeIds,interpolated:source.calibrationSelection.interpolated,error:source.calibrationSelection.error};
  const players=(frame?.players??[]).filter(imagePosition),focus=focusFor(play,options.focusPlayer);
  ctx.save();ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();
  if (frame&&players.length) {
    if (enabled(options.layers,'paths')) for (const history of histories(source.list,t,players,play.tracking?.maxGap??.75,frame)) {
      const selected=focused(history.player,focus);
      if (!selected&&focus) continue;
      for (const path of history.segments) {
        if (!path.every(imagePosition)) continue;
        const mapped=path.map(p=>canvasPoint(p,width,height));
        line(ctx,mapped,teamColor(history.player.team),selected?Math.max(3,width/300):2,.30);
        arrow(ctx,mapped,teamColor(history.player.team),selected?Math.max(2,width/500):1.5);
        summary.drawn.push({kind:'trail',id:history.player.id,team:history.player.team,points:path.map(p=>({x:p.x,y:p.y,t:p.t})),source:source.source});
      }
    }
    if (enabled(options.layers,'players')) for (const player of players) {
      const selected=focused(player,focus),p=canvasPoint(player,width,height);
      marker(ctx,player,p,selected,width,false);
      if (enabled(options.layers,'labels')) drawTag(ctx,player.name??player.id,p,width,height,{color:teamColor(player.team),small:!selected});
      const record={kind:'player',id:player.id,team:player.team??null,label:String(player.name??player.id),point:{x:player.x,y:player.y},focus:selected,source:source.source};
      summary.players.push(record);summary.drawn.push(record);
    }
    const owner=players.find(player=>focused(player,focus));
    if (owner&&owner.team!=null&&enabled(options.layers,'defenders')) {
      const relation=nearestRelation(play,t,players,owner,width,height);
      if (relation) {
        const nearest=relation.player,points=[owner,nearest].map(p=>canvasPoint(p,width,height));
        ctx.save();ctx.setLineDash([5,5]);line(ctx,points,PALETTE.white,1.5,.7);ctx.restore();
        const {player:unused,...record}=relation;
        summary.drawn.push({...record,id:nearest.id,team:nearest.team,from:owner.id,fromTeam:owner.team,points:[{x:owner.x,y:owner.y},{x:nearest.x,y:nearest.y}]});
        if (enabled(options.layers,'labels')) drawTag(ctx,finite(relation.distance)?`${relation.distance.toFixed(1)} ${relation.unit} · 输入距离`:'画面邻近',
          {x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2+42},width,height,{small:true,color:PALETTE.muted});
      }
    }
    if (enabled(options.layers,'ball')&&imagePosition(frame.ball)) {
      const p=canvasPoint(frame.ball,width,height);ctx.beginPath();ctx.arc(p.x,p.y,Math.max(3,width/240),0,Math.PI*2);ctx.fillStyle=PALETTE.ball;ctx.fill();
      ctx.strokeStyle=PALETTE.white;ctx.lineWidth=1;ctx.stroke();
      summary.drawn.push({kind:'ball',point:{x:frame.ball.x,y:frame.ball.y},source:source.source});
    }
  }
  drawAnnotations(ctx,play,t,{...options,width,height},summary,!!frame&&players.length>0);
  const metric=play.metrics?.xfg_pct,available=metric?.availableAt??metric?.time??metric?.t??play.end;
  if (enabled(options.layers,'metrics')&&metric?.semantics==='shot_make_probability'&&finite(metric.value)&&metric.value>=0&&metric.value<=1&&finite(available)&&t>=available) {
    drawTag(ctx,`${options.audience==='analyst'?'xFG':'预期命中'} ${(metric.value*100).toFixed(1)}%`,{x:width-110,y:64},width,height,{color:PALETTE.accent});
    summary.drawn.push({kind:'metric',key:'xfg_pct',value:metric.value,source:'supplied-metric'});
  }
  if (options.revealOutcome===true&&finite(play.resultTime)&&t>=play.resultTime&&['made','missed'].includes(play.outcome)) {
    drawTag(ctx,play.outcome==='made'?'本次出手命中':'本次出手未中',{x:width/2,y:height-16},width,height,{color:PALETTE.white});
    summary.drawn.push({kind:'outcome',value:play.outcome,source:'supplied-event'});
  }
  ctx.restore();summary.playerCount=summary.players.length;
  summary.status=summary.playerCount?'ready':summary.drawn.some(item=>item.source==='manual-image-annotation')?'manual-only':'tracking-unavailable';
  if (!frame&&source.list.length) summary.warnings.push('此时刻没有可内插的连续轨迹样本。');
  if (frame&&!players.length&&source.list.length) summary.warnings.push('此时刻的位置或身份未通过可靠度检查；遮挡、失效或缺失身份不会补点。');
  summary.warnings=[...new Set(summary.warnings)];return summary;
}

function courtGeometry(play,width,height) {
  const space=courtSpace(play);
  if (!space||space.width===null||space.length===null) return null;
  const {length,width:courtWidth}=space,unitFactor=space.unit==='m'?0.3048:1;
  const top=height*.08,bottom=height*.91,cx=width/2;
  const project=p=>{
    const depth=1-p.y/length,halfWidth=width*(.335+.135*depth);
    return {x:cx+(p.x/courtWidth-.5)*halfWidth*2,y:top+(bottom-top)*depth};
  };
  return {length,width:courtWidth,unitFactor,project,full:length/courtWidth>1.5,space};
}

function curve(ctx,geometry,center,radius,from=0,to=Math.PI*2,color='rgba(188,208,231,.48)',width=1.3) {
  const points=Array.from({length:65},(_,i)=>{const angle=from+(to-from)*i/64;return geometry.project({x:center.x+radius*Math.cos(angle),y:center.y+radius*Math.sin(angle)});});
  line(ctx,points,color,width);
}

function courtLines(ctx,g) {
  const {width,length,unitFactor:u,project}=g,cx=width/2;
  const stroke=(points,color='rgba(188,208,231,.48)',thickness=1.25)=>line(ctx,points.map(project),color,thickness);
  stroke([{x:0,y:0},{x:width,y:0},{x:width,y:length},{x:0,y:length},{x:0,y:0}],'rgba(213,227,247,.7)',1.6);
  const end=top=>{
    const baseline=top?length:0,sign=top?-1:1,hoop={x:cx,y:baseline+sign*5.25*u};
    const corners=[{x:cx-8*u,y:baseline},{x:cx-8*u,y:baseline+sign*19*u},{x:cx+8*u,y:baseline+sign*19*u},{x:cx+8*u,y:baseline}];
    const polygon=corners.map(project);ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle='rgba(57,86,129,.12)';ctx.fill();stroke(corners);
    curve(ctx,g,{x:cx,y:baseline+sign*19*u},6*u);
    const radius=23.75*u,theta=Math.acos(Math.min(1,22*u/radius));
    const points=Array.from({length:65},(_,i)=>{const angle=theta+(Math.PI-2*theta)*i/64;return {x:cx+radius*Math.cos(angle),y:hoop.y+sign*radius*Math.sin(angle)};});
    stroke([{x:cx+22*u,y:baseline},points[0]]);stroke(points);stroke([points.at(-1),{x:cx-22*u,y:baseline}]);
    curve(ctx,g,hoop,4*u,top?Math.PI:0,top?Math.PI*2:Math.PI,'rgba(188,208,231,.3)');
    stroke([{x:cx-3*u,y:baseline+sign*4*u},{x:cx+3*u,y:baseline+sign*4*u}],'rgba(245,248,254,.9)',2);
    curve(ctx,g,hoop,.75*u,0,Math.PI*2,'#FFAD68',2);
  };
  end(true);
  if (g.full) {end(false);stroke([{x:0,y:length/2},{x:width,y:length/2}]);curve(ctx,g,{x:cx,y:length/2},6*u);}
  else curve(ctx,g,{x:cx,y:0},6*u,0,Math.PI);
}

/** Independent court view; the shallow perspective is presentation, not camera reconstruction. */
export function drawCourt(ctx,play,t,options={}) {
  play=videoClock(play);
  const width=options.width??ctx?.canvas?.width,height=options.height??ctx?.canvas?.height,summary=summaryAt(t);
  if (!ctx||!finite(width)||!finite(height)||width<=0||height<=0) {summary.warnings=['球场视图尺寸无效。'];return summary;}
  ctx.save();ctx.clearRect(0,0,width,height);ctx.fillStyle=PALETTE.navy;ctx.fillRect(0,0,width,height);
  const g=courtGeometry(play??{},width,height);
  if (!g) {ctx.restore();summary.status=playContains(play,t)?'tracking-unavailable':'outside-play';summary.warnings=['球场视图需要明确的物理单位与场地宽度、长度；不猜测缺失尺寸。'];return summary;}
  const outline=[{x:0,y:0},{x:g.width,y:0},{x:g.width,y:g.length},{x:0,y:g.length}].map(g.project);
  const fill=typeof ctx.createLinearGradient==='function'?ctx.createLinearGradient(0,height*.08,0,height*.92):null;
  if (fill) {fill.addColorStop(0,'#142A46');fill.addColorStop(1,'#0D203A');}
  ctx.beginPath();outline.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle=fill??PALETTE.floor;ctx.fill();courtLines(ctx,g);
  const known=playContains(play,t);
  const camera=cameraFor(play??{},t,false),list=camera.valid?physicalTracks(filterSegment(play?.tracks,camera.segment,play?.end),g.space):[];
  const frame=known?frameAt(list,t,play.tracking?.maxGap??.75):null;
  const players=(frame?.players??[]).filter(p=>position(p)&&p.x>=0&&p.x<=g.width&&p.y>=0&&p.y<=g.length);
  const focus=focusFor(play,options.focusPlayer),source=play?.tracking?.kind==='schematic'?'schematic-court':'supplied-court';
  if (frame&&players.length) {
    if (enabled(options.layers,'paths')) for (const history of histories(list,t,players,play.tracking?.maxGap??.75)) {
      const selected=focused(history.player,focus); if (focus&&!selected) continue;
      for (const path of history.segments) {
        if (path.some(p=>p.x<0||p.x>g.width||p.y<0||p.y>g.length)) continue;
        line(ctx,path.map(g.project),teamColor(history.player.team),selected?3:1.5,.65);
        summary.drawn.push({kind:'court-trail',id:history.player.id,points:path.map(p=>({x:p.x,y:p.y,t:p.t})),source});
      }
    }
    const owner=players.find(p=>focused(p,focus));
    if (owner&&owner.team!=null&&enabled(options.layers,'defenders')) {
      const nearest=players.filter(p=>p.team!=null&&String(p.team)!==String(owner.team)).sort((a,b)=>Math.hypot(a.x-owner.x,a.y-owner.y)-Math.hypot(b.x-owner.x,b.y-owner.y))[0];
      if (nearest) {ctx.save();ctx.setLineDash([4,5]);line(ctx,[owner,nearest].map(g.project),PALETTE.white,1.2,.55);ctx.restore();
        summary.drawn.push({kind:'nearest-court-defender',from:owner.id,fromTeam:owner.team,id:nearest.id,team:nearest.team,distance:Math.hypot(nearest.x-owner.x,nearest.y-owner.y),unit:g.space.unit,source});}
    }
    if (enabled(options.layers,'players')) for (const player of players) {
      const p=g.project(player),selected=focused(player,focus);marker(ctx,player,p,selected,width,false);
      if (enabled(options.layers,'labels')) drawTag(ctx,player.name??player.id,p,width,height,{color:teamColor(player.team),small:!selected});
      const record={kind:'court-player',id:player.id,team:player.team??null,label:String(player.name??player.id),point:{x:player.x,y:player.y},screenPoint:p,focus:selected,source};
      summary.players.push(record);summary.drawn.push(record);
    }
    if (enabled(options.layers,'ball')&&position(frame.ball)&&frame.ball.x>=0&&frame.ball.x<=g.width&&frame.ball.y>=0&&frame.ball.y<=g.length) {
      const p=g.project(frame.ball);ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fillStyle=PALETTE.ball;ctx.fill();
      summary.drawn.push({kind:'court-ball',point:{x:frame.ball.x,y:frame.ball.y},source,label:'球的平面位置，不显示高度'});
    }
  }
  const label=source==='schematic-court'?'球场示意 · 非 NBA 测量坐标':players.length?'来源球场坐标 · 平面视图':'暂无可用球场轨迹';
  ctx.font=`500 ${Math.max(10,Math.min(12,width/42))}px ${FONT}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=PALETTE.muted;ctx.fillText(label,width/2,height*.97,width-24);
  ctx.restore();summary.source=players.length?source:'unavailable';summary.playerCount=summary.players.length;
  summary.status=players.length?'ready':playContains(play,t)?'tracking-unavailable':'outside-play';
  if (!known) summary.warnings.push('球场视图需要已声明单位的球场坐标；不从画面位置猜测。');
  if (!camera.valid) summary.warnings.push(...camera.warnings);
  if (known&&!frame) summary.warnings.push('当前时刻没有连续可用球场采样。');
  return summary;
}
