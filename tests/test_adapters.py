import unittest,json,copy
from pathlib import Path
from core.adapters import blank_dataset,import_csv
from core.quality import quality_report
from core.validation import ValidationError,validate_dataset
D=json.loads((Path(__file__).resolve().parents[1]/'data/demo.json').read_text())
TEXT='id,title,start,end,shot_time,result_time,offense,shooter,points,result,xfg_pct,gravity,leverage\np01,实际示例事件,0,12,9,10.5,HOU,A,3,made,.38,,\n'
class IntakeTests(unittest.TestCase):
 def parse(self,text=TEXT,**kw):return import_csv(text,D['video'],D['game'],'test supplied source',**kw)
 def test_null_preserved_and_draft(self):
  d=self.parse()['dataset'];self.assertIsNone(d['possessions'][0]['metrics']['gravity']);self.assertEqual(d['workflow']['state'],'draft');self.assertFalse(quality_report(d)['export_allowed'])
 def test_explicit_zero_kept(self):self.assertEqual(self.parse(TEXT.replace(',.38,,',',0,0,'))['dataset']['possessions'][0]['metrics']['gravity'],0)
 def test_percent_not_silently_scaled(self):
  with self.assertRaisesRegex(ValidationError,'csv.row'):self.parse(TEXT.replace('.38','38'))
 def test_unknown_leverage_semantics_rejected(self):
  text=TEXT.replace(',.38,,',',.38,,.8')
  with self.assertRaisesRegex(ValidationError,'leverage_semantics'):self.parse(text)
  self.assertEqual(self.parse(text,leverage_semantics='possession_win_probability_opportunity')['dataset']['possessions'][0]['metrics']['leverage'],.8)
 def test_duplicate_header(self):
  with self.assertRaisesRegex(ValidationError,'重复'):self.parse(TEXT.replace('result_time','start'))
 def test_nonfinite(self):
  with self.assertRaisesRegex(ValidationError,'有限'):self.parse(TEXT.replace('.38','NaN'))
 def test_shot_end_is_rejected(self):
  with self.assertRaisesRegex(ValidationError,'出手'):self.parse(TEXT.replace(',12,9,',',12,12,'))
 def test_blank_is_not_observation(self):
  d=blank_dataset(D['video'],D['game'],'user material');self.assertEqual(d['possessions'][0]['points'],0);self.assertEqual(d['possessions'][0]['result'],'unknown');self.assertFalse(quality_report(d)['export_allowed'])
 def test_reviewed_missing_metrics_are_honest_warnings(self):
  d=self.parse()['dataset'];d['workflow']['state']='reviewed';q=quality_report(d);self.assertTrue(q['export_allowed']);self.assertEqual(q['metrics']['missing_metrics']['gravity'],1);self.assertEqual(q['status'],'needs_review')
 def test_invalid_structure_quality_blocks(self):self.assertFalse(quality_report({})['export_allowed'])
 def test_unrepresentable_duration_returns_validation_error(self):
  video=copy.deepcopy(D['video']);video['duration']=10**500
  with self.assertRaisesRegex(ValidationError,'video.duration'):blank_dataset(video,D['game'],'user material')
 def test_oversize_csv_field_returns_actionable_validation_error(self):
  lines=TEXT.splitlines();text=lines[0]+',extra\n'+lines[1]+','+'x'*140000+'\n'
  with self.assertRaisesRegex(ValidationError,'128 KiB'):self.parse(text)
 def test_oversize_csv_header_returns_validation_error(self):
  with self.assertRaisesRegex(ValidationError,'csv.headers'):self.parse('x'*140000+'\n')
if __name__=='__main__':unittest.main()
