"""Report measured coverage and explicit unknowns, never an invented quality score."""
from .validation import validate_dataset,ValidationError

def quality_report(dataset):
 try:d=validate_dataset(dataset)
 except ValidationError as e:return {'status':'blocked','export_allowed':False,'checks':[{'id':'schema','label':'数据结构与取值','status':'fail','detail':str(e)}],'metrics':{},'blocking_issues':[str(e)],'warnings':[]}
 ps=d['possessions'];n=len(ps);checks=[];blocking=[];warnings=[]
 def add(id,label,status,detail):
  checks.append(dict(id=id,label=label,status=status,detail=detail))
  if status=='fail':blocking.append(detail)
  if status=='warning':warnings.append(detail)
 add('schema','数据结构与取值','pass',f'{n}个回合通过字段、时序、指标范围与引用约束')
 synthetic=d['provenance']['kind']=='synthetic'
 add('source','数据来源','warning',('合成演练数据，不能作为真实比赛准确率证据' if synthetic else '来源由提供者声明；系统未认证授权、采集精度或语义'))
 draft=d.get('workflow',{}).get('state')=='draft'
 add('review','人工复核','fail' if draft else 'pass','仍为编辑草稿；请核对回合时刻、球员与来源后标记已复核' if draft else '未标记为编辑草稿；复核声明不等同第三方认证')
 placeholders=[p['id'] for p in ps if p['shooter'].strip() in ('待标注','请填写真实球员') or p['points']==0]
 if placeholders:add('placeholders','占位内容','fail','回合仍有待标注球员或零分占位：'+', '.join(placeholders))
 add('fingerprint','视频身份','pass' if d['video'].get('sha256') else 'fail','数据含视频指纹；实际文件在播放/导出时另行核验' if d['video'].get('sha256') else '缺少视频指纹，请导入匹配视频并完成绑定')
 missing={k:sum(p['metrics'][k] is None for p in ps) for k in ('xfg_pct','gravity','leverage')}
 labels={'xfg_pct':'预期命中概率','gravity':'牵制指标','leverage':'回合胜率机会差'}
 for k,count in missing.items():add(k,labels[k]+'覆盖','warning' if count else 'pass',f'{n-count}/{n}个回合提供该指标；缺失{count}个，不补零')
 no_result=sum(p.get('result_time') is None for p in ps)
 add('result-time','结果时刻','warning' if no_result else 'pass',f'{no_result}个回合缺少结果时刻；这些回合不在播放中播报结果' if no_result else '所有回合已提供结果时刻；仅到达该时刻后播报结果')
 uncalibrated=sum(not s['calibrated'] for p in ps for s in p['camera_segments'])
 add('camera','镜头校准','warning' if uncalibrated else 'pass',f'{uncalibrated}个镜头未校准；这些镜头暂停自动空间标注，已核对人工标注可独立显示' if uncalibrated else '所有镜头均已声明校准；自动空间标注仍需同一时刻的有效轨迹')
 no_tracks=sum(not p['tracks'] for p in ps)
 add('tracking','轨迹覆盖','warning' if no_tracks else 'pass',f'{no_tracks}个回合没有轨迹；不自动检测或推断球员位置')
 covered=sum(p['end']-p['start'] for p in ps);duration=d['video']['duration']
 add('coverage','回合时间覆盖','warning' if covered/duration<.999 else 'pass',f'覆盖视频{covered:.2f}/{duration:.2f}秒（{covered/duration:.1%}），空白区间不解释')
 return {'status':'blocked' if blocking else 'needs_review' if warnings else 'ready','export_allowed':not blocking,'checks':checks,'metrics':{'possession_count':n,'duration':duration,'covered_seconds':covered,'missing_metrics':missing,'uncalibrated_segments':uncalibrated,'possessions_without_tracks':no_tracks},'blocking_issues':blocking,'warnings':warnings}
