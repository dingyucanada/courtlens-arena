/** Planar camera calibration and explicit, bounded video-clock mapping. */
const EPS = 1e-10;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function point(value, label = '坐标') {
  const p = Array.isArray(value) ? {x:value[0],y:value[1]} : value;
  if (!p || !finite(p.x) || !finite(p.y)) throw new Error(`${label} 必须包含有限 x、y。`);
  return {x:p.x,y:p.y};
}

function matrixValues(value) {
  const m = Array.isArray(value) && Array.isArray(value[0]) ? value.flat() : value;
  if (!Array.isArray(m) || m.length !== 9 || !m.every(finite)) throw new Error('单应性矩阵必须包含 9 个有限数字。');
  return m;
}

function multiply(a, b) {
  return Array.from({length:9},(_,index) => {
    const row = Math.floor(index / 3), col = index % 3;
    return a[row*3]*b[col] + a[row*3+1]*b[3+col] + a[row*3+2]*b[6+col];
  });
}

function determinant(m) {
  return m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);
}

function normalize(points) {
  const cx = points.reduce((sum,p)=>sum+p.x,0)/points.length;
  const cy = points.reduce((sum,p)=>sum+p.y,0)/points.length;
  const rms = Math.sqrt(points.reduce((sum,p)=>sum+(p.x-cx)**2+(p.y-cy)**2,0)/points.length);
  if (!finite(rms) || rms <= Number.EPSILON) throw new Error('标定点重合，不能确定平面变换。');
  const scale = Math.SQRT2/rms;
  return {points:points.map(p=>({x:(p.x-cx)*scale,y:(p.y-cy)*scale})),
    transform:[scale,0,-cx*scale,0,scale,-cy*scale,0,0,1],
    inverse:[1/scale,0,cx,0,1/scale,cy,0,0,1]};
}

function checkConfiguration(points) {
  for (let a=0;a<points.length;a++) for (let b=a+1;b<points.length;b++) {
    if (Math.hypot(points[a].x-points[b].x,points[a].y-points[b].y)<EPS) throw new Error('标定点重合，不能确定平面变换。');
    for (let c=b+1;c<points.length;c++) {
      const area = (points[b].x-points[a].x)*(points[c].y-points[a].y)-(points[b].y-points[a].y)*(points[c].x-points[a].x);
      if (Math.abs(area)<EPS) throw new Error('三个标定点共线或过于接近共线，请重新选择四个球场角点。');
    }
  }
}

function solveSystem(rows, values) {
  const n = values.length, a = rows.map((row,index)=>[...row,values[index]]);
  for (let col=0;col<n;col++) {
    let pivot=col;
    for (let row=col+1;row<n;row++) if (Math.abs(a[row][col])>Math.abs(a[pivot][col])) pivot=row;
    if (Math.abs(a[pivot][col])<1e-12) throw new Error('标定矩阵退化，无法得到可靠平面变换。');
    [a[pivot],a[col]]=[a[col],a[pivot]];
    const divisor=a[col][col];
    for (let j=col;j<=n;j++) a[col][j]/=divisor;
    for (let row=0;row<n;row++) {
      if (row===col) continue;
      const factor=a[row][col];
      for (let j=col;j<=n;j++) a[row][j]-=factor*a[col][j];
    }
  }
  return a.map(row=>row[n]);
}

