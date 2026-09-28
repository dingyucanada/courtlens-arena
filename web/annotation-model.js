(function(root){
 function create(p,kind,label,start,end,points,uid){
  if(!['arrow','zone','label'].includes(kind))throw Error('请选择支持的标注工具');
  if(!label.trim())throw Error('请填写标签');
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<p.start||end>p.end||start>=end)throw Error('标注时间须位于回合内且结束晚于开始');
  if(!points.every(pt=>pt.length===2&&pt.every(v=>Number.isFinite(v)&&v>=0&&v<=1)))throw Error('标注点必须位于视频画面内');
  if(points.length!==(kind==='label'?1:2))throw Error('请完成画面选点');
  const segment=p.camera_segments.find(s=>s.start<=start&&s.end>=end);
  if(!segment)throw Error('标注不能跨镜头，请缩短区间');
  let shape=points;
  if(kind==='zone'){const [a,b]=points;if(Math.abs(a[0]-b[0])<.002||Math.abs(a[1]-b[1])<.002)throw Error('区域太小，请重新选点');shape=[a,[b[0],a[1]],b,[a[0],b[1]]];}
  const annotation={id:'manual-'+uid,kind,label:label.trim(),start,end,points:shape,evidence_id:p.id+':manual:'+uid,origin:'manual',frame_reviewed:true,author_note:'人工核对视频画面与时间；静态标注，不是自动跟踪或因果证明'};
  return {annotation,camera_segments:p.camera_segments};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={create};else root.CourtLensAnnotation={create};
})(typeof globalThis!=='undefined'?globalThis:this);
