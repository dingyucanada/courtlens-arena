import json, tempfile, unittest, shutil
from pathlib import Path
from tools.prepare_video_evidence import prepare
ROOT=Path(__file__).resolve().parents[1]
@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg/FFprobe required')
class VideoEvidenceTests(unittest.TestCase):
 def test_actual_frame_pts_and_immutable_directory(self):
  with tempfile.TemporaryDirectory() as d:
   out=Path(d)/'packet';p=prepare(ROOT/'media/demo.mp4',out,[0,.037,1.11],source_label='合成独立工程测试')
   self.assertEqual(len(p['frames']),3);self.assertFalse(p['source']['authenticated'])
   for f in p['frames']:
    self.assertLessEqual(f['timingErrorSeconds'],.021);self.assertGreater((out/f['image']).stat().st_size,100);self.assertEqual(len(f['sha256']),64)
   self.assertEqual(json.loads((out/'packet.json').read_text())['source']['sha256'],p['source']['sha256'])
   with self.assertRaises(ValueError):prepare(ROOT/'media/demo.mp4',out,[0],source_label='test')
 def test_invalid_windows_and_no_fake_frames(self):
  with tempfile.TemporaryDirectory() as d:
   for times in [[-1],[float('nan')],[True],[999],[1,1],list(range(25))]:
    with self.assertRaises(ValueError):prepare(ROOT/'media/demo.mp4',Path(d)/'bad',times,source_label='test')
    self.assertFalse((Path(d)/'bad').exists())
