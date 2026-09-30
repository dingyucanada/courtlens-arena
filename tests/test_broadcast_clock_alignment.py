import copy
import unittest

from core.broadcast.clock_alignment import countdown, preview
from core.broadcast.common import BroadcastError


class ClockAlignmentTest(unittest.TestCase):
    def setUp(self):
        self.project = {"id":"p1", "revision":3,"media":{"sha256":"a"*64,"duration":48},"observations":[]}
        self.frames = [{"id":"f1","mediaSha256":"a"*64,"sha256":"b"*64,"actualTime":10},
                       {"id":"f2","mediaSha256":"a"*64,"sha256":"c"*64,"actualTime":15}]
        self.request = {"segmentId":"s1","period":3,"clock":"07:41", "anchors":[{"frameId":"f1","clock":"07:43"},{"frameId":"f2","clock":"07:38"}]}

    def test_interpolates_reversed_input_order_without_mutation(self):
        before=copy.deepcopy((self.project,self.frames,self.request))
        self.request["anchors"].reverse()
        result=preview(self.project,self.frames,self.request)
        self.assertEqual(result["mapping"]["videoTime"],12)
        self.assertEqual(result["mapping"]["period"],3)
        self.assertEqual(result["mapping"]["mappingEvidenceIds"],["f1","f2"])
        self.assertEqual(result["status"],"proposal")
        self.assertEqual((self.project,self.frames),before[:2])

    def test_stopped_clock_cannot_resolve_unique_event(self):
        self.request["anchors"][1]["clock"]="07:43"
        with self.assertRaises(BroadcastError) as error:preview(self.project,self.frames,self.request)
        self.assertEqual(error.exception.code,"clock_ambiguous")

    def test_pause_or_edit_does_not_get_global_offset(self):
        self.frames[1]["actualTime"]=25
        with self.assertRaises(BroadcastError) as error:preview(self.project,self.frames,self.request)
        self.assertEqual(error.exception.code,"clock_discontinuous")

    def test_clock_outside_pair_cannot_be_extrapolated(self):
        self.request["clock"]="07:30"
        with self.assertRaises(BroadcastError) as error:preview(self.project,self.frames,self.request)
        self.assertEqual(error.exception.code,"clock_outside_anchors")

    def test_other_camera_segment_blocks_interpolation(self):
        self.project["observations"]=[{"segmentId":"replay","start":11,"end":13}]
        with self.assertRaises(BroadcastError):preview(self.project,self.frames,self.request)

    def test_wrong_media_and_unknown_frame_block(self):
        for change in ("sha","frame"):
            with self.subTest(change=change):
                frames=copy.deepcopy(self.frames);request=copy.deepcopy(self.request)
                if change=="sha":frames[1]["mediaSha256"]="d"*64
                else:request["anchors"][1]["frameId"]="unknown"
                with self.assertRaises(BroadcastError):preview(self.project,frames,request)

    def test_invalid_period_clock_precision_and_anchor_count(self):
        for field,value in (("period",True),("period",0),("period",21),("clock","07:99"),("clock","12:01"),("anchors",[])):
            with self.subTest(field=field,value=value):
                req=copy.deepcopy(self.request);req[field]=value
                with self.assertRaises(BroadcastError):preview(self.project,self.frames,req)
        self.assertAlmostEqual(countdown("00:02.35"),2.35)

    def test_overtime_length_and_clock_ascending_fail(self):
        self.request["period"]=5
        with self.assertRaises(BroadcastError):preview(self.project,self.frames,self.request)
        self.request["period"]=3;self.request["anchors"][1]["clock"]="07:44"
        with self.assertRaises(BroadcastError):preview(self.project,self.frames,self.request)


if __name__ == '__main__':unittest.main()
