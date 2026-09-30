"""Synthetic metric fixtures through a real media, binding, review and render pipeline."""
import copy
import subprocess
import tempfile
import unittest
from pathlib import Path

from core.broadcast.common import BroadcastError
from core.broadcast.media import FFMPEG, FFPROBE
from core.broadcast.service import BroadcastService


CASES = (
    ("xfg-percent", "difficulty", "xfg_probability", "percent", None, 62.5, "62.5%"),
    ("xfg-probability", "difficulty", "xfg_probability", "probability", None, .625, "62.5%"),
    ("gravity-on", "gravity", "provider_on_ball_gravity_index", "index", "on-ball", 1.8, "1.8 index"),
    ("gravity-off", "gravity", "provider_off_ball_gravity_index", "index", "off-ball", -.7, "-0.7 index"),
    ("lvg-custom", "leverage", "provider_lvg_fixture_score", "lvg-score", None, -1.75, "-1.75 lvg-score"),
)


class MetricReleaseIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.video_dir = tempfile.TemporaryDirectory()
        cls.video = Path(cls.video_dir.name) / "synthetic-source.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(cls.video)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.video_dir.cleanup()

    def _base(self, workspace, case):
        name, role, semantics, unit, ball_state, value, _ = case
        service = BroadcastService(workspace)
        project = service.create("合成联调，非 NBA 官方数据", "assisted")
        with self.video.open("rb") as source:
            project = service.upload(project["id"], project["revision"], source, self.video.stat().st_size, "synthetic-source.mp4", "video/mp4")
        observation = {"id": "observation1", "type": "shot" if name.startswith("xfg") else "movement", "start": 1.0, "end": 1.8,
                       "anchorTime": 1.5 if name.startswith("xfg") else None, "segmentId": "segment1", "description": "合成片中可见示例动作。",
                       "playerIds": [], "unknownActors": ["示例人物"], "frameIds": [], "source": {"kind": "manual", "runId": None, "recordId": None},
                       "confidence": None, "review": {"status": "accepted", "actor": "synthetic fixture", "reason": "test only", "at": "2026-09-30T00:00:00Z"}, "geometry": None}
        project = service.edit(project["id"], project["revision"], {"context": {"gameId": "synthetic-game"}, "observations": [observation]})
        granularity = "shot" if name.startswith("xfg") else "event"
        entry = {"version": "test-1", "label": "合成 " + name, "role": role, "semantics": semantics, "unit": unit,
                 "definition": "Synthetic fixture value; not official NBA data.", "granularity": granularity}
        if ball_state:
            entry["ballState"] = ball_state
        if name.startswith("xfg"):
            entry["range"] = [0, 100] if unit == "percent" else [0, 1]
        elif name.startswith("gravity"):
            entry["range"] = [-5, 5]
        else:
            entry["range"] = [-10, 10]
        scope = {"granularity": granularity, "playId": "synthetic-play", "shotId" if granularity == "shot" else "eventId": "synthetic-shot" if granularity == "shot" else "synthetic-event"}
        record = {"id": "synthetic-record", "metricId": name, "value": value, "scope": scope,
                  "time": {"timeBase": "video", "observedAt": 1.5, "availableAt": 1.8, "validFrom": 1.8, "validTo": 3.0},
                  "provenance": {"kind": "synthetic", "source": "test fixture: " + name}}
        bundle = {"schema": "courtlens-metrics/2", "dictionary": {"id": "synthetic-test", "version": "test-1", "provenance": {"kind": "synthetic", "source": "test fixtures only"}, "metrics": {name: entry}},
                  "bindings": {}, "plays": [{"id": "synthetic-play", "gameId": "synthetic-game", "start": 0, "end": 5,
                                               **({"shotId": "synthetic-shot", "shotTime": 1.5} if granularity == "shot" else {})}], "records": [record]}
        return service, project, bundle

    def _bind(self, service, project, granularity):
        binding = {"id": "synthetic-binding", "observationId": "observation1", "officialEventId": "synthetic-event" if granularity == "event" else None,
                   "shotId": "synthetic-shot" if granularity == "shot" else None, "gameId": "synthetic-game", "playerId": None,
                   "metricRecordIds": ["synthetic-record"], "timeMapping": {"source": "video", "videoTime": 1.5, "period": None, "clock": None, "mappingEvidenceIds": []},
                   "status": "confirmed", "reason": "synthetic event aligned to the fixture clip", "confirmedBy": "synthetic fixture", "confirmedAt": "2026-09-30T00:00:00Z"}
        return service.edit(project["id"], project["revision"], {"bindings": [binding]})

    @staticmethod
    def _story():
        return {"schema": "courtlens-broadcast-story/1", "title": "合成联调，非 NBA 官方数据", "audience": "fan", "commentaryStyle": "zh-analysis",
                "sourceRange": {"start": 0, "end": 5}, "beats": [{"id": "synthetic-beat", "label": "合成指标", "sourceStart": 2.0, "sourceEnd": 2.8,
                "anchorTime": 2.0, "observationIds": ["observation1"], "bindingIds": ["synthetic-binding"],
                "text": "合成值 {{metric:synthetic-record}}", "explanationKind": "data-fact", "metricRecordId": "synthetic-record", "secondaryLabel": None, "annotation": None}]}

    def test_five_units_compile_after_confirmed_binding_and_ai_review(self):
        for case in CASES:
            with self.subTest(metric=case[0]), tempfile.TemporaryDirectory() as workspace:
                service, project, bundle = self._base(workspace, case)
                project = service.metrics(project["id"], project["revision"], bundle)
                project = self._bind(service, project, bundle["records"][0]["scope"]["granularity"])
                project = service.edit(project["id"], project["revision"], {"story": self._story()})
                project = service.review(project["id"], project["revision"], "synthetic AI fixture", {key: True for key in ("identity", "timing", "metrics", "wording", "geometry")}, "test only", reviewer_type="ai")
                job = service.start_job(project["id"], project["revision"], "render", {"voiceMode": "silent", "voiceId": None})
                service._threads[job["id"]].join(30)
                done = service.job(job["id"])
                self.assertEqual(done["status"], "succeeded", done.get("error"))
                release = service.release(done["resultId"])
                self.assertIn("合成联调，非 NBA 官方数据", release["manifest"]["story"]["title"])
                self.assertEqual(release["manifest"]["evidence"]["metrics"]["dictionary"]["provenance"]["kind"], "synthetic")
                film = service.store.find("releases", done["resultId"]) / "film.mp4"
                self.assertGreater(film.stat().st_size, 0)
                probe = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", str(film)], check=True, capture_output=True, text=True)
                self.assertEqual(probe.stdout.strip(), "h264")
                compiled = release["manifest"]["compiledBeats"][0]
                self.assertEqual(compiled["metric"]["value"], case[6])
                self.assertEqual(compiled["compiledText"], "合成值 " + case[6])
                self.assertEqual(compiled["metric"]["source"], "test fixture: " + case[0])
                self.assertEqual(release["manifest"]["review"]["reviewerType"], "ai")
                if case[0] == "lvg-custom":
                    self.assertNotIn("%", compiled["compiledText"])

    def test_missing_null_and_unbound_values_are_rejected(self):
        case = CASES[2]
        with tempfile.TemporaryDirectory() as workspace:
            service, project, bundle = self._base(workspace, case)
            missing = copy.deepcopy(bundle)
            del missing["records"][0]["value"]
            with self.assertRaises(BroadcastError):
                service.metrics(project["id"], project["revision"], missing)
            null = copy.deepcopy(bundle)
            null["records"][0]["value"] = None
            project = service.metrics(project["id"], project["revision"], null)
            project = self._bind(service, project, "event")
            with self.assertRaises(BroadcastError) as exc:
                service.edit(project["id"], project["revision"], {"story": self._story()})
            self.assertEqual(exc.exception.code, "unresolved_binding")
        with tempfile.TemporaryDirectory() as workspace:
            service, project, bundle = self._base(workspace, case)
            project = service.metrics(project["id"], project["revision"], bundle)
            with self.assertRaises(BroadcastError) as exc:
                service.edit(project["id"], project["revision"], {"story": self._story()})
            self.assertEqual(exc.exception.code, "unresolved_binding")


if __name__ == "__main__":
    unittest.main()