/** Four matched points; court units are preserved, image points normally use 0–1. */
export function solveHomography(courtPoints, imagePoints) {
  if (!Array.isArray(courtPoints) || !Array.isArray(imagePoints) || courtPoints.length!==4 || imagePoints.length!==4) {
    throw new Error('人工平面标定需要四对一一对应的球场与画面坐标。');
  }
  const source=courtPoints.map(p=>point(p,'球场点')), target=imagePoints.map(p=>point(p,'画面点'));
  const s=normalize(source), d=normalize(target);
  checkConfiguration(s.points); checkConfiguration(d.points);
  const rows=[], values=[];
  s.points.forEach((p,index)=>{
    const q=d.points[index];
    rows.push([p.x,p.y,1,0,0,0,-q.x*p.x,-q.x*p.y]); values.push(q.x);
    rows.push([0,0,0,p.x,p.y,1,-q.y*p.x,-q.y*p.y]); values.push(q.y);
  });
  const normalized=[...solveSystem(rows,values),1];
  if (Math.abs(determinant(normalized))<1e-12) throw new Error('标定矩阵退化。');
  const m=multiply(multiply(d.inverse,normalized),s.transform);
  const divisor=Math.abs(m[8])>1e-12?m[8]:Math.max(...m.map(Math.abs));
  const result=m.map(value=>value/divisor);
  if (!result.every(finite)) throw new Error('标定矩阵数值不稳定。');
  for (let i=0;i<4;i++) {
    const actual=projectPoint(result,source[i]);
    if (Math.hypot(actual.x-target[i].x,actual.y-target[i].y)>1e-7*Math.max(1,Math.abs(target[i].x),Math.abs(target[i].y))) {
      throw new Error('标定点无法一致投影，请重新检查点的配对。');
    }
  }
  return result;
}

export function projectPoint(matrix, input) {
  const m=matrixValues(matrix), p=point(input);
  const denominator=m[6]*p.x+m[7]*p.y+m[8];
  const magnitude=Math.max(1,Math.abs(m[6]*p.x),Math.abs(m[7]*p.y),Math.abs(m[8]));
  if (Math.abs(denominator)<=1e-12*magnitude) throw new Error('此点位于投影无穷处，不能显示。');
  const result={x:(m[0]*p.x+m[1]*p.y+m[2])/denominator,y:(m[3]*p.x+m[4]*p.y+m[5])/denominator};
  if (!finite(result.x)||!finite(result.y)) throw new Error('投影坐标无效。');
  return result;
}

function segmentKey(value) { return value?.segmentId??value?.cameraId??value?.segment_id??null; }

/** Piecewise interpolation between verified anchors. Never guesses outside them. */
export function mapTime(source, anchors, options={}) {
  const object=source&&typeof source==='object';
  const value=object?source.source??source.sourceTime??source.time:source;
  const segment=object?segmentKey(source):null;
  if (!finite(value)||!Array.isArray(anchors)||!anchors.length) throw new Error('时间映射需要有限源时间和已核对锚点。');
  const rows=anchors.map(anchor=>({source:anchor?.source??anchor?.sourceTime??anchor?.source_time,
    video:anchor?.video??anchor?.videoTime??anchor?.video_time,segment:segmentKey(anchor)}))
    .filter(anchor=>segment===null||anchor.segment===segment).sort((a,b)=>a.source-b.source);
  if (!rows.length||rows.some(anchor=>!finite(anchor.source)||!finite(anchor.video)||anchor.video<0)) throw new Error('时间锚点包含无效数据。');
  for (let i=1;i<rows.length;i++) {
    if (rows[i].source<=rows[i-1].source) throw new Error('源时间锚点须唯一；重复比赛钟应按节次或镜头分段。');
    if (rows[i].video<=rows[i-1].video) throw new Error('锚点的视频时间须递增；倒计时请先转换为比赛经过时间。');
  }
  const exact=rows.find(anchor=>anchor.source===value);
  if (exact) return exact.video;
  if(rows.length===1&&options.singleAnchorOffset===true){const shifted=value+rows[0].video-rows[0].source;if(!finite(shifted)||shifted<0)throw new Error('固定偏移后的时间无效。');return shifted;}
  if (value<rows[0].source||value>rows.at(-1).source||rows.length<2) throw new Error('时间超出已核对锚点范围，禁止外推。');
  for (let i=1;i<rows.length;i++) if (rows[i].source>value) {
    const a=rows[i-1],b=rows[i];
    if (a.segment!==b.segment) throw new Error('不能跨镜头或比赛钟分段内插。');
    return a.video+(value-a.source)/(b.source-a.source)*(b.video-a.video);
  }
  throw new Error('没有可用时间区间。');
}

