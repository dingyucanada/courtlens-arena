"""No model download: reject unsafe windows and separate seed score from tracking."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from cv_sam2 import select_window

class Sam2WindowTests(unittest.TestCase):
    def data(self):
        return {'samples':[{'frameTime':t,'segmentId':s,'objects':[{'classId':'player','score':.9,'trackId':'p1'}]} for t,s in [(0,'a'),(.2,'a'),(.4,'b')]]}
    def test_cut_is_not_tracked_through(self):
        with self.assertRaisesRegex(ValueError,'one shot'): select_window(self.data(),0,.4,3)
    def test_seed_must_be_the_actual_detector_frame(self):
        with self.assertRaises(ValueError): select_window(self.data(),.1,.4,3)
    def test_valid_short_shot_has_seed(self):
        rows,seeds=select_window(self.data(),0,.2,3)
        self.assertEqual(len(rows),2);self.assertEqual(seeds[0]['trackId'],'p1')
    def test_boundaries_and_nonfinite_values(self):
        for start,end in [(0,7),(0,float('nan')),(-1,0),(False,.2)]:
            with self.assertRaises(ValueError): select_window(self.data(),start,end,3)
    def test_no_detection_does_not_invent_a_box(self):
        d=self.data();d['samples'][0]['objects']=[]
        with self.assertRaisesRegex(ValueError,'No player'): select_window(d,0,.2,3)

if __name__=='__main__':unittest.main()
