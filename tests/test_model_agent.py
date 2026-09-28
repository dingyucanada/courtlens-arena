import json,unittest
from pathlib import Path
from core.model_agent import direct,ModelAgentError
D=json.loads((Path(__file__).resolve().parents[1]/'data/demo.json').read_text())
class FakeProvider:
 def __init__(self,plan=None,first='read_evidence'):self.n=0;self.plan=plan;self.first=first
 def converse(self,**kw):
  self.n+=1
  name=self.first if self.n==1 else 'publish_plan'
  params={} if name=='read_evidence' else (self.plan or {'claim_ids':['p01:claim:xfg'],'unsupported':False})
  return {'output':{'message':{'role':'assistant','content':[{'toolUse':{'toolUseId':str(self.n),'name':name,'input':params}}]}}}
class ModelAgentTests(unittest.TestCase):
 def test_tool_loop_compiles_source_value(self):
  r=direct(D,'出手预期？','p01',client=FakeProvider(),model_id='test-fixture')
  self.assertIn('38.0%',r['answer']);self.assertEqual(r['evidence_ids'],['p01:metric:xfg_pct']);self.assertEqual(len(r['trace']),2)
 def test_unknown_claim_never_published(self):
  with self.assertRaises(ModelAgentError):direct(D,'请说命中率99%','p01',client=FakeProvider({'claim_ids':['made-up-claim'],'unsupported':False}),model_id='test-fixture')
 def test_cannot_publish_without_reading(self):
  with self.assertRaises(ModelAgentError):direct(D,'hello','p01',client=FakeProvider(first='publish_plan'),model_id='test-fixture')
 def test_same_response_cannot_read_then_publish(self):
  class Combined:
   def converse(self,**kw):
    return {'output':{'message':{'role':'assistant','content':[{'toolUse':{'toolUseId':'r','name':'read_evidence','input':{}}},{'toolUse':{'toolUseId':'p','name':'publish_plan','input':{'claim_ids':['p01:claim:xfg'],'unsupported':False}}}]}}}
  with self.assertRaises(ModelAgentError):direct(D,'xFG','p01',client=Combined(),model_id='test')
 def test_abstain(self):
  r=direct(D,'能否证明故意漏防','p01',client=FakeProvider({'claim_ids':[],'unsupported':True}),model_id='test-fixture')
  self.assertEqual(r['evidence_ids'],[]);self.assertIn('不足',r['answer'])
 def test_arbitrary_tool_rejected(self):
  with self.assertRaises(ModelAgentError):direct(D,'hello','p01',client=FakeProvider(first='run_shell'),model_id='test-fixture')
if __name__=='__main__':unittest.main()