/** Validity is operator-declared planar mapping, never certification of the source. */
export function validateCalibration(calibration) {
  if (calibration?.mode==='dynamic'||Array.isArray(calibration?.segments)) return validateDynamicCalibration(calibration);
  const errors=[], warnings=[];
  let matrix=null, error=null;
  if (!calibration||typeof calibration!=='object') return {valid:false,errors:['未提供人工或来源标定。'],warnings,matrix,error};
  if (calibration.reviewed!==true&&calibration.calibrated!==true) errors.push('标定未明确核对。');
  if (calibration.reviewed===false||calibration.calibrated===false) errors.push('标定已明确标记为未核对。');
  const source=calibration.source??calibration.origin??calibration.provenance?.source;
  if (typeof source!=='string'||!source.trim()) errors.push('标定需要记录来源或人工操作说明。');
  if (calibration.start!=null||calibration.end!=null) {
    if (!finite(calibration.start)||!finite(calibration.end)||calibration.start<0||calibration.end<=calibration.start) errors.push('标定镜头起止时间无效。');
  } else warnings.push('未声明标定时间范围；渲染必须限定到单一已核对镜头。');
  try {
    matrix=calibration.matrix?matrixValues(calibration.matrix).slice():solveHomography(calibration.courtPoints,calibration.imagePoints);
    const maximum=Math.max(...matrix.map(Math.abs));
    if (maximum===0||Math.abs(determinant(matrix.map(value=>value/maximum)))<1e-15) errors.push('标定矩阵不可逆。');
    if (calibration.imagePoints) {
      for (const raw of calibration.imagePoints) {
        const p=point(raw);
        if (p.x<0||p.x>1||p.y<0||p.y>1) errors.push('画面标定点须为 0–1 归一化坐标。');
      }
    }
    const checks=calibration.checkPoints??calibration.checkpoints??[];
    if (!Array.isArray(checks)) throw new Error('独立检查点须为数组。');
    if (checks.length<2) warnings.push('尚不足两个独立检查点；四个拟合点不证明画面准确性。');
    if (checks.length) {
      const distances=checks.map(check=>{
        const expected=point(check.image??check.imagePoint), actual=projectPoint(matrix,check.court??check.courtPoint);
        return Math.hypot(actual.x-expected.x,actual.y-expected.y);
      });
      error={unit:'normalized image',count:checks.length,rms:Math.sqrt(distances.reduce((sum,d)=>sum+d*d,0)/distances.length),max:Math.max(...distances)};
      if (finite(calibration.maxError)&&error.max>calibration.maxError) errors.push('独立检查点误差超过声明阈值。');
    }
  } catch (failure) { errors.push(failure.message); }
  return {valid:errors.length===0,errors:[...new Set(errors)],warnings,matrix,error};
}

const dynamicMode = value => value?.mode==='dynamic'||Array.isArray(value?.segments);
const samePoint = (a,b) => Math.hypot(a.x-b.x,a.y-b.y)<1e-8;
const intervalContains = (interval,t) => interval.start<=t&&t<interval.end;
const intervalIntersects = (interval,a,b) => interval.start<b&&interval.end>a;
const reviewed = value => (value?.reviewed===true||value?.calibrated===true)&&value?.reviewed!==false&&value?.calibrated!==false;
const reliable = value => value?.reliable!==false&&value?.identityReliable!==false&&value?.positionReliable!==false&&value?.occluded!==true&&value?.cut!==true&&value?.cameraCut!==true;

function intervalRows(value,label,errors) {
  if (value==null) return [];
  if (!Array.isArray(value)) {errors.push(`${label}须为数组。`);return [];}
  return value.map(row=>{
    if (!row||!finite(row.start)||!finite(row.end)||row.start<0||row.end<=row.start||typeof row.reason!=='string'||!row.reason.trim()) errors.push(`${label}须包含有效 start,end 与 reason。`);
    return row;
  }).filter(row=>row&&finite(row.start)&&finite(row.end)&&row.end>row.start);
}

