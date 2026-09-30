"""Real FFmpeg fixtures for source-display coordinate and browser time boundaries."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from core.broadcast.common import BroadcastError
from core.broadcast.media import probe


FFMPEG = os.environ.get("COURTLENS_FFMPEG") or shutil.which("ffmpeg")


class DisplayTransformBoundaryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not FFMPEG:
            raise unittest.SkipTest("ffmpeg unavailable")
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.base = cls.root / "base.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(cls.base)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_encoded_portrait_without_display_transform_is_supported(self):
        source = self.root / "portrait.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(source)], check=True)
        self.assertEqual((probe(source)["width"], probe(source)["height"]), (360, 640))

    def test_display_rotation_90_and_270_rejected_before_editing(self):
        for angle in (90, 270):
            with self.subTest(angle=angle):
                source = self.root / f"rotated-{angle}.mp4"
                subprocess.run([FFMPEG, "-v", "error", "-display_rotation", str(angle), "-i", str(self.base), "-c", "copy", "-y", str(source)], check=True)
                with self.assertRaises(BroadcastError) as caught:
                    probe(source)
                self.assertEqual(caught.exception.code, "unsupported_transform")

    def test_non_square_sar_rejected(self):
        source = self.root / "sar.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-i", str(self.base), "-vf", "setsar=4/3", "-c:v", "libx264", "-y", str(source)], check=True)
        with self.assertRaises(BroadcastError) as caught:
            probe(source)
        self.assertEqual(caught.exception.code, "unsupported_transform")

    def test_nonzero_first_pts_rejected(self):
        source = self.root / "pts-offset.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-i", str(self.base), "-vf", "setpts=PTS+5/TB", "-c:v", "libx264", "-y", str(source)], check=True)
        with self.assertRaises(BroadcastError) as caught:
            probe(source)
        self.assertEqual(caught.exception.code, "unsupported_timebase")
