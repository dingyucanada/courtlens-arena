from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from core.broadcast.scene_sampling import plan_samples, prepare, scan, SCHEMA


def fixture(times=None, cut=2):
    times = times or [i / 25 for i in range(150)]
    return {"schema": SCHEMA, "mediaSha256": "a" * 64,
            "media": {"frameTimes": times, "framePts": list(range(len(times))), "duration": 6},
            "candidates": [{"sourceTime": cut}] if cut is not None else []}


class SamplingPlanTests(unittest.TestCase):
    def test_actual_pts_stay_in_each_half_open_piece_and_reset_identity(self):
        plan = plan_samples(fixture(), [{"start": 1, "end": 3}], fps=30)
        self.assertEqual(len(plan["windows"]), 2)
        self.assertNotEqual(plan["windows"][0]["identityScope"], plan["windows"][1]["identityScope"])
        for piece in plan["windows"]:
            self.assertTrue(piece["resetTrackingBefore"])
            self.assertFalse(piece["continuityConfirmed"])
            self.assertEqual(piece["reviewStatus"], "unreviewed")
            self.assertTrue(all(piece["start"] <= row["sourceTime"] < piece["end"] for row in piece["frames"]))
        self.assertEqual(plan["uniqueFrameCount"], 50)

    def test_native_vfr_frames_are_not_interpolated(self):
        data = fixture([0, .03, .12, .9, 1.3, 2, 2.8, 4, 5], cut=None)
        plan = plan_samples(data, [{"start": .01, "end": 1.31}], fps=30)
        frames = plan["windows"][0]["frames"]
        self.assertEqual([f["sourceTime"] for f in frames], [.03, .12, .9, 1.3])
        self.assertAlmostEqual(plan["windows"][0]["maximumSampleGapSeconds"], .78)
        self.assertGreater(max(f["timingErrorSeconds"] for f in frames), .1)

    def test_no_native_frame_does_not_pick_frame_outside_window(self):
        plan = plan_samples(fixture([0, 1, 2, 3, 4, 5], cut=None), [{"start": .2, "end": .3}])
        self.assertEqual(plan["uniqueFrameCount"], 0)
        self.assertEqual(plan["windows"][0]["status"], "no_decoded_frame_in_window")

    def test_same_frame_in_overlapping_windows_uses_one_budget_slot(self):
        plan = plan_samples(fixture(cut=None), [{"start": 0, "end": 1}] * 2, fps=25, max_frames=25)
        self.assertEqual(plan["uniqueFrameCount"], 25)
        self.assertEqual(len({w["identityScope"] for w in plan["windows"]}), 2)

    def test_limits_are_fail_closed_without_silent_truncation(self):
        cases = [([], {}), ([{"start": 0, "end": 1}] * 3, {}),
                 ([{"start": 0, "end": 4.01}], {}), ([{"start": 0, "end": 7}], {}),
                 ([{"start": 0, "end": 1}], {"fps": 0}), ([{"start": 0, "end": 1}], {"fps": True}),
                 ([{"start": 0, "end": 1}], {"max_frames": 1}),
                 ([{"start": float("nan"), "end": 1}], {}), ([{"start": 1, "end": 1}], {})]
        for windows, options in cases:
            with self.subTest(windows=windows, options=options), self.assertRaises(ValueError):
                plan_samples(fixture(), windows, **options)

    def test_corrupt_cut_and_pts_rejected(self):
        for change in (lambda d: d["candidates"][0].update(sourceTime=1.001),
                       lambda d: d["media"]["frameTimes"].__setitem__(3, 0),
                       lambda d: d["media"].update(duration=1)):
            data = fixture()
            change(data)
            with self.assertRaises(ValueError):
                plan_samples(data, [{"start": 0, "end": 1}])

    def test_cut_at_window_start_does_not_add_empty_piece(self):
        plan = plan_samples(fixture(), [{"start": 2, "end": 3}])
        self.assertEqual(len(plan["windows"]), 1)
        self.assertEqual(plan["windows"][0]["candidateSpanIndex"], 1)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class RealDecodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def video(self, colors, name="source.mp4"):
        args = ["ffmpeg", "-nostdin", "-v", "error"]
        for color in colors:
            args += ["-f", "lavfi", "-i", f"color=c={color}:s=320x180:r=25:d=0.4"]
        inputs = "".join(f"[{i}:v]" for i in range(len(colors)))
        args += ["-filter_complex", f"{inputs}concat=n={len(colors)}:v=1:a=0[v]", "-map", "[v]",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", str(self.root / name)]
        subprocess.run(args, check=True, capture_output=True, timeout=30)
        return self.root / name

    def test_real_abrupt_cut_and_one_pass_extraction(self):
        video = self.video(["black", "white"])
        scanned, planned = prepare(video, self.root / "evidence", [{"start": .1, "end": .7}], fps=20, extract=True)
        self.assertEqual(len(scanned["candidates"]), 1)
        self.assertAlmostEqual(scanned["candidates"][0]["sourceTime"], .4)
        self.assertEqual(len(planned["windows"]), 2)
        self.assertEqual(len(list((self.root / "evidence").glob("frame-*.png"))), planned["uniqueFrameCount"])
        self.assertTrue(all(len(f["sha256"]) == 64 for w in planned["windows"] for f in w["frames"]))
        from PIL import Image
        for piece in planned["windows"]:
            for frame in piece["frames"]:
                pixel = Image.open(self.root / "evidence" / frame["image"]).convert("RGB").getpixel((20, 20))
                self.assertTrue(max(pixel) < 10 if frame["sourceTime"] < .4 else min(pixel) > 240,
                                "extracted image must match the assigned decoded source PTS")
        self.assertFalse(planned["semanticRecognition"])
        with self.assertRaisesRegex(ValueError, "immutable"):
            prepare(video, self.root / "evidence", [{"start": 0, "end": .2}])

    def test_flash_is_candidate_never_confirmed_shot(self):
        scanned = scan(self.video(["black", "white", "black"]))
        self.assertEqual(len(scanned["candidates"]), 2)
        self.assertTrue(all(c["reviewStatus"] == "unreviewed" for c in scanned["candidates"]))
        self.assertFalse(scanned["automaticAcceptance"])

    def test_identical_looking_cut_has_no_candidate_and_no_continuity_claim(self):
        scanned = scan(self.video(["black", "black"]))
        self.assertEqual(scanned["candidates"], [])
        planned = plan_samples(scanned, [{"start": .1, "end": .7}])
        self.assertFalse(planned["windows"][0]["continuityConfirmed"])

    def test_actual_variable_frame_rate_media_preserves_gaps(self):
        video = self.root / "vfr.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                        "testsrc2=s=320x180:r=25:d=1.2", "-vf",
                        "select='lt(n,3)+between(n,18,20)+gte(n,28)'", "-fps_mode", "vfr",
                        "-c:v", "libx264", "-bf", "0", "-threads", "1", str(video)], check=True, capture_output=True, timeout=30)
        scanned = scan(video)
        self.assertTrue(scanned["media"]["variableFrameRate"])
        self.assertIn(.72, scanned["media"]["frameTimes"])
        planned = plan_samples(scanned, [{"start": 0, "end": 1.15}], fps=30)
        frames = [f for w in planned["windows"] for f in w["frames"]]
        self.assertTrue(all(f["sourceTime"] in scanned["media"]["frameTimes"] for f in frames))
        self.assertTrue(any(w["maximumSampleGapSeconds"] and w["maximumSampleGapSeconds"] >= .6 for w in planned["windows"]))

    def test_invalid_extraction_plan_leaves_no_partial_evidence(self):
        video = self.video(["black", "white"])
        with self.assertRaises(ValueError):
            prepare(video, self.root / "evidence", [{"start": 0, "end": 5}], extract=True)
        self.assertFalse((self.root / "evidence").exists())
        self.assertEqual(list(self.root.glob(".scene-sampling-*")), [])

    def test_multiple_video_tracks_cannot_mix_pts_and_pixels(self):
        from core.broadcast.common import BroadcastError
        from core.broadcast.media import probe
        primary = self.video(["black", "white"])
        multi = self.root / "multiple.mp4"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(primary),
                        "-f", "lavfi", "-i", "color=c=red:s=640x360:r=25:d=0.8",
                        "-map", "0:v:0", "-map", "1:v:0", "-c:v", "libx264", "-threads", "1",
                        "-disposition:v:0", "0", "-disposition:v:1", "default", str(multi)],
                       check=True, capture_output=True, timeout=30)
        for operation in (lambda: probe(multi), lambda: scan(multi),
                          lambda: prepare(multi, self.root / "evidence", [{"start": .1, "end": .7}], extract=True)):
            with self.assertRaises(BroadcastError) as caught:
                operation()
            self.assertEqual(caught.exception.code, "unsupported_video_tracks")
        self.assertFalse((self.root / "evidence").exists())


if __name__ == "__main__":
    unittest.main()