function prepareDynamicSegment(segment,calibration) {
  const errors=[],warnings=[],frames=[],checks=[];
  if (!segment||typeof segment!=='object') return {segment:{},errors:['镜头须为对象。'],warnings,frames,checks,spans:[],invalidIntervals:[]};
  if (typeof segment.id!=='string'||!segment.id.trim()) errors.push('动态镜头需要非空 id。');
  if (!finite(segment.start)||!finite(segment.end)||segment.start<0||segment.end<=segment.start) errors.push('动态镜头 start,end 无效。');
  if (!reviewed(segment)) errors.push('动态镜头未经明确复核。');
  if (!reliable(segment)) errors.push('动态镜头已标记为遮挡、切镜或不可靠。');
  if (typeof segment.source!=='string'||!segment.source.trim()) errors.push('动态镜头需要人工操作或来源说明。');
  const unit=segment.court?.units??segment.units??calibration.court?.units??calibration.units;
  if (!['ft','feet','m','meters'].includes(unit)) errors.push('动态标定须声明球场物理单位 ft 或 m。');
  if (segment.interpolation!=='anchors-linear') errors.push('须明确声明 anchors-linear 插值；这不是自动视觉跟踪。');
  const maxGap=segment.maxGap??calibration.maxGap??1;
  const maxError=segment.maxError??calibration.maxError??.01;
  if (!finite(maxGap)||maxGap<=0||maxGap>10) errors.push('动态标定 maxGap 须为大于 0 且不超过 10 的视频秒。');
  if (!finite(maxError)||maxError<=0||maxError>1) errors.push('动态标定 maxError 须为大于 0 且不超过 1 的归一化画面误差。');
  const invalidIntervals=intervalRows(segment.invalidIntervals,'失效区间',errors);
  if (invalidIntervals.some(row=>row.start<segment.start||row.end>segment.end)) errors.push('失效区间须位于所属镜头内部。');
  if (!Array.isArray(segment.keyframes)||!segment.keyframes.length) errors.push('动态镜头没有带视频时间的关键帧。');
  for (const frame of Array.isArray(segment.keyframes)?segment.keyframes:[]) {
    const row={input:frame,errors:[],t:frame?.t,anchors:null,matrix:null,courtPoints:null};
    if (!frame||!finite(frame.t)||frame.t<segment.start||frame.t>segment.end) row.errors.push('关键帧时间须在所属镜头范围内。');
    if (frame?.segmentId!==segment.id) row.errors.push('关键帧须显式关联所属 segmentId。');
    if (!reviewed(frame)) row.errors.push('关键帧未经明确复核。');
    if (!reliable(frame)) row.errors.push('关键帧已标记为遮挡、切镜或不可靠。');
    if (typeof frame?.source!=='string'||!frame.source.trim()) row.errors.push('关键帧需要人工操作或来源说明。');
    try {
      const rawCourt=frame?.courtPoints??segment.courtPoints??calibration.courtPoints;
      if (!Array.isArray(rawCourt)||rawCourt.length!==4) throw new Error('动态关键帧需要四个固定球场锚点，矩阵帧也须声明这些锚点。');
      row.courtPoints=rawCourt.map(p=>point(p,'球场锚点'));
      const checked=validateCalibration({...frame,courtPoints:rawCourt,checkPoints:[],checkpoints:[]});
      if (!checked.valid) row.errors.push(...checked.errors);
      row.matrix=checked.matrix;
      row.anchors=frame.matrix?row.courtPoints.map(p=>projectPoint(row.matrix,p)):frame.imagePoints.map(p=>point(p,'画面锚点'));
      // Anchors may be outside the frame when the operator supplies a matrix;
      // the physical court can extend beyond the crop during a zoom.
      if (row.anchors.length!==4) throw new Error('动态关键帧需要四个画面锚点。');
      if (row.matrix) solveHomography(row.courtPoints,row.anchors);
    } catch(failure) {row.errors.push(failure.message);}
    frames.push(row);
  }
  frames.sort((a,b)=>a.t-b.t);
  const ids=new Set();
  for (let i=0;i<frames.length;i++) {
    const id=frames[i].input?.id;
    if (typeof id!=='string'||!id.trim()||ids.has(id)) frames[i].errors.push('关键帧 id 须非空且在镜头内唯一。');
    ids.add(id);
    if (i&&frames[i].t===frames[i-1].t) {frames[i].errors.push('关键帧时间重复。');frames[i-1].errors.push('关键帧时间重复。');}
  }
  const rawChecks=segment.checkpoints??segment.checkPoints??[];
  if (!Array.isArray(rawChecks)) errors.push('独立检查点须为数组。');
  const checkIds=new Set();
  for (const check of Array.isArray(rawChecks)?rawChecks:[]) {
    const row={input:check,id:check?.id,t:check?.t,court:null,image:null,errors:[],residual:null};
    if (typeof check?.id!=='string'||!check.id.trim()||checkIds.has(check.id)) row.errors.push('独立检查点 id 须非空且唯一。');
    checkIds.add(check?.id);
    if (!finite(check?.t)||check.t<segment.start||check.t>segment.end) row.errors.push('独立检查点须有所属镜头的视频时间。');
    if (check?.independent!==true) row.errors.push('检查点须声明 independent:true，不能把拟合点当精度证据。');
    if (typeof check?.source!=='string'||!check.source.trim()) row.errors.push('独立检查点需要来源或人工观察说明。');
    if (!reliable(check)) row.errors.push('独立检查点被标记为不可靠。');
    try {
      row.court=point(check.court??check.courtPoint,'独立球场点');row.image=point(check.image??check.imagePoint,'独立画面点');
      if (row.image.x<0||row.image.x>1||row.image.y<0||row.image.y>1) row.errors.push('独立画面检查点须在 0–1 范围内。');
      if (frames.some(frame=>frame.courtPoints?.some(p=>samePoint(p,row.court)))) row.errors.push('检查点与四个拟合球场锚点重合，不是独立点。');
    } catch(failure) {row.errors.push(failure.message);}
    checks.push(row);
  }
  const prepared={segment,errors,warnings,frames,checks,spans:[],invalidIntervals,maxGap,maxError};
  for (const check of checks) {
    if (check.errors.length) continue;
    const selection=selectRaw(prepared,check.t);
    if (!selection.valid) {check.errors.push(`检查点所在时刻没有可用映射：${selection.reason}`);continue;}
    try {
      const actual=projectPoint(selection.matrix,check.court);
      check.predicted=actual;check.residual=Math.hypot(actual.x-check.image.x,actual.y-check.image.y);
      if (check.residual>maxError) check.errors.push('独立检查点实测误差超过 maxError。');
    } catch(failure) {check.errors.push(failure.message);}
  }
  for (let i=1;i<frames.length;i++) {
    const a=frames[i-1],b=frames[i],sample=selectRaw(prepared,(a.t+b.t)/2);
    const local=checks.filter(check=>check.t>=a.t&&check.t<=b.t);
    const distinct=[];
    for (const check of local) if (check.court&&!distinct.some(p=>samePoint(p,check.court))) distinct.push(check.court);
    const reasons=[...(!sample.valid?[sample.reason]:[]),...local.flatMap(check=>check.errors)];
    if (distinct.length<2) reasons.push('此插值区间不足两个不同的独立球场检查点。');
    if (local.filter(check=>check.residual!==null&&!check.errors.length).length<2) reasons.push('此插值区间不足两个合格的独立误差检查。');
    prepared.spans.push({start:a.t,end:b.t,keyframeIds:[a.input?.id,b.input?.id],valid:reasons.length===0,reasons:[...new Set(reasons)],error:residualSummary(local),checkpointIds:local.map(check=>check.id)});
  }
  if (frames.length<2) warnings.push('单关键帧只能用于已检查的精确时刻；不会扩展为整个镜头。');
  if (frames[0]?.t>segment.start||frames.at(-1)?.t<segment.end) warnings.push('镜头边缘没有关键帧支持的区间将隐藏投影，禁止外推。');
  return prepared;
}

