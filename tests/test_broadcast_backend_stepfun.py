"""Fixed Step Plan transport and real-frame evidence without paid network calls."""
import base64
import io
import json
import os
import re
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from core.broadcast.common import BroadcastError
from core.broadcast.providers import capabilities, check_configured, voice_fingerprint
from core.broadcast.providers import stepfun
from core.broadcast.service import BroadcastService, validate_play_by_play
from core.broadcast.store import BroadcastStore


class FakeStore:
    def __init__(self, root):
        self.root = Path(root)

    def find(self, kind, fid):
        return self.root / kind / fid

    def project_dir(self, project_id):
        return self.root / project_id

    atomic = staticmethod(BroadcastStore.atomic)


class FakeService:
    def __init__(self, root):
        self.store = FakeStore(root)
        self.calls = []

    def frames(self, project_id, revision, times):
        self.calls.append((project_id, revision, times))
        frames = []
        for index, actual in enumerate(times):
            fid = f"{index + 1:032x}"
            folder = self.store.find("frames", fid)
            folder.mkdir(parents=True, exist_ok=True)
            picture = Image.new("RGB", (640, 360), (index * 24, 40, 100))
            picture.save(folder / "frame.png")
            frames.append({"id": fid, "actualTime": actual, "sha256": "a" * 64})
        return {"frames": frames}

    def media_path(self, project):
        return Path(self.store.root) / "source.mp4"


def project(duration=8):
    return {"id": "a" * 32, "revision": 1, "media": {"sha256": "b" * 64, "duration": duration},
            "context": {"roster": []}, "observations": [], "bindings": [], "metrics": None}


class StepFunTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.service = FakeService(self.temporary.name)
        self.env = patch.dict(os.environ, {"COURTLENS_STEPFUN_API_KEY": "placeholder-test-only", "COURTLENS_STEPFUN_VISION_MODEL": "step-3.7-flash", "COURTLENS_STEPFUN_STORY_MODEL": "step-3.7-flash"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_video_first_sends_moving_mp4_then_targeted_source_frames(self):
        calls = []

        def fake_chat(kind, content, **kwargs):
            calls.append(content)
            prompt = next(item["text"] for item in content if item["type"] == "text")
            self.assertIn(stepfun.RESULT_EVIDENCE_RULE, prompt)
            if len(calls) > 1:
                self.assertIn("名单为空必须为[]", prompt)
            if len(calls) == 1:
                self.assertEqual(content[0]["type"], "video_url")
                self.assertTrue(base64.b64decode(content[0]["video_url"]["url"].split(",", 1)[1]).startswith(b"\0\0\0"))
                return json.dumps({"observations": [{"type": "pass", "start": 1, "end": 2, "anchorTime": 1.5,
                   "description": "白色球衣传球"}]}, ensure_ascii=False), {}, "step-3.7-flash"
            self.assertEqual(sum(item["type"] == "image_url" for item in content), 2)
            self.assertEqual(content[0]["type"], "video_url")
            self.assertIn("frameId=" + "1".zfill(32), content[2]["text"])
            return json.dumps({"observations": [{"type": "pass", "start": 1, "end": 2, "anchorTime": 1.25,
                "description": "白色球衣传球；号码未清楚可辨", "playerIds": [], "unknownActors": ["白色球衣持球者"],
                "frameIds": ["1".zfill(32)], "confidence": .55}]}, ensure_ascii=False), {}, "step-3.7-flash"

        with patch.object(stepfun, "_video_bytes", return_value=b"\0\0\0\x18ftypmp42"), patch.object(stepfun, "_chat", side_effect=fake_chat):
            run = stepfun.execute_vision(self.service, project(), {"id": "c" * 32},
                {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
        self.assertEqual(run["providerRun"]["mode"], "video-model")
        self.assertEqual(run["observations"][0]["frameIds"], ["1".zfill(32)])
        self.assertEqual(run["observations"][0]["review"]["status"], "unreviewed")
        self.assertEqual(run["videoInput"]["sourceSha256"], "b" * 64)
        self.assertEqual(len(calls), 2)

    def test_video_first_rejects_unverified_frame_reference(self):
        raw1 = json.dumps({"observations": [{"type": "shot", "start": 1, "end": 2}]})
        raw2 = json.dumps({"observations": [{"type": "shot", "start": 1, "end": 2, "description": "投篮", "frameIds": ["f" * 32]}]})
        with patch.object(stepfun, "_video_bytes", return_value=b"MP4"), patch.object(stepfun, "_chat", side_effect=[(raw1, {}, "step-3.7-flash"), (raw2, {}, "step-3.7-flash")]):
            run = stepfun.execute_vision(self.service, project(), {}, {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
        self.assertEqual(run["observations"], [])
        self.assertTrue(any(item["reason"] == "invalid_frame_reference" for item in run["candidateRevisions"]))

    def _video_semantic_run(self, rows, *, roster=None, initial=None):
        p = project(8)
        p["context"]["roster"] = roster or []
        initial = initial if initial is not None else [{"type": "shot", "start": 1 + 3 * i, "end": 2 + 3 * i}
                                                       for i in range(len(rows))]
        raw_initial = json.dumps({"observations": initial}, ensure_ascii=False)
        raw_evidence = [json.dumps({"observations": [row]}, ensure_ascii=False) for row in rows]
        responses = [(raw_initial, {"completion_tokens": 17, "authorization": "not-saved"}, "step-3.7-flash")]
        responses.extend((raw, {}, "step-3.7-flash") for raw in raw_evidence)
        job = {"id": "c" * 32}
        with patch.object(stepfun, "_video_bytes", return_value=b"MP4"), patch.object(
                stepfun, "_scene_cuts", return_value=None), patch.object(stepfun, "_chat", side_effect=responses):
            run = stepfun.execute_vision(self.service, p, job,
                {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 8}})
        audit_dir = self.service.store.project_dir(p["id"]) / "jobs" / job["id"]
        return run, audit_dir, raw_initial, raw_evidence

    @staticmethod
    def _candidate(index=0, **changes):
        return {"type": "shot", "start": 1 + 3 * index, "end": 2 + 3 * index,
                "description": "画面中球员出手，结果和身份仍需人工复核", "playerIds": [],
                "frameIds": [f"{1 + 2 * index:032x}"], "unknownActors": ["持球者"], **changes}

    def test_illegal_identity_rejects_only_its_candidate_and_preserves_actual_audit(self):
        bad = self._candidate(playerIds=["fabricated-player"])
        good = self._candidate(1)
        run, directory, initial, responses = self._video_semantic_run([bad, good])
        self.assertEqual(len(run["observations"]), 1)
        self.assertEqual(run["observations"][0]["frameIds"], [f"{3:032x}"])
        self.assertEqual(run["observations"][0]["review"]["status"], "unreviewed")
        self.assertEqual(run["semanticValidation"]["status"], "partial")
        rejected = next(row for row in run["candidateRevisions"] if row["reason"] == "illegal_player_identity")
        self.assertEqual(rejected["candidate"]["playerIds"], ["fabricated-player"])
        self.assertEqual(rejected["candidateIndex"], 0)
        self.assertEqual(rejected["evidenceIndex"], 0)
        self.assertEqual(rejected["sourceWindow"], {"start": 0, "end": 3})
        self.assertEqual(rejected["frameIds"], [f"{1:032x}", f"{2:032x}"])
        self.assertEqual(run["rawEvidenceProposals"], responses)
        self.assertEqual(json.loads((directory / "video-proposal.json").read_text())["rawProposal"], initial)
        audit = json.loads((directory / "evidence-proposals.json").read_text())
        self.assertEqual([row["rawProposal"] for row in audit["responses"]], responses)
        self.assertNotIn("not-saved", (directory / "video-proposal.json").read_text())
        self.assertEqual((directory / "evidence-proposals.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)

    def test_all_rejected_is_empty_unverified_proposal_with_explicit_diagnostics(self):
        run, directory, _, _ = self._video_semantic_run([
            self._candidate(playerIds=["fabricated-player"]), self._candidate(1, frameIds=["not-provided"])])
        self.assertEqual(run["observations"], [])
        self.assertEqual(run["semanticValidation"], {"status": "rejected_all", "proposedCount": 0,
            "rejectedCount": 2, "requiresHumanReview": True, "factVerified": False})
        self.assertEqual({row["reason"] for row in run["candidateRevisions"]},
                         {"illegal_player_identity", "invalid_frame_reference"})
        audit = json.loads((directory / "semantic-validation.json").read_text())
        self.assertEqual(audit["candidateRevisions"], run["candidateRevisions"])
        self.assertTrue(run["proposalOnly"])

    def test_malformed_candidate_does_not_abort_valid_neighbor(self):
        for bad in ("not-an-object", self._candidate(unknownActors=[{}]),
                    self._candidate(anchorTime="1.5"), self._candidate(start=float("nan")),
                    self._candidate(frameIds=[{}]), self._candidate(playerIds=[{}])):
            with self.subTest(bad=bad):
                run, _, _, _ = self._video_semantic_run([bad, self._candidate(1)])
                self.assertEqual(len(run["observations"]), 1)
                self.assertEqual(run["observations"][0]["frameIds"], [f"{3:032x}"])
                self.assertEqual(run["semanticValidation"]["status"], "partial")

    def test_legal_roster_id_keeps_fact_and_review_unverified(self):
        roster = [{"id": "player-1", "name": "Player One", "teamId": "TEAM"}]
        run, _, _, _ = self._video_semantic_run([self._candidate(playerIds=["player-1"])], roster=roster)
        self.assertEqual(run["observations"][0]["playerIds"], ["player-1"])
        self.assertEqual(run["observations"][0]["review"]["status"], "unreviewed")
        self.assertFalse(run["semanticValidation"]["factVerified"])
        self.assertTrue(run["semanticValidation"]["requiresHumanReview"])

    def test_excessive_candidate_count_remains_bounded_and_is_not_semantic_success(self):
        initial = [{"type": "shot", "start": 1, "end": 2}] * 13
        run, _, _, _ = self._video_semantic_run([], initial=initial)
        self.assertEqual(run["observations"], [])
        self.assertEqual(run["semanticValidation"]["status"], "rejected_all")
        self.assertEqual(run["candidateRevisions"][0]["reason"], "invalid_initial_schema")

    def test_malformed_supplement_is_saved_before_json_validation(self):
        initial = json.dumps({"observations": [{"type": "shot", "start": 1, "end": 2}]})
        raw = "This is not the requested JSON."
        job = {"id": "c" * 32}
        with patch.object(stepfun, "_video_bytes", return_value=b"MP4"), patch.object(
                stepfun, "_scene_cuts", return_value=None), patch.object(
                stepfun, "_chat", side_effect=[(initial, {}, "step-3.7-flash"), (raw, {}, "step-3.7-flash")]):
            run = stepfun.execute_vision(self.service, project(), job,
                {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
        self.assertEqual(run["observations"], [])
        self.assertEqual(run["rawEvidenceProposals"], [raw])
        self.assertEqual(run["candidateRevisions"][0]["reason"], "invalid_evidence_schema")
        directory = self.service.store.project_dir(project()["id"]) / "jobs" / job["id"]
        audit = json.loads((directory / "evidence-proposals.json").read_text())
        self.assertEqual(audit["responses"][0]["rawProposal"], raw)

    def test_neighbor_window_frame_is_not_valid_local_evidence(self):
        run, _, _, _ = self._video_semantic_run([
            self._candidate(), self._candidate(1, frameIds=[f"{1:032x}"])])
        self.assertEqual(len(run["observations"]), 1)
        rejected = next(row for row in run["candidateRevisions"] if row["reason"] == "invalid_frame_reference")
        self.assertEqual(rejected["candidateIndex"], 1)
        self.assertEqual(rejected["frameIds"], [f"{3:032x}", f"{4:032x}"])

    def test_cancelled_or_stale_vision_does_not_replace_project(self):
        video = Path(self.temporary.name) / "cancel-test.mp4"
        result = subprocess.run([stepfun.FFMPEG, "-v", "error", "-f", "lavfi", "-i",
            "testsrc2=size=320x180:rate=25", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(video)],
            capture_output=True)
        self.assertEqual(result.returncode, 0)
        for cancel in (True, False):
            with self.subTest(cancel=cancel):
                service = BroadcastService(Path(self.temporary.name) / ("cancelled" if cancel else "stale"))
                p = service.create("取消或旧版本测试", "manual")
                with video.open("rb") as source:
                    p = service.upload(p["id"], p["revision"], source, video.stat().st_size, "cancel-test.mp4", "video/mp4")
                entered, release = threading.Event(), threading.Event()
                initial = json.dumps({"observations": [{"type": "shot", "start": 1, "end": 2}]})
                calls = []
                def fake_chat(kind, content, **kwargs):
                    calls.append(content)
                    if len(calls) == 1:
                        return initial, {}, "step-3.7-flash"
                    fid = next(re.search(r"frameId=([A-Za-z0-9_-]+)", item["text"]).group(1)
                               for item in content if item.get("type") == "text" and item["text"].startswith("frameId="))
                    entered.set()
                    self.assertTrue(release.wait(5))
                    return json.dumps({"observations": [self._candidate(frameIds=[fid])]}), {}, "step-3.7-flash"
                with patch.object(stepfun, "_video_bytes", return_value=b"MP4"), patch.object(
                        stepfun, "_scene_cuts", return_value=None), patch.object(stepfun, "_chat", side_effect=fake_chat):
                    job = service.start_job(p["id"], p["revision"], "analyze",
                        {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
                    self.assertTrue(entered.wait(5))
                    if cancel:
                        service.cancel(job["id"])
                    else:
                        p = service.edit(p["id"], p["revision"], {"title": "newer edit"})
                    release.set()
                    service._threads[job["id"]].join(5)
                self.assertFalse(service._threads[job["id"]].is_alive())
                finished = service.job(job["id"])
                self.assertEqual(finished["status"], "cancelled" if cancel else "needs_review")
                current = service.get(p["id"])
                self.assertEqual(current["revision"], p["revision"])
                self.assertEqual(current["observations"], [])
                directory = service.store.project_dir(p["id"]) / "jobs" / job["id"]
                self.assertTrue((directory / "evidence-proposals.json").is_file())

    def test_evidence_clip_retries_transient_failure_without_publishing_raw_guess(self):
        initial = json.dumps({"observations": [{"type": "result", "start": 1, "end": 2,
            "description": "未经取证的得分猜测"}]}, ensure_ascii=False)
        verified = json.dumps({"observations": [{"type": "other", "start": 1, "end": 2,
            "description": "白衣球员与红衣球员接近，结果看不清", "playerIds": [],
            "unknownActors": ["白衣球员"], "frameIds": ["1".zfill(32)],
            "confidence": .4}]}, ensure_ascii=False)
        transient = BroadcastError("provider_failed", "StepFun 请求失败；请检查账户和网络。", 502, True)
        with patch.object(stepfun, "_video_bytes", return_value=b"MP4"), patch.object(
                stepfun, "_chat", side_effect=[(initial, {}, "step-3.7-flash"), transient,
                                               (verified, {}, "step-3.7-flash")]) as chat:
            run = stepfun.execute_vision(self.service, project(), {},
                {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
        self.assertEqual(chat.call_count, 3)
        self.assertEqual(run["evidenceAttempts"][0]["attempts"], 2)
        self.assertEqual(run["observations"][0]["type"], "other")
        self.assertNotIn("得分", run["observations"][0]["description"])

    def test_initial_video_retries_transient_failure_with_identical_input(self):
        initial = json.dumps({"observations": []})
        transient = BroadcastError("provider_failed", "StepFun 请求失败；请检查账户和网络。", 502, True)
        with patch.object(stepfun, "_video_bytes", return_value=b"MP4"), patch.object(
                stepfun, "_chat", side_effect=[transient, (initial, {}, "step-3.7-flash")]) as chat:
            run = stepfun.execute_vision(self.service, project(), {},
                {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
        self.assertEqual(chat.call_count, 2)
        self.assertEqual(chat.call_args_list[0].args[1], chat.call_args_list[1].args[1])
        self.assertEqual(run["videoAttempts"], 2)
        self.assertEqual(run["observations"], [])

    def test_edit_boundary_rejects_candidate_that_spans_two_plays(self):
        initial = json.dumps({"observations": [{"type": "result", "start": 1, "end": 2,
            "description": "跨镜头的虚假得分"}]}, ensure_ascii=False)
        with patch.object(stepfun, "_video_bytes", return_value=b"MP4"), patch.object(
                stepfun, "_scene_cuts", return_value=[1.5]), patch.object(
                stepfun, "_chat", return_value=(initial, {}, "step-3.7-flash")) as chat:
            run = stepfun.execute_vision(self.service, project(), {},
                {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
        self.assertEqual(chat.call_count, 1)
        self.assertEqual(run["observations"], [])
        self.assertEqual(run["candidateRevisions"][0]["reason"], "crosses_scene_cut")

    def test_evidence_frames_and_clip_stop_before_neighboring_edit(self):
        initial = json.dumps({"observations": [{"type": "shot", "start": 1, "end": 2,
            "description": "出手候选"}]}, ensure_ascii=False)
        seen_scopes = []
        def video_bytes(path, scope):
            seen_scopes.append(dict(scope))
            return b"MP4"
        with patch.object(stepfun, "_video_bytes", side_effect=video_bytes), patch.object(
                stepfun, "_scene_cuts", return_value=[2.4]), patch.object(
                stepfun, "_chat", side_effect=[(initial, {}, "step-3.7-flash"),
                                               ('{"observations":[]}', {}, "step-3.7-flash")]):
            run = stepfun.execute_vision(self.service, project(), {},
                {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
        self.assertLess(seen_scopes[1]["end"], 2.4)
        self.assertTrue(all(time < 2.4 for time in self.service.calls[0][2]))
        self.assertEqual(run["observations"], [])

    def test_evidence_clip_does_not_retry_nontransient_failure(self):
        initial = json.dumps({"observations": [{"type": "shot", "start": 1, "end": 2}]})
        denied = BroadcastError("provider_failed", "StepFun HTTP 400；请检查模型权限或请求格式。", 502, False)
        with patch.object(stepfun, "_video_bytes", return_value=b"MP4"), patch.object(
                stepfun, "_chat", side_effect=[(initial, {}, "step-3.7-flash"), denied]) as chat:
            run = stepfun.execute_vision(self.service, project(), {},
                {"providerId": "stepfun-vision", "strategy": "video-first", "scope": {"start": 0, "end": 4}})
        self.assertEqual(chat.call_count, 2)
        self.assertEqual(run["observations"], [])
        self.assertEqual(run["evidenceAttempts"][0]["class"], "upstream_http")
        self.assertEqual(run["candidateRevisions"][0]["retryable"], False)

    def test_sourced_play_by_play_is_same_game_background_not_source_pts(self):
        pbp = {"source": {"provider": "ESPN", "url": "https://example.org/summary", "retrievedAt": "2026-09-30T00:00:00Z", "gameId": "game-1"},
               "entries": [{"id": "play-1", "period": 1, "clock": "11:40", "text": "Player makes tip shot", "awayScore": 2, "homeScore": 0}]}
        validate_play_by_play(pbp, "game-1")
        p = project()
        p["context"].update(gameId="game-1", playByPlay=pbp)
        note, audit = stepfun._background(p)
        self.assertIn("绝非源视频PTS", note)
        self.assertEqual(audit["entryCount"], 1)
        with self.assertRaises(BroadcastError):
            validate_play_by_play(pbp, "other-game")
        pbp["entries"][0]["clock"] = "11:60"
        with self.assertRaises(BroadcastError):
            validate_play_by_play(pbp, "game-1")

    def test_scoreboard_transition_matches_only_same_clock_and_score(self):
        p = project()
        p["context"]["playByPlay"] = {"source": {"provider": "ESPN", "url": "https://example.org/summary", "retrievedAt": "2026-09-30", "gameId": "game-1", "awayTeamId": "DAL", "homeTeamId": "HOU"},
            "entries": [{"id": "play-1", "period": 1, "clock": "11:40", "text": "Player makes tip shot", "awayScore": 2, "homeScore": 0},
                        {"id": "play-2", "period": 1, "clock": "10:39", "text": "Player makes two point shot", "awayScore": 4, "homeScore": 0}]}
        before = {"period": 1, "clock": "11:41", "leftTeam": "DAL", "rightTeam": "HOU", "leftScore": 0, "rightScore": 0}
        after = {"period": 1, "clock": "11:35", "leftTeam": "DAL", "rightTeam": "HOU", "leftScore": 2, "rightScore": 0}
        self.assertEqual(stepfun._matched_pbp(p, before, after)["id"], "play-1")
        self.assertIsNone(stepfun._matched_pbp(p, before, {**after, "clock": "10:39", "leftScore": 4}))
        self.assertIsNone(stepfun._matched_pbp(p, before, {**after, "leftScore": 0}))
        self.assertIsNone(stepfun._matched_pbp(p, before, {**after, "leftTeam": "BOS"}))
        swapped_before = {**before, "leftTeam": "HOU", "rightTeam": "DAL", "leftScore": 0, "rightScore": 0}
        swapped_after = {**after, "leftTeam": "HOU", "rightTeam": "DAL", "leftScore": 0, "rightScore": 2}
        self.assertEqual(stepfun._matched_pbp(p, swapped_before, swapped_after)["id"], "play-1")

    def test_scoreboard_parser_accepts_observed_time_and_ordinal_aliases(self):
        actual = '{"leftTeam":"DAL","rightTeam":"HOU","leftScore":0,"rightScore":0,"time":"11:40","period":"1st"}'
        self.assertEqual(stepfun._parse_scoreboard(actual), {"period": 1, "clock": "11:40", "leftScore": 0,
                                                          "rightScore": 0, "leftTeam": "DAL", "rightTeam": "HOU"})
        self.assertIsNone(stepfun._parse_scoreboard(actual.replace('"11:40"', '"11:60"')))
        self.assertEqual(stepfun._parse_scoreboard(actual.replace('"DAL"', '"独行侠"'))["leftTeam"], "DAL")
        prose = "左边球队：独行侠\n左分：2\n右边球队：火箭\n右分：0\n节次：1st\n比赛时钟：11:36"
        self.assertEqual(stepfun._parse_scoreboard(prose), {"period": 1, "clock": "11:36", "leftScore": 2,
                                                         "rightScore": 0, "leftTeam": "DAL", "rightTeam": "HOU"})

    def test_vision_sends_bounded_real_jpegs_and_only_cited_candidate(self):
        seen = []

        def fake_chat(kind, content):
            self.assertEqual(kind, "vision")
            seen.extend(content)
            return json.dumps({"observations": [{"type": "other", "start": 0.9, "end": 1.1, "anchorTime": 1,
                   "description": "画面中有持球者，身份未确认", "frameIds": ["1".zfill(32)]}]}, ensure_ascii=False), {"output_tokens": 40}, "step-3.7-flash"

        with patch.object(stepfun, "_chat", side_effect=fake_chat):
            run = stepfun.execute_vision(self.service, project(), {"id": "c" * 32}, {"providerId": "stepfun-vision", "strategy": "frames-first", "scope": {"start": 0, "end": 4}})
        images = [item["image_url"]["url"] for item in seen if item["type"] == "image_url"]
        self.assertEqual(len(images), 2)
        self.assertTrue(all(base64.b64decode(url.split(",", 1)[1]).startswith(b"\xff\xd8") for url in images))
        self.assertIn("frameId=" + "1".zfill(32), seen[1]["text"])
        self.assertEqual(run["observations"][0]["review"]["status"], "unreviewed")
        self.assertEqual(run["providerRun"]["mode"], "image-model")
        self.assertEqual(run["frameFingerprints"][0]["actualTime"], 1)

    def test_vision_rejects_unknown_frame_and_overlong_scope(self):
        bad = json.dumps({"observations": [{"type": "shot", "start": 1, "end": 2, "anchorTime": 1.5,
                                              "description": "猜测出手", "frameIds": ["f" * 32]}]})
        with patch.object(stepfun, "_chat", return_value=(bad, {}, "step-3.7-flash")):
            with self.assertRaises(BroadcastError) as caught:
                stepfun.execute_vision(self.service, project(), {}, {"providerId": "stepfun-vision", "strategy": "frames-first", "scope": {"start": 0, "end": 4}})
        self.assertEqual(caught.exception.code, "schema_invalid")
        with self.assertRaises(BroadcastError) as caught:
            stepfun.execute_vision(self.service, project(80), {}, {"providerId": "stepfun-vision", "strategy": "frames-first", "scope": {"start": 0, "end": 50}})
        self.assertEqual(caught.exception.code, "unsupported_modality")

    def test_fixed_endpoint_protocol_no_redirect_and_incomplete_response_fails(self):
        class Reply:
            headers = {"Content-Type": "application/json"}

            def __init__(self, finish="stop"):
                self.raw = json.dumps({"choices": [{"finish_reason": finish, "message": {"content": '{"observations":[]}'}}]}).encode()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, maximum):
                return self.raw

        class Opener:
            def __init__(self, finish):
                self.finish = finish

            def open(self, request, timeout):
                self_request = json.loads(request.data)
                assert request.full_url == stepfun.URL
                assert self_request["model"] == "step-3.7-flash"
                assert self_request["max_tokens"] == 12000 and self_request["temperature"] == .1
                assert self_request["reasoning_effort"] == "low"
                assert timeout == 150
                return Reply(self.finish)

        with patch.object(stepfun.urllib.request, "build_opener", return_value=Opener("stop")) as factory:
            raw, _, _ = stepfun._chat("vision", [{"type": "text", "text": "test"}])
            self.assertIn("observations", raw)
            self.assertIsInstance(factory.call_args.args[0], stepfun._NoRedirect)
        with patch.object(stepfun.urllib.request, "build_opener", return_value=Opener("length")):
            with self.assertRaises(BroadcastError):
                stepfun._chat("vision", [{"type": "text", "text": "test"}])

    def test_story_uses_accepted_evidence_and_rejects_wrong_reference(self):
        accepted = {"id": "d" * 32, "type": "movement", "start": 0, "end": 1,
                    "anchorTime": None, "segmentId": "segment-1", "description": "画面中的人向左移动", "playerIds": [], "frameIds": [],
                    "review": {"status": "accepted", "actor": "reviewer", "at": "2026-09-30T00:00:00Z"},
                    "source": {"kind": "manual", "runId": None, "recordId": None}, "unknownActors": [], "confidence": None, "geometry": None}
        p = project()
        p["observations"] = [accepted]
        beat = {"label": "跑动", "sourceStart": 1.2, "sourceEnd": 3, "anchorTime": 1.2,
                "observationIds": [accepted["id"]], "bindingIds": [], "text": "画面中的人向左移动", "explanationKind": "visible-fact", "metricRecordId": None, "secondaryLabel": None, "annotation": None}
        candidate = json.dumps({"title": "片段复盘", "beats": [beat]}, ensure_ascii=False)
        with patch.object(stepfun, "_chat", return_value=(candidate, {}, "step-3.7-flash")) as chat:
            story, audit = stepfun.propose_story(p, "fan", {})
        self.assertEqual(story["beats"][0]["observationIds"], [accepted["id"]])
        self.assertEqual(audit["provider"], "stepfun-step-plan")
        prompt = chat.call_args.args[1][0]["text"]
        self.assertIn(accepted["id"], prompt)
        self.assertIn("visible-fact、data-fact或interpretation", prompt)
        self.assertIn('"earliestCueStart":1', prompt)
        self.assertNotIn("API_KEY", prompt)
        beat["observationIds"] = ["e" * 32]
        with patch.object(stepfun, "_chat", return_value=(json.dumps({"title": "片段复盘", "beats": [beat]}, ensure_ascii=False), {}, "step-3.7-flash")) as chat:
            with self.assertRaises(BroadcastError) as caught:
                stepfun.propose_story(p, "fan", {})
        self.assertEqual(caught.exception.code, "schema_invalid")
        self.assertEqual(chat.call_count, 2)

    def test_story_prompt_exposes_actual_earliest_cue_without_truncating_example(self):
        from core.broadcast.providers.story_model import story_prompt
        p = project()
        p["observations"] = [{"id": "d" * 32, "type": "other", "start": 1, "end": 3, "anchorTime": 3,
                              "segmentId": "s1", "description": "画面中的符号缓慢移动", "playerIds": [], "frameIds": [] ,
                              "review": {"status": "accepted"}}]
        prompt = story_prompt(p, "fan", {})
        self.assertIn('"earliestCueStart":3', prompt)
        self.assertIn('"sourceStart":3.0,"sourceEnd":8.0', prompt)
        self.assertIn("示例正文是占位提示，绝对不要照抄", prompt)

    def test_capability_and_voice_variant_do_not_claim_unmatched_probe(self):
        check_configured("analyze", {"providerId": "stepfun-vision", "strategy": "frames-first"})
        check_configured("analyze", {"providerId": "stepfun-vision", "strategy": "video-first"})
        rows = {row["id"]: row for row in capabilities(self.temporary.name)}
        self.assertTrue(rows["stepfun-vision"]["available"])
        self.assertIn("video", rows["stepfun-vision"]["modalities"])
        self.assertFalse(rows["stepfun-vision"]["verified"])
        with patch.dict(os.environ, {"COURTLENS_STEPFUN_MODEL": "tts-model", "COURTLENS_STEPFUN_VOICE_ID": "voice", "COURTLENS_STEPFUN_API_VARIANT": "invalid"}):
            rows = {row["id"]: row for row in capabilities(self.temporary.name)}
            self.assertFalse(rows["stepfun"]["configured"])
        with patch.dict(os.environ, {"COURTLENS_STEPFUN_MODEL": "tts-model", "COURTLENS_STEPFUN_VOICE_ID": "voice", "COURTLENS_STEPFUN_API_VARIANT": "step-plan"}):
            receipt = {"passed": True, "at": "2026-09-30T00:00:00Z", "fingerprint": voice_fingerprint("stepfun")}
            (Path(self.temporary.name) / "voice-stepfun.json").write_text(json.dumps(receipt))
            rows = {row["id"]: row for row in capabilities(self.temporary.name)}
            self.assertTrue(rows["stepfun"]["verified"])
            with patch.dict(os.environ, {"COURTLENS_STEPFUN_VOICE_ID": "different"}):
                rows = {row["id"]: row for row in capabilities(self.temporary.name)}
                self.assertFalse(rows["stepfun"]["verified"])


if __name__ == "__main__":
    unittest.main()
