import copy,unittest
from core.tracking import sample_track
class TrackingTests(unittest.TestCase):
 def setUp(self):
  self.p={'start':0,'end':3,'camera_segments':[{'start':0,'end':3,'calibrated':True}], 'tracks':[{'t':1,'players':[{'id':'A','team':'H','x':0,'y':0}],'ball':{'x':0,'y':0}},{'t':2,'players':[{'id':'A','team':'H','x':1,'y':1}],'ball':{'x':1,'y':1}}]}
 def test_interpolation(self):
  fr=sample_track(self.p,1.25);self.assertEqual(fr['players'][0]['x'],.25);self.assertEqual(fr['ball']['y'],.25)
 def test_no_extrapolation(self):
  for t in [0,.9,2.1,3]:self.assertIsNone(sample_track(self.p,t))
 def test_disappearing_identity(self):
  self.p['tracks'][1]['players']=[];self.assertEqual(sample_track(self.p,1.5)['players'],[])
 def test_no_camera_crossing(self):
  self.p['camera_segments']=[{'start':0,'end':1.5,'calibrated':True},{'start':1.5,'end':3,'calibrated':True}];self.assertIsNone(sample_track(self.p,1.25))
 def test_large_gap_hidden(self):
  self.p['tracks'][1]['t']=2.1;self.assertIsNone(sample_track(self.p,1.5))
 def test_exact_and_final_samples(self):
  self.assertEqual(sample_track(self.p,1)['players'][0]['x'],0)
  self.p['tracks'][0]['t']=2;self.p['tracks'][1]['t']=3;self.assertEqual(sample_track(self.p,2.5)['players'][0]['x'],.5)
 def test_uncalibrated(self):
  self.p['camera_segments'][0]['calibrated']=False;self.assertIsNone(sample_track(self.p,1.5))
if __name__=='__main__':unittest.main()