function residualSummary(checks) {
  const values=checks.filter(row=>finite(row.residual)).map(row=>row.residual);
  return values.length?{unit:'normalized image',count:values.length,rms:Math.sqrt(values.reduce((sum,d)=>sum+d*d,0)/values.length),max:Math.max(...values)}:null;
}

/** Select geometry only; independent checkpoint gates are applied afterwards. */
function selectRaw(prepared,t) {
  const fail=reason=>({valid:false,matrix:null,reason});
  if (prepared.errors.length) return fail(prepared.errors.join(' '));
  if (!finite(t)||t<prepared.segment.start||t>prepared.segment.end) return fail('当前时刻不属于这个镜头。');
  const blocked=prepared.invalidIntervals.find(row=>intervalContains(row,t));
  if (blocked) return fail(`当前区间暂停：${blocked.reason}`);
  const exact=prepared.frames.filter(frame=>frame.t===t);
  if (exact.length) return exact.length===1&&!exact[0].errors.length?{valid:true,matrix:exact[0].matrix,keyframeIds:[exact[0].input.id],interpolated:false}:fail(exact.flatMap(row=>row.errors).join(' '));
  const index=prepared.frames.findIndex(frame=>frame.t>t);
  if (index<1) return fail('超出动态关键帧范围，禁止外推。');
  const a=prepared.frames[index-1],b=prepared.frames[index];
  if (a.errors.length||b.errors.length) return fail([...a.errors,...b.errors].join(' '));
  if (b.t-a.t>prepared.maxGap) return fail('关键帧间隔超过 maxGap，暂停未检查的运动区间。');
  if (prepared.invalidIntervals.some(row=>intervalIntersects(row,a.t,b.t))) return fail('关键帧之间存在失效区间，禁止跨遮挡、身份失效或切镜插值。');
  if (!a.courtPoints.every((p,i)=>samePoint(p,b.courtPoints[i]))) return fail('相邻关键帧没有保持同序的固定球场锚点。');
  const ratio=(t-a.t)/(b.t-a.t);
  try {
    const anchors=a.anchors.map((p,i)=>({x:p.x+(b.anchors[i].x-p.x)*ratio,y:p.y+(b.anchors[i].y-p.y)*ratio}));
    const matrix=solveHomography(a.courtPoints,anchors);
    return {valid:true,matrix,keyframeIds:[a.input.id,b.input.id],interpolated:true};
  } catch(failure) {return fail(failure.message);}
}

