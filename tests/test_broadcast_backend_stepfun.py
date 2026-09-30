"""Fixed Step Plan transport and real-frame evidence without paid network calls."""
import base64
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from core.broadcast.common import BroadcastError
from core.broadcast.providers import capabilities, check_configured, voice_fingerprint
from core.broadcast.providers import stepfun
from core.broadcast.service import validate_play_by_play


class FakeStore:
    def __init__(self, root):
        self.root = Path(root)

    def find(self, kind, fid):
        return self.root / kind / fid


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
        self.assertTrue(any(item["reason"] == "evidence_clip_failed" for item in run["candidateRevisions"]))

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
