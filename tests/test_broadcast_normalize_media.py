"""Actual decoded media counterexamples, not ffprobe/ffmpeg mocks."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from core.broadcast.common import BroadcastError
from core.broadcast.media import FFMPEG, probe
from tools.normalize_broadcast_media import inspect_source, normalize_media, sha256


@unittest.skipUnless(shutil.which(FFMPEG) or Path(FFMPEG).is_file(), 'ffmpeg unavailable')
class BroadcastNormalizationTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.folder=Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def sample(self, name, fps=30, filters=None, vfr=False):
        path=self.folder/name
        args=[FFMPEG,'-v','error','-f','lavfi','-i',f'testsrc2=size=320x180:rate={fps}', '-frames:v','60']
        if filters:
            args += ['-vf',filters]
        if vfr:
            args += ['-fps_mode','vfr']
        args += ['-c:v','libx264','-pix_fmt','yuv420p','-y',str(path)]
        subprocess.run(args,check=True,capture_output=True)
        return path

    def test_30_and_60_cfr_are_audited_without_rewriting_source(self):
        for fps in (30,60):
            with self.subTest(fps=fps):
                source=self.sample(f'original-{fps}.mp4',fps)
                original=sha256(source)
                output=self.folder/f'copy-{fps}.mp4'
                report=normalize_media(source,output,fps)
                meta=probe(output)
                self.assertEqual((meta['fpsNumerator'],meta['fpsDenominator']),(fps,1))
                self.assertFalse(meta['variableFrameRate'])
                self.assertEqual(meta['firstFramePts'],0)
                self.assertEqual(report['original']['sha256'],original)
                self.assertEqual(sha256(source),original)
                self.assertEqual(sha256(output),report['output']['sha256'])
                side=json.loads(output.with_suffix('.mp4.normalization.json').read_text())
                self.assertEqual(side,report)
                self.assertEqual(len(report['timeMapping']['frames']),len(meta['framePts']))
                self.assertIn('not exact content correspondence',report['timeMapping']['description'])
                with self.assertRaises(ValueError):
                    normalize_media(source,output,fps)

    def test_nonzero_pts_rejection_has_an_explicit_audited_copy_path(self):
        source=self.sample('offset.mp4',filters='setpts=PTS+2/TB')
        with self.assertRaises(BroadcastError):
            probe(source)
        report=normalize_media(source,self.folder/'zero.mp4',30)
        self.assertAlmostEqual(report['timeMapping']['sourceFirstPresentationSeconds'],2,places=3)
        self.assertEqual(probe(self.folder/'zero.mp4')['firstFramePts'],0)
        self.assertGreater(report['timeMapping']['frames'][0]['nearestSourcePts'],0)

    def test_vfr_cannot_be_mislabeled_as_an_exact_pts_mapping(self):
        source=self.sample('vfr.mp4',filters='select=lt(mod(n\\,3)\\,2)',vfr=True)
        self.assertTrue(probe(source)['variableFrameRate'])
        _,_,vfr=inspect_source(source)
        self.assertTrue(vfr)
        report=normalize_media(source,self.folder/'cfr.mp4',60)
        self.assertTrue(report['original']['variableFrameRate'])
        self.assertFalse(probe(self.folder/'cfr.mp4')['variableFrameRate'])
        mapping=report['timeMapping']['frames']
        self.assertTrue(any(row['nearestTimestampErrorSeconds']>0 for row in mapping))
        self.assertIn('Re-extract and review evidence',report['timeMapping']['description'])

    def test_square_pixels_and_rotation_are_baked_into_the_copy(self):
        source=self.sample('sar.mp4',filters='setsar=2/1')
        with self.assertRaises(BroadcastError):
            probe(source)
        output=self.folder/'square.mp4'
        normalize_media(source,output,30)
        self.assertEqual(probe(output)['width'],640)
        normal=self.sample('plain.mp4')
        rotated=self.folder/'rotation.mp4'
        subprocess.run([FFMPEG,'-v','error','-display_rotation:v:0','90','-i',str(normal),'-c','copy',str(rotated)],check=True)
        with self.assertRaises(BroadcastError):
            probe(rotated)
        baked=self.folder/'baked.mp4'
        normalize_media(rotated,baked,30)
        self.assertEqual((probe(baked)['width'],probe(baked)['height']),(180,320))

    def test_source_path_can_never_be_the_output(self):
        source=self.sample('untouched.mp4')
        original=sha256(source)
        with self.assertRaises(ValueError):
            normalize_media(source,source)
        self.assertEqual(sha256(source),original)


if __name__=='__main__':
    unittest.main()