function dynamicAudit(calibration) {
  const errors=[],warnings=[];
  if (!calibration||!Array.isArray(calibration.segments)||!calibration.segments.length) errors.push('动态标定需要明确的镜头 segments。');
  const prepared=(Array.isArray(calibration?.segments)?calibration.segments:[]).map(segment=>prepareDynamicSegment(segment,calibration));
  const ids=new Set();
  for (const row of prepared) {
    if (ids.has(row.segment.id)) {row.errors.push('动态镜头 id 重复。');errors.push('动态镜头 id 重复。');}ids.add(row.segment.id);
  }
  for (let i=0;i<prepared.length;i++) for (let j=i+1;j<prepared.length;j++) {
    const a=prepared[i],b=prepared[j];
    if (a.segment.start<b.segment.end&&b.segment.start<a.segment.end) {
      a.errors.push('动态镜头时间范围重叠。');b.errors.push('动态镜头时间范围重叠。');errors.push('动态镜头时间范围重叠，不能唯一选择镜头。');
    }
  }
  warnings.push('动态标定是人工关键帧与锚点插值；没有执行自动光流、球员检测或身份跟踪。');
  return {prepared,errors,warnings};
}

/** Audit every measured checkpoint, including failed ones; never reports fitting residual as accuracy. */
export function auditCalibration(calibration) {
  if (!dynamicMode(calibration)) {
    const checked=validateCalibration(calibration);
    return {...checked,mode:'stationary',stationary:calibration?.stationary===true||calibration?.cameraMotion==='stationary'};
  }
  const audit=dynamicAudit(calibration);
  const segments=audit.prepared.map(row=>({id:row.segment.id,start:row.segment.start,end:row.segment.end,
    valid:!row.errors.length&&row.spans.length>0&&row.spans.every(span=>span.valid)&&row.frames.every(frame=>!frame.errors.length)&&row.checks.every(check=>!check.errors.length)&&row.frames[0]?.t===row.segment.start&&row.frames.at(-1)?.t===row.segment.end,errors:row.errors,warnings:row.warnings,
    coverage:row.spans.filter(span=>span.valid).map(span=>({start:span.start,end:span.end})),
    keyframes:row.frames.map(frame=>({id:frame.input?.id,t:frame.t,valid:!frame.errors.length,errors:frame.errors})),
    checkpoints:row.checks.map(check=>({id:check.id,t:check.t,court:check.court,image:check.image,predicted:check.predicted??null,
      residual:check.residual,valid:!check.errors.length,errors:check.errors})),error:residualSummary(row.checks),
    spans:row.spans,invalidIntervals:row.invalidIntervals}));
  const errors=[...audit.errors,...segments.flatMap(row=>row.errors),...segments.flatMap(row=>row.keyframes.flatMap(frame=>frame.errors)),
    ...segments.flatMap(row=>row.spans.flatMap(span=>span.reasons)),...segments.flatMap(row=>row.checkpoints.flatMap(check=>check.errors))];
  return {mode:'dynamic',valid:segments.length>0&&segments.every(row=>row.valid)&&!audit.errors.length,errors:[...new Set(errors)],
    warnings:[...new Set([...audit.warnings,...segments.flatMap(row=>row.warnings)])],matrix:null,error:residualSummary(audit.prepared.flatMap(row=>row.checks)),segments};
}

