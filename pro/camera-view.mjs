/** Local camera/StoryPlan presentation view shared by browser and native export. */
import {calibrationAt} from './calibration.mjs';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const dynamic=value=>value?.mode==='dynamic'||Array.isArray(value?.segments);
const sceneId=scene=>scene?.id??scene?.segmentId??scene?.cameraId??null;
const active=(row,t)=>finite(row?.start)&&finite(row?.end)&&row.start<=t&&t<row.end;
const scope=(calibration,t)=>dynamic(calibration)?calibration.segments?.find(row=>active(row,t)):calibration;
const manualArrow=annotation=>annotation?.kind==='arrow'&&(annotation.origin==='manual'||annotation.source==='manual');

function failedView(play,calibration,reason) {
  // Preserve the operator's stored object; only this presentation view is gated.
  const gated={...calibration,reviewed:false,calibrated:false,source:reason};
  if (dynamic(calibration)) gated.segments=(calibration.segments??[]).map(row=>({...row,reviewed:false,calibrated:false}));
  return {...play,calibration:gated};
}

/**
 * Resolve one local calibration without mutating imported geometry or scene IDs.
 * A reviewed local mapping may enable its matching scene for presentation only.
 * Ambiguous selection, cut-spanning scope and wrong scene IDs fail closed.
 */
export function playAt(project,play,t) {
  if (!play||!finite(t)) return play;
  const local=(Array.isArray(project?.calibrations)?project.calibrations:[])
    .filter(row=>row?.playId===play.id&&(dynamic(row)?row.segments?.some(segment=>active(segment,t)):active(row,t)));
  if (local.length>1) return failedView(play,local[0],'当前时刻存在多个项目标定，须消除重叠后才能叠加。');
  const calibration=local[0]??play.calibration;
  if (!calibration) return play;
  const scenes=play.cameraSegments??play.camera_segments??[];
  if (!Array.isArray(scenes)) return failedView(play,calibration,'镜头分段结构无效。');
  const selectedScenes=scenes.filter(scene=>active(scene,t));
  if (scenes.length&&selectedScenes.length!==1) return failedView(play,calibration,'当前时刻没有唯一的来源镜头。');
  const scene=selectedScenes[0],selected=calibrationAt(calibration,t,{segmentId:sceneId(scene)});
  if (!selected.valid) return calibration===play.calibration?play:{...play,calibration};
  if (scene) {
    const declaredScope=scope(calibration,t);
    if (!declaredScope||declaredScope.start<scene.start||declaredScope.end>scene.end) {
      return failedView(play,calibration,'本地标定跨越来源切镜边界；须按每个镜头分别标定。');
    }
    // A dynamic camera always has an explicit scene ID; never relabel official
    // track samples or camera IDs to make an incompatible mapping look usable.
    if (dynamic(calibration)&&String(selected.segmentId)!==String(sceneId(scene))) {
      return failedView(play,calibration,'动态标定与来源镜头 ID 不一致。');
    }
  }
  const enabledScenes=scenes.map(row=>row===scene?{...row,calibrated:true}:row);
  return {...play,calibration,...(scenes.length?{cameraSegments:enabledScenes}:{})};
}

/**
 * Reviewed plan arrows are the final editable authority for custom arrow geometry.
 * Source manual arrows are omitted even after deletion; other annotations survive.
 * Called only after StoryPlan verification by the exporter; this is not a reviewer.
 */
export function storyFrameAt(project,play,t,plan) {
  const view=playAt(project,play,t);
  if (!view) return {play:view,arrows:[]};
  const annotations=(Array.isArray(view.annotations)?view.annotations:[]).filter(row=>!manualArrow(row));
  const arrows=plan?.layers?.paths===false?[]:(Array.isArray(plan?.arrows)?plan.arrows:[])
    .filter(row=>row?.playId===view.id&&active(row,t));
  return {play:{...view,annotations},arrows};
}

/** The same reviewed screen geometry and style in browser and native output. */
export function drawStoryArrows(ctx,arrows,width,height) {
  for(const arrow of arrows){const pts=arrow.points.map(p=>({x:p.x*width,y:p.y*height}));ctx.save();ctx.strokeStyle=arrow.color??'#FFB454';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=Math.max(2,width/320);ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();const a=pts.at(-1),b=pts.at(-2),angle=Math.atan2(a.y-b.y,a.x-b.x),size=Math.max(8,width/90);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(a.x-size*Math.cos(angle-.45),a.y-size*Math.sin(angle-.45));ctx.lineTo(a.x-size*Math.cos(angle+.45),a.y-size*Math.sin(angle+.45));ctx.closePath();ctx.fill();ctx.restore();}
}
