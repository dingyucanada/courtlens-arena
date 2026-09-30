"""Real media closure and adversarial Broadcast contract tests."""
import copy
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.service import BroadcastService
from core.broadcast.validation import content_hash, story as validate_story

FFMPEG = os.environ.get("COURTLENS_FFMPEG") or shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


class BroadcastBackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not Path(FFMPEG).is_file() and not shutil.which(FFMPEG):
            raise unittest.SkipTest("ffmpeg is unavailable")
        cls.video_dir = tempfile.TemporaryDirectory()
        cls.video = Path(cls.video_dir.name) / "input.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(cls.video)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.video_dir.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.service = BroadcastService(self.temp.name)
        self.project = self.service.create("测试片", "manual")
        with self.video.open("rb") as source:
            self.project = self.service.upload(self.project["id"], 0, source, self.video.stat().st_size, "input.mp4", "video/mp4")

    def tearDown(self):
        self.temp.cleanup()

    def _accepted(self, kind="movement", start=1.0, end=2.0, frame_ids=None):
        return {"id": "observation1", "type": kind, "start": start, "end": end, "anchorTime": 1.4 if kind == "shot" else None, "segmentId": "s1", "description": "画面中持球人移动", "playerIds": [], "unknownActors": ["持球人"], "frameIds": frame_ids or [], "source": {"kind": "manual", "runId": None, "recordId": None}, "confidence": None, "review": {"status": "accepted", "actor": "人工审核", "reason": "逐帧", "at": "2026-09-30T00:00:00Z"}, "geometry": None}

    def _story(self, p, beat_start=2.0, beat_end=4.0, metric=None, binding_ids=None):
        return {"schema": "courtlens-broadcast-story/1", "title": "故事", "audience": "fan", "sourceRange": {"start": 0, "end": 5}, "beats": [{"id": "b1", "label": "观察", "sourceStart": beat_start, "sourceEnd": beat_end, "anchorTime": beat_start, "observationIds": ["observation1"], "bindingIds": binding_ids or [], "text": "画面中持球人移动" if not metric else "本次指标 {{metric:" + metric + "}}", "explanationKind": "visible-fact" if not metric else "data-fact", "metricRecordId": metric, "secondaryLabel": None, "annotation": None}]}

    def test_model_story_route_is_async_idempotent_and_returns_project_revision(self):
        from core.broadcast.routes import BroadcastRoutes
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self._accepted()]})
        entered, release = threading.Event(), threading.Event()
        def fake_propose(*args):
            entered.set()
            self.assertTrue(release.wait(3))
            return self._story(p), {"provider": "stepfun-step-plan", "modelId": "step-3.7-flash"}
        routes = BroadcastRoutes(self.temp.name)
        body = {"expectedRevision": p["revision"], "audience": "fan", "mode": "model", "providerId": "stepfun-story"}
        with patch.dict(os.environ, {"COURTLENS_STEPFUN_API_KEY": "test-only"}), patch("core.broadcast.providers.story_model.propose", side_effect=fake_propose):
            status, job = routes.dispatch_json("POST", "/api/broadcast/v1/projects/" + p["id"] + "/story", body, {"Idempotency-Key": "same-story"})
            self.assertEqual(status, 202)
            self.assertEqual(job["type"], "model-story")
            self.assertTrue(entered.wait(2))
            repeated_status, repeated = routes.dispatch_json("POST", "/api/broadcast/v1/projects/" + p["id"] + "/story", body, {"Idempotency-Key": "same-story"})
            self.assertEqual(repeated_status, 202)
            self.assertEqual(repeated["id"], job["id"])
            release.set()
            routes.service._threads[job["id"]].join(3)
        finished = routes.service.job(job["id"])
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["result"], {"projectId": p["id"], "projectRevision": p["revision"] + 1})
        self.assertIsNotNone(routes.service.get(p["id"])["story"])
        repeated_status, repeated = routes.dispatch_json("POST", "/api/broadcast/v1/projects/" + p["id"] + "/story", body, {"Idempotency-Key": "same-story"})
        self.assertEqual((repeated_status, repeated["id"], repeated["status"]), (202, job["id"], "succeeded"))

    def test_model_story_cancel_and_stale_revision_never_overwrite(self):
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self._accepted()]})
        from core.broadcast.providers import story_model
        for cancel in (True, False):
            entered, release = threading.Event(), threading.Event()
            def fake_propose(*args):
                entered.set()
                self.assertTrue(release.wait(3))
                return self._story(p), {"provider": "stepfun-step-plan", "modelId": "step-3.7-flash"}
            with patch.dict(os.environ, {"COURTLENS_STEPFUN_API_KEY": "test-only"}), patch.object(story_model, "propose", side_effect=fake_propose):
                job = self.service.start_job(p["id"], p["revision"], "model-story", {"audience": "fan", "providerId": "stepfun-story"})
                self.assertTrue(entered.wait(2))
                if cancel:
                    self.service.cancel(job["id"])
                else:
                    p = self.service.edit(p["id"], p["revision"], {"title": "newer edit"})
                release.set()
                self.service._threads[job["id"]].join(3)
            self.assertEqual(self.service.job(job["id"])["status"], "cancelled" if cancel else "failed")
            self.assertIsNone(self.service.get(p["id"])["story"])

    def test_model_story_cancel_at_draft_write_cannot_resurrect_job(self):
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self._accepted()]})
        original = self.service._write_job
        def write_with_intervening_cancel(project, job):
            if job["stage"] == "draft" and job["status"] == "running":
                self.service.cancel(job["id"])
            return original(project, job)
        with patch.dict(os.environ, {"COURTLENS_STEPFUN_API_KEY": "test-only"}), patch.object(self.service, "_write_job", side_effect=write_with_intervening_cancel), patch("core.broadcast.providers.story_model.propose") as model:
            job = self.service.start_job(p["id"], p["revision"], "model-story", {"audience": "fan", "providerId": "stepfun-story"})
            self.service._threads[job["id"]].join(3)
        self.assertEqual(self.service.job(job["id"])["status"], "cancelled")
        self.assertFalse(model.called)
        self.assertIsNone(self.service.get(p["id"])["story"])

    def _reviewed_event_story(self):
        p = self.service.edit(self.project["id"], self.project["revision"], {"context": {"gameId": "g1"}, "observations": [self._accepted()]})
        bundle = {"schema": "courtlens-metrics/2", "dictionary": {"id": "test", "version": "1", "provenance": {"kind": "synthetic", "source": "test"}, "metrics": {"event": {"version": "1", "label": "示例引力", "role": "gravity", "semantics": "provider_on_ball_gravity_index", "unit": "index", "definition": "示例指数", "granularity": "event", "ballState": "on-ball"}}}, "bindings": {}, "plays": [{"id": "play1", "gameId": "g1", "start": 0, "end": 5}], "records": [{"id": "r-event", "metricId": "event", "value": 1.8, "scope": {"granularity": "event", "playId": "play1", "eventId": "e1"}, "time": {"timeBase": "video", "observedAt": 1, "availableAt": 1, "validFrom": 1, "validTo": 3}}]}
        p = self.service.metrics(p["id"], p["revision"], bundle)
        binding = {"id": "bind1", "observationId": "observation1", "officialEventId": "e1", "shotId": None, "gameId": "g1", "playerId": None, "metricRecordIds": ["r-event"], "timeMapping": {"source": "video", "videoTime": 1.5, "period": None, "clock": None, "mappingEvidenceIds": []}, "status": "confirmed", "reason": "逐帧对齐", "confirmedBy": "审核", "confirmedAt": "2026-09-30T00:00:00Z"}
        p = self.service.edit(p["id"], p["revision"], {"bindings": [binding]})
        story = self._story(p, 2.0, 2.8, "r-event", ["bind1"])
        p = self.service.edit(p["id"], p["revision"], {"story": story})
        return p, binding, story

    def test_context_change_invalidates_old_confirmed_event_binding(self):
        p, binding, story = self._reviewed_event_story()
        p = self.service.edit(p["id"], p["revision"], {"context": {"gameId": "different-game"}})
        self.assertEqual(p["bindings"], [])
        self.assertIsNone(p["story"])
        with self.assertRaises(BroadcastError) as stale_binding:
            self.service.edit(p["id"], p["revision"], {"bindings": [binding]})
        self.assertEqual(stale_binding.exception.code, "unresolved_binding")
        with self.assertRaises(BroadcastError) as stale_story:
            self.service.edit(p["id"], p["revision"], {"story": story})
        self.assertEqual(stale_story.exception.code, "unresolved_binding")

    def test_review_and_render_reject_legacy_stale_game_binding(self):
        p, _, _ = self._reviewed_event_story()
        checks = {key: True for key in ("identity", "timing", "metrics", "wording", "geometry")}
        p = self.service.review(p["id"], p["revision"], "审核", checks, "")
        stale = copy.deepcopy(p)
        stale["context"]["gameId"] = "different-game"
        stale["review"]["contentHash"] = content_hash(stale)
        self.service.store.write(stale)  # Simulates a stale snapshot made by an older release.
        with self.assertRaises(BroadcastError) as review_error:
            self.service.review(stale["id"], stale["revision"], "审核", checks, "")
        self.assertEqual(review_error.exception.code, "unresolved_binding")
        with self.assertRaises(BroadcastError) as render_error:
            self.service.start_job(stale["id"], stale["revision"], "render", {"voiceMode": "silent", "voiceId": None})
        self.assertEqual(render_error.exception.code, "unresolved_binding")

    def test_roster_cannot_drop_player_still_named_by_observation(self):
        player = {"id": "p1", "name": "甲", "teamId": "t1", "jersey": None, "source": "人工", "validOn": None}
        observation = self._accepted()
        observation["playerIds"] = ["p1"]
        observation["unknownActors"] = []
        p = self.service.edit(self.project["id"], self.project["revision"], {"context": {"roster": [player]}, "observations": [observation]})
        with self.assertRaises(BroadcastError) as invalid:
            self.service.edit(p["id"], p["revision"], {"context": {"roster": []}})
        self.assertEqual(invalid.exception.code, "schema_invalid")
        self.assertEqual(len(self.service.get(p["id"])["context"]["roster"]), 1)

    def test_ai_review_never_claims_human_verification(self):
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self._accepted()]})
        p = self.service.edit(p["id"], p["revision"], {"story": self._story(p)})
        checks = {key: True for key in ("identity", "timing", "metrics", "wording", "geometry")}
        p = self.service.review(p["id"], p["revision"], "Codex AI visual review", checks, "Independent source-frame review", reviewer_type="ai")
        self.assertEqual(p["review"]["reviewerType"], "ai")
        self.assertFalse(self.service._understanding(p)["humanReviewed"])
        with self.assertRaises(BroadcastError):
            self.service.review(p["id"], p["revision"], "Agent", checks, "", reviewer_type="robot")

    def test_release_background_keeps_only_referenced_pbp_and_roster(self):
        from core.broadcast.render import background_evidence
        p = copy.deepcopy(self.project)
        p["context"].update({"gameId": "g1", "roster": [{"id": "p1", "name": "甲", "source": "same-game roster"}, {"id": "p2", "name": "乙"}],
            "playByPlay": {"source": {"provider": "fixture", "gameId": "g1", "url": "https://example.org/g1"},
                "entries": [{"id": "e1", "period": 1, "clock": "11:40", "text": "甲得分"}, {"id": "e2", "text": "later event"}]}})
        o = self._accepted()
        o["playerIds"] = ["p1"]
        o["source"].update({"kind": "model", "recordId": "e1"})
        p["observations"] = [o]
        result = background_evidence(p, {o["id"]})
        self.assertEqual([r["id"] for r in result["roster"]], ["p1"])
        self.assertEqual([r["id"] for r in result["playByPlay"]["entries"]], ["e1"])
        self.assertEqual(result["playByPlay"]["source"]["url"], "https://example.org/g1")
        self.assertEqual(len(result["playByPlay"]["importSha256"]), 64)
        self.assertEqual(background_evidence(p, set())["playByPlay"]["entries"], [])

    def test_real_mp4_frame_hash_restart_review_and_old_release(self):
        p = self.project
        self.assertEqual(p["media"]["sha256"], __import__("hashlib").sha256(self.video.read_bytes()).hexdigest())
        frame = self.service.frames(p["id"], p["revision"], [1.4])["frames"][0]
        arrow_frame = self.service.frames(p["id"], p["revision"], [2.0])["frames"][0]
        self.assertAlmostEqual(frame["actualTime"], 1.4)
        obs = self._accepted("shot", 1, 3, [frame["id"], arrow_frame["id"]])
        obs["geometry"] = {"space": "screen-normalized", "points": [{"x": .1, "y": .7}, {"x": .8, "y": .2}], "validFrom": 1.4, "validTo": 3, "segmentId": "s1"}
        p = self.service.edit(p["id"], p["revision"], {"observations": [obs]})
        s = self._story(p)
        s["beats"][0]["annotation"] = {"id": "arrow1", "points": obs["geometry"]["points"], "sourceObservationId": obs["id"], "confirmedBy": "人工审核", "confirmedAt": "2026-09-30T00:00:00Z"}
        p = self.service.edit(p["id"], p["revision"], {"story": s})
        p = self.service.review(p["id"], p["revision"], "人工审核", {key: True for key in ("identity", "timing", "metrics", "wording", "geometry")}, "")
        j = self.service.start_job(p["id"], p["revision"], "render", {"voiceMode": "silent", "voiceId": None})
        self.service._threads[j["id"]].join(30)
        j = self.service.job(j["id"])
        self.assertEqual(j["status"], "succeeded", j["error"])
        release = self.service.release(j["resultId"])
        self.assertEqual(release["manifest"]["source"]["kind"], "user-provided")
        self.assertIn("background", release["manifest"]["evidence"])
        self.assertEqual(len(release["manifest"]["renderer"]["sourceFingerprint"]), 64)
        self.assertEqual(release["manifest"]["compiledBeats"][0]["compiledText"], s["beats"][0]["text"])
        self.assertEqual(release["summary"]["understanding"]["mode"], "manual")
        restarted = BroadcastService(self.temp.name)
        self.assertEqual(restarted.get(p["id"])["revision"], p["revision"])
        changed = restarted.edit(p["id"], p["revision"], {"title": "新标题"})
        self.assertIsNone(changed["review"])
        self.assertEqual(restarted.release(j["resultId"])["summary"]["contentHash"], release["summary"]["contentHash"])

    def test_bad_shapes_and_fake_checks_rejected(self):
        p = self.project
        for malformed in (None, "bad", [12], {"id": "x"}):
            with self.subTest(malformed=malformed), self.assertRaises(BroadcastError):
                self.service.edit(p["id"], p["revision"], {"observations": malformed})
        p = self.service.edit(p["id"], p["revision"], {"observations": [self._accepted()]})
        p = self.service.edit(p["id"], p["revision"], {"story": self._story(p)})
        with self.assertRaises(BroadcastError) as caught:
            self.service.review(p["id"], p["revision"], "审核人", {key: "false" for key in ("identity", "timing", "metrics", "wording", "geometry")}, "")
        self.assertEqual(caught.exception.code, "review_required")

    def test_unsupported_numeric_and_outcome_claims_cannot_be_reviewed(self):
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self._accepted()]})
        for text in ("持球人移动了99次", "命中概率百分之九十九", "Gravity 99.9，显著拉开空间", "防守人距离九米", "这次投篮命中", "球员打铁"):
            with self.subTest(text=text), self.assertRaises(BroadcastError):
                s = self._story(p)
                s["beats"][0]["text"] = text
                self.service.edit(p["id"], p["revision"], {"story": s})
        for field in ("label", "secondaryLabel"):
            with self.subTest(field=field), self.assertRaises(BroadcastError):
                s = self._story(p)
                s["beats"][0][field] = "GRAV 9.9"
                self.service.edit(p["id"], p["revision"], {"story": s})

    def test_result_evidence_and_referenced_jersey_are_distinct_from_metrics(self):
        row = self._accepted(kind="result")
        row["description"] = "球员投篮命中"
        row["playerIds"] = ["player23"]
        player = {"id": "player23", "name": "测试球员", "teamId": "t1", "jersey": "23", "source": "测试名单", "validOn": None}
        p = self.service.edit(self.project["id"], self.project["revision"], {"context": {"roster": [player]}, "observations": [row]})
        s = self._story(p)
        s["beats"][0]["text"] = "23号球员投篮命中"
        p = self.service.edit(p["id"], p["revision"], {"story": s})
        self.assertEqual(p["story"]["beats"][0]["text"], "23号球员投篮命中")
        s["beats"][0]["text"] = "24号球员投篮命中"
        with self.assertRaises(BroadcastError):
            self.service.edit(p["id"], p["revision"], {"story": s})

    def test_ordinary_narration_is_not_a_measured_count(self):
        from core.broadcast.validation import grounded_wording
        grounded_wording("这一次进攻，持球人沿边线移动", [self._accepted()], [])
        grounded_wording("持球人切入三秒区，为二次进攻做好准备", [self._accepted()], [])
        row = self._accepted()
        row["description"] = "白色23号球员沿边线运球"
        grounded_wording("白色23号球员沿边线运球", [row], [])
        with self.assertRaises(BroadcastError):
            grounded_wording("球员连续移动十一次", [self._accepted()], [])

    def test_nested_contract_shapes_and_duplicate_roster_rejected(self):
        p = self.project
        base = self._accepted()
        bad = []
        for key in ("anchorTime", "geometry", "review", "source", "frameIds"):
            row = copy.deepcopy(base)
            row.pop(key)
            bad.append(row)
        row = copy.deepcopy(base)
        row["geometry"] = {"space": "screen-normalized", "points": [{"x": .1, "y": .2}, {"x": .9, "y": .8}], "validFrom": "1", "validTo": 2, "segmentId": "s1"}
        bad.append(row)
        row = copy.deepcopy(base)
        row["unexpected"] = True
        bad.append(row)
        row = copy.deepcopy(base)
        row["review"]["actor"] = {"name": "fake"}
        bad.append(row)
        for observation in bad:
            with self.subTest(observation=observation), self.assertRaises(BroadcastError) as caught:
                self.service.edit(p["id"], p["revision"], {"observations": [observation]})
            self.assertEqual(caught.exception.code, "schema_invalid")
        player = {"id": "p1", "name": "甲", "teamId": "t1", "jersey": None, "source": "人工", "validOn": None}
        with self.assertRaises(BroadcastError):
            self.service.edit(p["id"], p["revision"], {"context": {"roster": [player, player]}})
        p = self.service.edit(p["id"], p["revision"], {"observations": [base]})
        story = self._story(p)
        story["beats"][0]["secondaryLabel"] = {"fake": "label"}
        with self.assertRaises(BroadcastError) as caught:
            self.service.edit(p["id"], p["revision"], {"story": story})
        self.assertEqual(caught.exception.code, "schema_invalid")

    def test_import_cannot_claim_paid_model_or_verified_media(self):
        p = self.project
        observation = self._accepted()
        observation["source"] = {"kind": "model", "runId": "fake", "recordId": None}
        package = {"schema": "courtlens-observations/1", "mediaSha256": p["media"]["sha256"], "providerRun": {"mode": "video-model", "provider": "fake"}, "observations": [observation]}
        p = self.service.import_observations(p["id"], p["revision"], package)
        self.assertEqual(p["observations"][0]["source"]["kind"], "manual")
        with self.assertRaises(BroadcastError):
            self.service.edit(p["id"], p["revision"], {"source": {"verified": True}})

    def test_valid_time_expiry_and_season_binding_rejected(self):
        p = self.service.edit(self.project["id"], self.project["revision"], {"context": {"gameId": "g1"}, "observations": [self._accepted()]})
        bundle = {"schema": "courtlens-metrics/2", "dictionary": {"id": "test", "version": "1", "provenance": {"kind": "synthetic", "source": "test"}, "metrics": {"event": {"version": "1", "label": "示例引力", "role": "gravity", "semantics": "provider_on_ball_gravity_index", "unit": "index", "definition": "示例指数", "granularity": "event", "ballState": "on-ball"}, "season": {"version": "1", "label": "季统计", "role": "context", "semantics": "season_total", "unit": "index", "definition": "示例赛季", "granularity": "season"}}}, "bindings": {}, "plays": [{"id": "play1", "gameId": "g1", "start": 0, "end": 5}], "records": [{"id": "r-event", "metricId": "event", "value": 1.8, "scope": {"granularity": "event", "playId": "play1", "eventId": "e1"}, "time": {"timeBase": "video", "observedAt": 1, "availableAt": 1, "validFrom": 1, "validTo": 3}}, {"id": "r-season", "metricId": "season", "value": 39.6, "scope": {"granularity": "season", "seasonId": "season1", "playerId": "p1"}, "aggregation": {"start": "season-start", "end": "today", "label": "season"}, "time": {"timeBase": "video", "observedAt": None, "availableAt": 0}}]}
        p = self.service.metrics(p["id"], p["revision"], bundle)
        mapping = {"source": "video", "videoTime": 1.5, "period": None, "clock": None, "mappingEvidenceIds": []}
        binding = {"id": "bind1", "observationId": "observation1", "officialEventId": "e1", "shotId": None, "gameId": "g1", "playerId": None, "metricRecordIds": ["r-season"], "timeMapping": mapping, "status": "confirmed", "reason": "人工对齐", "confirmedBy": "审核", "confirmedAt": "2026-09-30T00:00:00Z"}
        with self.assertRaises(BroadcastError):
            self.service.edit(p["id"], p["revision"], {"bindings": [binding]})
        binding["metricRecordIds"] = ["r-event"]
        p = self.service.edit(p["id"], p["revision"], {"bindings": [binding]})
        with self.assertRaises(BroadcastError):
            self.service.edit(p["id"], p["revision"], {"story": self._story(p, 3.2, 4, "r-event", ["bind1"])})

    def test_bedrock_stub_sends_real_video_and_frame_bytes(self):
        """Protocol test only; this does not establish AWS model access."""
        from core.broadcast.providers.bedrock import execute_bedrock
        p = self.project
        captured = []
        class FakeClient:
            def converse(self, **kwargs):
                captured.append(kwargs)
                if len(captured) == 1:
                    self_test.assertIn("video", kwargs["messages"][0]["content"][1])
                    self_test.assertEqual(kwargs["messages"][0]["content"][1]["video"]["source"]["bytes"][:4], self_test.video.read_bytes()[:4])
                    return {"output": {"message": {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "inspect_frames", "input": {"times": [1.4]}}}]}}, "usage": {}}
                result = kwargs["messages"][-1]["content"][0]["toolResult"]
                self_test.assertTrue(any("image" in x and x["image"]["source"]["bytes"] for x in result["content"]))
                fid = json.loads(result["content"][0]["text"])["frames"][0]["id"]
                text = json.dumps({"observations": [{"type": "shot", "start": 1.2, "end": 1.7, "anchorTime": 1.4, "segmentId": "s1", "description": "候选出手", "playerIds": [], "unknownActors": [], "frameIds": [fid], "confidence": .5}]})
                return {"output": {"message": {"role": "assistant", "content": [{"text": text}]}}, "usage": {}}
        class FakeBoto:
            @staticmethod
            def client(*args, **kwargs):
                return FakeClient()
        class FakeConfig:
            def __init__(self, **kwargs):
                pass
        import types
        self_test = self
        with patch.dict(sys.modules, {"boto3": FakeBoto, "botocore": types.ModuleType("botocore"), "botocore.config": types.SimpleNamespace(Config=FakeConfig)}), patch.dict(os.environ, {"COURTLENS_SEMANTIC_MODEL_ID": "test-model", "COURTLENS_BEDROCK_REGION": "us-east-1"}):
            run = execute_bedrock(self.service, p, {"id": "jobstub"}, {"providerId": "bedrock-video", "scope": {"start": 0, "end": 5}, "strategy": "video-first"})
        self.assertEqual(run["providerRun"]["mode"], "video-model")
        self.assertEqual(len(run["observations"][0]["frameIds"]), 1)
        self.assertEqual(run["observations"][0]["review"]["status"], "unreviewed")

    def test_model_story_stub_rejects_future_ref_then_retries(self):
        """Text model proposes wording; server rejects invented evidence and never approves."""
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self._accepted()]})
        calls = []
        class FakeClient:
            def converse(self, **kwargs):
                calls.append(kwargs)
                beat = self_test._story(p)["beats"][0]
                beat.pop("id")
                if len(calls) == 1:
                    beat["observationIds"] = ["invented"]
                return {"output": {"message": {"role": "assistant", "content": [{"text": json.dumps({"title": "提议", "beats": [beat]})}]}}, "usage": {"outputTokens": 20}}
        class FakeBoto:
            @staticmethod
            def client(*args, **kwargs):
                return FakeClient()
        class FakeConfig:
            def __init__(self, **kwargs):
                pass
        import types
        self_test = self
        with patch.dict(sys.modules, {"boto3": FakeBoto, "botocore": types.ModuleType("botocore"), "botocore.config": types.SimpleNamespace(Config=FakeConfig)}), patch.dict(os.environ, {"COURTLENS_STORY_MODEL_ID": "story-test", "COURTLENS_BEDROCK_REGION": "us-east-1"}):
            p = self.service.model_story(p["id"], p["revision"], "fan", "bedrock-story")
        self.assertEqual(len(calls), 2)
        self.assertIsNone(p["review"])
        self.assertEqual(p["story"]["beats"][0]["observationIds"], ["observation1"])

    def test_external_voice_protocols_and_measured_stub_audio(self):
        """HTTP shape and AAC mux are tested with fake bytes, not paid TTS calls."""
        from core.broadcast.providers import voice
        mp3 = Path(self.temp.name) / "stub.mp3"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000", "-t", "0.7", "-c:a", "libmp3lame", "-y", str(mp3)], check=True)
        sound = mp3.read_bytes()
        class Response:
            def __init__(self, kind, body):
                self.headers = {"Content-Type": kind, "Content-Length": str(len(body))}
                self.body = body
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, count):
                return self.body[:count]
        class Opener:
            def open(self, request, timeout):
                body = json.loads(request.data)
                self_test.assertEqual(request.get_header("Authorization"), "Bearer dummy-secret")
                self_test.assertEqual(timeout, 20)
                if "minimax" in request.full_url:
                    self_test.assertEqual(request.full_url, "https://api.minimax.io/v1/t2a_v2")
                    self_test.assertEqual(body["output_format"], "hex")
                    self_test.assertEqual(body["voice_setting"]["voice_id"], "approved-voice")
                    return Response("application/json", json.dumps({"base_resp": {"status_code": 0}, "data": {"audio": sound.hex()}}).encode())
                self_test.assertEqual(request.full_url, "https://api.stepfun.com/v1/audio/speech")
                self_test.assertEqual(body["response_format"], "mp3")
                self_test.assertEqual(body["voice"], "approved-voice")
                return Response("audio/mpeg", sound)
        self_test = self
        with patch("urllib.request.build_opener", return_value=Opener()), patch.dict(os.environ, {"COURTLENS_MINIMAX_API_KEY": "dummy-secret", "COURTLENS_MINIMAX_MODEL": "approved-model", "COURTLENS_MINIMAX_VOICE_ID": "approved-voice", "COURTLENS_STEPFUN_API_KEY": "dummy-secret", "COURTLENS_STEPFUN_MODEL": "approved-model", "COURTLENS_STEPFUN_VOICE_ID": "approved-voice", "COURTLENS_STEPFUN_API_VARIANT": "openapi"}):
            self.assertEqual(voice._external_audio("minimax", "测试语音", "approved-voice"), sound)
            self.assertEqual(voice._external_audio("stepfun", "测试语音", "approved-voice"), sound)
            audible_source = Path(self.temp.name) / "audible.mp4"
            subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=700:sample_rate=24000", "-t", "5", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", str(audible_source)], check=True)
            p = self.service.create("有原声片", "manual")
            with audible_source.open("rb") as source:
                p = self.service.upload(p["id"], p["revision"], source, audible_source.stat().st_size, "audible.mp4", "video/mp4")
            self.assertTrue(p["media"]["hasAudio"])
            p = self.service.edit(p["id"], p["revision"], {"observations": [self._accepted()]})
            p = self.service.edit(p["id"], p["revision"], {"story": self._story(p)})
            p = self.service.review(p["id"], p["revision"], "审核人", {key: True for key in ("identity", "timing", "metrics", "wording", "geometry")}, "")
            with self.assertRaises(BroadcastError):
                self.service.start_job(p["id"], p["revision"], "render", {"voiceMode": "local-tts", "voiceId": "approved-voice"})
            job = self.service.start_job(p["id"], p["revision"], "render", {"voiceMode": "stepfun", "voiceId": "approved-voice"})
            self.service._threads[job["id"]].join(30)
            done = self.service.job(job["id"])
            self.assertEqual(done["status"], "succeeded", done["error"])
            release = self.service.release(done["resultId"])
            self.assertEqual(release["summary"]["voice"]["mode"], "stepfun")
            self.assertEqual(release["summary"]["voice"]["voiceId"], "approved-voice")
            self.assertGreater(release["manifest"]["voiceReport"]["cues"][0]["speechDuration"], 0)
            film = self.service.store.find("releases", done["resultId"]) / "film.mp4"
            before_narration = subprocess.run([FFMPEG, "-v", "error", "-nostdin", "-i", str(film), "-t", "0.8", "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "24000", "-"], capture_output=True, check=True).stdout
            self.assertGreater(max(abs(x) for x in __import__("struct").unpack("<" + "h" * (len(before_narration) // 2), before_narration)), 100)

    def test_stepfun_two_fixed_api_variants_and_unknown_rejected(self):
        from core.broadcast.providers import voice
        audio = b"ID3fixture"
        env = {"COURTLENS_STEPFUN_API_KEY": "fake-only", "COURTLENS_STEPFUN_MODEL": "fixture-model", "COURTLENS_STEPFUN_VOICE_ID": "fixture-voice"}
        for variant, expected in (("openapi", "https://api.stepfun.com/v1/audio/speech"),
                                  ("step-plan", "https://api.stepfun.com/step_plan/v1/audio/speech")):
            with self.subTest(variant=variant), patch.dict(os.environ, {**env, "COURTLENS_STEPFUN_API_VARIANT": variant}), \
                 patch.object(voice, "_post_audio", return_value=("audio/mpeg", audio)) as post:
                self.assertEqual(voice.configured_voice("stepfun"), "fixture-voice")
                self.assertEqual(voice._external_audio("stepfun", "测试", "fixture-voice"), audio)
                self.assertEqual(post.call_args.args[0], expected)
        with patch.dict(os.environ, {**env, "COURTLENS_STEPFUN_API_VARIANT": "https://untrusted.example"}), \
             patch.object(voice, "_post_audio") as post:
            with self.assertRaises(BroadcastError) as invalid:
                voice.configured_voice("stepfun")
            self.assertEqual(invalid.exception.code, "voice_unavailable")
            with self.assertRaises(BroadcastError):
                voice._external_audio("stepfun", "测试", "fixture-voice")
            post.assert_not_called()

    def test_cloud_agentcore_story_is_draft_and_rejects_invented_evidence(self):
        """A fixed AgentCore handoff cannot bypass server evidence/revision checks."""
        from core.broadcast.cloud_worker import run as run_cloud
        from core.broadcast.validation import content_hash
        from core.broadcast.common import now
        import hashlib
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self._accepted()]})
        beat = self._story(p)["beats"][0]
        beat.pop("id")
        fixed = self.service.store.project_dir(p["id"]) / "agentcore-story.json"
        def handoff(observation_id):
            candidate = copy.deepcopy(beat)
            candidate["observationIds"] = [observation_id]
            raw = json.dumps({"title": "候选故事", "beats": [candidate]}, ensure_ascii=False)
            fixed.write_text(json.dumps({"rawProposal": raw, "runtimeArn": "arn:fixture:agentcore", "modelId": "stub-model", "requestHash": "a" * 64, "responseHash": hashlib.sha256(raw.encode()).hexdigest(), "inputRevision": p["revision"], "projectContentHash": content_hash(p), "mediaSha256": p["media"]["sha256"], "invokedAt": now(), "usage": {}, "requestId": "fixture"}))
        request = {"projectId": p["id"], "expectedRevision": p["revision"], "jobType": "model-story", "options": {"audience": "fan", "providerId": "agentcore-story"}}
        with patch.dict(os.environ, {"AGENT_RUNTIME_ARN": "arn:fixture:agentcore"}):
            handoff("invented")
            rejected = run_cloud(request, self.temp.name)
            self.assertEqual(rejected["job"]["status"], "failed")
            self.assertEqual(self.service.get(p["id"])["revision"], p["revision"])
            handoff("observation1")
            accepted = run_cloud(request, self.temp.name)
            self.assertEqual(accepted["job"]["status"], "succeeded", accepted["job"]["error"])
            self.assertEqual(accepted["result"], {"projectId": p["id"], "projectRevision": p["revision"] + 1})
            current = self.service.get(p["id"])
            self.assertIsNone(current["review"])
            self.assertEqual(current["story"]["beats"][0]["observationIds"], ["observation1"])
            self.assertFalse(fixed.exists())

    def test_approved_cv_fixture_command_executes_and_stays_unreviewed(self):
        script = Path(self.temp.name) / "cv-fixture"
        script.write_text("""#!/usr/bin/env python3
import json,sys
if '--capabilities' in sys.argv:
 print(json.dumps({'schema':'courtlens-cv-capabilities/1','providerId':'fixture-basic','version':'1','available':True,'model':{'name':'fixture','weightsSha256':'0'*64,'weightsPresent':True},'tasks':['detect','track'],'reasonCode':None}))
else:
 request=json.load(open(sys.argv[sys.argv.index('--request')+1]))
 result={'schema':'courtlens-cv-result/1','mediaSha256':request['media']['sha256'],'provider':{'id':'fixture-basic','version':'1','weightsSha256':'0'*64},'samples':[{'frameTime':1.5,'segmentId':'s1','objects':[{'trackId':'t1','classId':'person','score':.7,'bbox':[.2,.2,.2,.3],'jerseyText':None,'jerseyScore':None,'keypoints':[]}]}],'events':[{'type':'movement','start':1.2,'end':1.8,'confidence':.6,'trackIds':['t1']}],'diagnostics':{'framesProcessed':1,'elapsedMs':1}}
 json.dump(result,open(sys.argv[sys.argv.index('--output')+1],'w'))
""")
        script.chmod(0o700)
        p = self.project
        with patch.dict(os.environ, {"COURTLENS_CV_COMMAND": str(script)}):
            self.assertFalse(next(x for x in self.service.capabilities()["providers"] if x["id"] == "cv-command")["available"])
            job = self.service.start_job(p["id"], p["revision"], "cv", {"providerId": "cv-command", "scope": {"start": 1, "end": 2}})
            self.service._threads[job["id"]].join(20)
        job = self.service.job(job["id"])
        self.assertEqual(job["status"], "succeeded", job["error"])
        updated = self.service.get(p["id"])
        self.assertEqual(updated["observations"][0]["source"]["kind"], "cv")
        self.assertEqual(updated["observations"][0]["review"]["status"], "unreviewed")


if __name__ == "__main__":
    unittest.main()