export function validateDynamicCalibration(calibration) {return auditCalibration({...calibration,mode:'dynamic'});}

/** Shared browser/offline selection, with local checkpoint gates and no extrapolation. */
export function calibrationAt(calibration,t,options={}) {
  const fail=reason=>({valid:false,matrix:null,segmentId:null,reason,error:null});
  if (!finite(t)||t<0) return fail('标定选择需要有限的视频绝对秒。');
  if (!dynamicMode(calibration)) {
    const checked=validateCalibration(calibration);
    if (!checked.valid) return fail(checked.errors.join(' '));
    if (calibration.start==null||calibration.end==null) return fail('固定镜头标定须显式限定 start,end。');
    if (t<calibration.start||t>=calibration.end) return fail('当前时刻超出固定镜头标定范围。');
    const id=calibration.segmentId??calibration.cameraId??null;
    if (options.segmentId!=null&&id!=null&&String(id)!==String(options.segmentId)) return fail('标定属于另一个镜头。');
    if (calibration.stationary!==true&&calibration.cameraMotion!=='stationary') return fail('旧标定已保留；须明确声明整段镜头 stationary:true 或重新保存动态关键帧后才能叠加。');
    if (!reliable(calibration)) return fail('标定已标记为遮挡、切镜或不可靠。');
    const intervalErrors=[],intervals=intervalRows(calibration.invalidIntervals,'失效区间',intervalErrors);
    if (intervalErrors.length) return fail(intervalErrors.join(' '));
    const blocked=intervals.find(row=>intervalContains(row,t));if (blocked) return fail(`当前区间暂停：${blocked.reason}`);
    return {valid:true,matrix:checked.matrix,segmentId:id,interpolated:false,keyframeIds:[],reason:null,error:checked.error,warnings:checked.warnings};
  }
  return selectDynamic(dynamicAudit(calibration),t,options);
}

function selectDynamic(audit,t,options={}) {
  const fail=reason=>({valid:false,matrix:null,segmentId:null,reason,error:null});
  if (!finite(t)||t<0) return fail('标定选择需要有限的视频绝对秒。');
  if (audit.errors.length) return fail(audit.errors.join(' '));
  const active=audit.prepared.filter(row=>row.segment.start<=t&&t<row.segment.end);
  if (active.length!==1) return fail('当前时刻没有唯一动态镜头区间。');
  const row=active[0];
  if (options.segmentId!=null&&String(row.segment.id)!==String(options.segmentId)) return fail('动态标定属于另一个镜头。');
  const selected=selectRaw(row,t);
  if (!selected.valid) return {...fail(selected.reason),segmentId:row.segment.id};
  const supported=row.spans.filter(span=>span.valid&&span.start<=t&&t<=span.end);
  // Exact isolated keyframes are also gated by two independent checks at that time.
  const exactChecks=row.checks.filter(check=>check.t===t&&!check.errors.length&&finite(check.residual));
  const distinct=[];for (const check of exactChecks) if (!distinct.some(p=>samePoint(p,check.court))) distinct.push(check.court);
  if (!supported.length&&distinct.length<2) {
    const failed=row.spans.filter(span=>span.start<=t&&t<=span.end).flatMap(span=>span.reasons);
    return {...fail(failed.length?failed.join(' '):'此关键帧缺少两个独立检查点；已保存但暂停投影。'),segmentId:row.segment.id};
  }
  return {...selected,segmentId:row.segment.id,reason:null,error:supported[0]?.error??residualSummary(exactChecks),warnings:audit.warnings};
}

