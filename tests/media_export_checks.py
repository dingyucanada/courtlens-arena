"""Optional integration checks: run with Pillow and FFmpeg available."""
import copy,json,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class ExportChecks(unittest.TestCase):
 def reject(self,dataset,video,error):
  with tempfile.TemporaryDirectory() as folder:
   p=Path(folder);(p/'input.json').write_text(json.dumps(dataset));out=p/'output.mp4'
   r=subprocess.run([sys.executable,str(ROOT/'tools/export_video.py'),'--data',str(p/'input.json'),'--video',str(video),'--output',str(out)],capture_output=True,text=True)
   self.assertNotEqual(r.returncode,0);self.assertIn(error,r.stderr);self.assertFalse(out.exists())
 def test_mismatched_same_length_video(self):
  d=json.loads((ROOT/'data/demo.json').read_text());self.reject(d,ROOT/'media/annotated-demo.mp4','SHA-256')
 def test_missing_identity(self):
  d=json.loads((ROOT/'data/demo.json').read_text());d['video'].pop('sha256');self.reject(d,ROOT/'media/demo.mp4','SHA-256')
 def test_dimension_mismatch(self):
  d=json.loads((ROOT/'data/demo.json').read_text());d['video']['width']=960;self.reject(d,ROOT/'media/demo.mp4','dimensions')
 def test_longer_declared_duration(self):
  d=json.loads((ROOT/'data/demo.json').read_text());d['video']['duration']=37;self.reject(d,ROOT/'media/demo.mp4','duration')
if __name__=='__main__':unittest.main()
