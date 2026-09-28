"""Independent optional Pillow export checks; excluded from normal test discovery.

Run with the optional media runtime:
PYTHONDONTWRITEBYTECODE=1 python3 tests/independent_media.py -v
Only in-memory frames are rendered; source media and application files stay intact.
"""
import copy
import unittest
from unittest.mock import patch
from independent_core import dataset, without_annotations
from core.engine import analyze
from PIL import Image, ImageChops, ImageDraw
import export_video


def frame(d, t=4):
    return export_video.overlay(Image.new("RGB", (1280, 720)), d, analyze(d), t)


class RenderedExportBoundary(unittest.TestCase):
    def test_tracking_annotation_without_tracks_changes_no_pixels(self):
        d = dataset()
        self.assertIsNone(ImageChops.difference(frame(d), frame(without_annotations(d))).getbbox())

    def test_manual_annotation_without_tracks_is_visible_and_labelled(self):
        d = dataset(manual=True)
        texts = []
        original = ImageDraw.ImageDraw.text
        def record(draw, xy, text, *args, **kwargs):
            texts.append(text)
            return original(draw, xy, text, *args, **kwargs)
        with patch.object(ImageDraw.ImageDraw, "text", record):
            rendered = frame(d)
        self.assertTrue(any(str(t).startswith("人工 · ") for t in texts))
        self.assertIsNotNone(ImageChops.difference(rendered, frame(without_annotations(d))).getbbox())

    def test_reviewed_manual_annotation_is_visible_in_uncalibrated_camera(self):
        d = dataset(manual=True, calibrated=False)
        self.assertIsNotNone(ImageChops.difference(frame(d), frame(without_annotations(d))).getbbox())

    def test_manual_annotation_does_not_unlock_uncalibrated_tracks_in_export(self):
        d = dataset(manual=True, calibrated=False, no_tracks=False)
        original = ImageDraw.ImageDraw.text
        texts = []
        def record(draw, xy, text, *args, **kwargs):
            texts.append(text)
            return original(draw, xy, text, *args, **kwargs)
        with patch.object(ImageDraw.ImageDraw, "text", record):
            frame(d)
        self.assertIn("人工 · 独立检查区", texts)
        self.assertNotIn("H3", texts)

    def test_manual_does_not_enable_other_annotations_without_tracks(self):
        d = dataset(manual=True)
        extra = copy.deepcopy(d["possessions"][0]["annotations"][0])
        extra.update(id="auto-other", evidence_id="p01:auto-other", origin="tracking", label="不应显示的自动区", points=[[.3,.4],[.5,.4],[.5,.6],[.3,.6]])
        mixed = copy.deepcopy(d)
        mixed["possessions"][0]["annotations"].append(extra)
        self.assertIsNone(ImageChops.difference(frame(mixed), frame(d)).getbbox())

    def test_large_track_gap_hides_tracking_but_allows_manual(self):
        for manual in (False, True):
            d = dataset(manual=manual, no_tracks=False)
            p = d["possessions"][0]
            p["tracks"] = [f for f in p["tracks"] if f["t"] <= 2 or f["t"] >= 6]
            diff = ImageChops.difference(frame(d), frame(without_annotations(d))).getbbox()
            self.assertEqual(diff is not None, manual)

    def test_manual_annotation_stops_at_its_end(self):
        d = dataset(manual=True)
        self.assertIsNone(ImageChops.difference(frame(d, 10), frame(without_annotations(d), 10)).getbbox())


if __name__ == "__main__":
    unittest.main()