/** Immutable compiled snapshot for a render batch; same gates as calibrationAt. */
export function createCalibrationSelector(calibration) {
  const snapshot=structuredClone(calibration);
  const audit=dynamicMode(snapshot)?dynamicAudit(snapshot):null;
  return (t,options={})=>audit?selectDynamic(audit,t,options):calibrationAt(snapshot,t,options);
}

/** Throws on unreliable segments so callers cannot accidentally display stale coordinates. */
export function projectAt(calibration,t,courtPoint,options={}) {
  const selected=calibrationAt(calibration,t,options);
  if (!selected.valid) throw new Error(selected.reason);
  return projectPoint(selected.matrix,courtPoint);
}

/** Immutable editor helpers. Invalid/missing checkpoints may be saved but remain gated. */
export function addCalibrationKeyframe(calibration,segmentId,keyframe) {
  if (!dynamicMode(calibration)||!Array.isArray(calibration.segments)) throw new Error('请先创建动态镜头区间。');
  if (!keyframe||!finite(keyframe.t)) throw new Error('关键帧需要当前视频绝对秒 t。');
  const segments=structuredClone(calibration.segments),segment=segments.find(row=>row.id===segmentId);
  if (!segment||segments.filter(row=>row.id===segmentId).length!==1) throw new Error('没有唯一的目标镜头。');
  const next={...structuredClone(keyframe),segmentId};
  if (next.t<segment.start||next.t>segment.end) throw new Error('关键帧时间超出所属镜头。');
  const probe=prepareDynamicSegment({...segment,keyframes:[next]},calibration).frames[0];
  if (!probe||probe.errors.length) throw new Error(probe?.errors.join(' ')??'关键帧无效。');
  const old=Array.isArray(segment.keyframes)?segment.keyframes:[];
  if (old.some(row=>row.t===next.t&&row.id!==next.id)) throw new Error('同一视频时刻已有其他关键帧，请替换原关键帧。');
  segment.keyframes=[...old.filter(row=>row.id!==next.id),next].sort((a,b)=>a.t-b.t);
  return {...structuredClone(calibration),mode:'dynamic',segments};
}

export function addCalibrationCheckpoint(calibration,segmentId,checkpoint) {
  if (!dynamicMode(calibration)||!Array.isArray(calibration.segments)) throw new Error('请先创建动态镜头区间。');
  const segments=structuredClone(calibration.segments),segment=segments.find(row=>row.id===segmentId);
  if (!segment||segments.filter(row=>row.id===segmentId).length!==1) throw new Error('没有唯一的目标镜头。');
  const next=structuredClone(checkpoint),existing=segment.checkpoints??segment.checkPoints??[];
  const probe=prepareDynamicSegment({...segment,checkpoints:[next]},calibration).checks[0];
  if (!probe) throw new Error('独立检查点无效。');
  // Retain an honestly measured poor checkpoint for the audit; reject malformed evidence.
  const malformed=probe.errors.filter(message=>!message.includes('实测误差')&&!message.includes('所在时刻'));
  if (malformed.length) throw new Error(malformed.join(' '));
  segment.checkpoints=[...existing.filter(row=>row.id!==next.id),next].sort((a,b)=>a.t-b.t);
  delete segment.checkPoints;
  return {...structuredClone(calibration),mode:'dynamic',segments};
}
