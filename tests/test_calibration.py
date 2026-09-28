import unittest
from core.calibration import homography,project,time_map
class CalibrationTests(unittest.TestCase):
 def test_identity_and_nontrivial_projection(self):
  corners=[[0,0],[1,0],[1,1],[0,1]]
  h=homography(corners,[[.2,.1],[.8,.1],[.9,.9],[.1,.9]])
  for p,q in zip(corners,[[.2,.1],[.8,.1],[.9,.9],[.1,.9]]):
   actual=project(h,*p)
   for a,b in zip(actual,q):self.assertAlmostEqual(a,b,places=9)
  self.assertAlmostEqual(project(h,.5,.5)[0],.5)
 def test_degenerate(self):
  with self.assertRaises(ValueError):homography([[0,0],[1,0],[2,0],[3,0]],[[0,0],[1,0],[1,1],[0,1]])
 def test_anchor_alignment_and_stop(self):
  a=[{'source':100,'video':2},{'source':110,'video':14},{'source':115,'video':19}]
  self.assertEqual(time_map(105,a),8)
  self.assertEqual(time_map(112,a),16)
  with self.assertRaises(ValueError):time_map(116,a)
 def test_reversed_anchor_and_missing(self):
  with self.assertRaises(ValueError):time_map(1,[])
  with self.assertRaises(ValueError):time_map(1,[{'source':0,'video':1},{'source':1,'video':0}])
 def test_nonfinite(self):
  with self.assertRaises(ValueError):time_map(float('nan'),[{'source':0,'video':0}])
if __name__=='__main__':unittest.main()
