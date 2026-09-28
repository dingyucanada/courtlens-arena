"""Transparent manual/CSV intake. No fabricated NBA metrics or inferred time alignment."""
import csv,io,copy,math
from .validation import validate_dataset,ValidationError,SEMANTICS,number
DEFINITIONS={
 'xfg_pct':'输入数据提供的单次出手预测命中概率0–1；不等于实际结果，未提供则null。',
 'gravity':'数据提供者的牵制指标及其原始单位；未定义或未提供时保留null，不从距离推算。',
 'leverage':'仅接受已确认口径的回合胜率机会差0–1，不接受球员累计Leverage Score。'}

def fail(path,message):raise ValidationError(path,message)
def base_dataset(video,game,source):
 if not isinstance(video,dict) or not isinstance(game,dict):fail('input','video和game必须是对象')
 if not isinstance(source,str) or not source.strip():fail('source','请填写素材及数据来源，不自动认证授权')
 return {'schema_version':'1.0','provenance':{'kind':'user','label':'用户复盘项目 · 来源与标注需核对','source':source.strip()},'game':copy.deepcopy(game),'video':copy.deepcopy(video),'metric_definitions':dict(DEFINITIONS),'metric_semantics':dict(SEMANTICS),'workflow':{'state':'draft'},'possessions':[]}

def blank_dataset(video,game,source):
 d=base_dataset(video,game,source)
 duration=number(video.get('duration'),'video.duration',0.001,14400)
 d['possessions']=[{'id':'p01','title':'待标注回合','start':0,'end':duration,'shot_time':duration/2,'result_time':None,'clock':'待核对','offense':game.get('home'),'shooter':'待标注','result':'unknown','points':0,'metrics':{'xfg_pct':None,'gravity':None,'leverage':None},'source_refs':['人工标注尚未完成'],'tracks':[],'camera_segments':[{'id':'camera-1','start':0,'end':duration,'calibrated':False}],'annotations':[],'notes':['这是编辑占位，不能作为比赛事实或导出成片。']}]
 return validate_dataset(d)

REQUIRED=('id','title','start','end','shot_time','offense','shooter','points','result')
OPTIONAL=('result_time','clock','xfg_pct','gravity','leverage')
def import_csv(text,video,game,source,leverage_semantics=None):
 if not isinstance(text,str) or len(text.encode('utf-8'))>8*1024*1024:fail('csv','CSV须为不超过8 MiB的文本')
 reader=csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
 try:headers=reader.fieldnames or []
 except csv.Error as e:fail('csv.headers','CSV表头无法读取；单个字段不能超过128 KiB：'+str(e))
 if len(headers)!=len(set(headers)):fail('csv.headers','存在重复列名')
 missing=[k for k in REQUIRED if k not in headers]
 if missing:fail('csv.headers','缺少列：'+', '.join(missing))
 extras=[k for k in headers if k not in REQUIRED+OPTIONAL]
 d=base_dataset(video,game,source);warnings=[]
 if extras:warnings.append('未导入额外列：'+', '.join(extras))
 row_lines=[]
 def records():
  while True:
   try:row=next(reader)
   except StopIteration:return
   except csv.Error as e:fail(f'csv.row[{max(2,reader.line_num)}]','CSV记录无法读取；单个字段不能超过128 KiB：'+str(e))
   yield row
 for record_index,row in enumerate(records(),1):
  row_number=reader.line_num;row_lines.append(row_number)
  if record_index>200:fail('csv','最多导入200个回合，请分拆比赛片段')
  if None in row:fail(f'csv.row[{row_number}]','字段数量超过表头；含逗号的文本请加双引号')
  if any(v is None for v in row.values()):fail(f'csv.row[{row_number}]','字段数量不足')
  row={k:v.strip() for k,v in row.items()}
  def num(key,nullable=False):
   value=row.get(key,'')
   if nullable and value.lower() in ('','null','na','n/a'):return None
   try:r=float(value)
   except ValueError:fail(f'csv.row[{row_number}].{key}','必须是数字；缺失指标留空，不填假零')
   if not math.isfinite(r):fail(f'csv.row[{row_number}].{key}','必须是有限数字')
   return r
  start,end,shot=num('start'),num('end'),num('shot_time');points=num('points')
  if not points.is_integer():fail(f'csv.row[{row_number}].points','投篮分值必须是整数')
  leverage=num('leverage',True)
  if leverage is not None and leverage_semantics!=SEMANTICS['leverage']:fail(f'csv.row[{row_number}].leverage','必须显式确认leverage_semantics为possession_win_probability_opportunity；未知口径请留空')
  p={'id':row['id'],'title':row['title'],'start':start,'end':end,'shot_time':shot,'result_time':num('result_time',True),'clock':row.get('clock') or '来源未提供节钟','offense':row['offense'],'shooter':row['shooter'],'points':int(points),'result':row['result'],'metrics':{'xfg_pct':num('xfg_pct',True),'gravity':num('gravity',True),'leverage':leverage},'source_refs':[f'{source}；CSV记录结束于物理行 {row_number}'],'annotations':[],'tracks':[],'camera_segments':[{'id':f"camera-{row['id']}",'start':start,'end':end,'calibrated':False}],'notes':['CSV只提供回合事件/指标；轨迹与空间标注尚未接入。']}
  d['possessions'].append(p)
 try:d=validate_dataset(d)
 except ValidationError as e:
  import re
  m=re.search(r'possessions\[(\d+)\]',e.path)
  if m:raise ValidationError(f'csv.row[{row_lines[int(m.group(1))]}] ({e.path})',e.message) from e
  raise
 warnings.append('CSV时刻必须已映射到该视频秒数；不会把比赛节钟自动当成视频时间。')
 return {'dataset':d,'warnings':warnings}
