"""Real local MP4/PNG through a simulated Converse transport; no AWS call."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.media import FFMPEG
from core.broadcast.providers.bedrock import execute_bedrock, normalize_candidates
from core.broadcast.service import BroadcastService


class CandidateAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.project = {"media": {"duration": 48}, "context": {"roster": [{"id": "player-one"}]}}
        self.scope = {"start": 0, "end": 48}
        self.frames = {"a" * 32: {"actualTime": 1.4}}
        self.good = {"type": "pass", "start": 1, "end": 2, "anchorTime": 1.4,
                     "description": "持球人传球，身份待核对", "frameIds": ["a" * 32]}

    def run_candidates(self, items):
        return normalize_candidates({"observations": items}, self.project, self.scope,
                                    "b" * 32, "image-model", self.frames)

    def test_bad_identity_or_frame_or_time_does_not_remove_valid_neighbor(self):
        for bad, reason in (({**self.good, "playerIds": ["fictional"]}, "illegal_player_identity"),
                            ({**self.good, "frameIds": []}, "invalid_frame_reference"),
                            ({**self.good, "anchorTime": 4}, "invalid_final_time"),
                            ({**self.good, "frameIds": [{}]}, "invalid_frame_reference"),
                            ({**self.good, "playerIds": [{}]}, "illegal_player_identity"),
                            ({**self.good, "start": float("nan")}, "invalid_final_time"),
                            ("invalid", "invalid_candidate_schema")):
            with self.subTest(reason=reason):
                rows, rejected, semantic = self.run_candidates([bad, self.good])
                self.assertEqual(len(rows), 1)
                self.assertEqual(rejected[0]["reason"], reason)
                self.assertEqual(rejected[0]["candidateIndex"], 0)
                self.assertEqual(semantic["status"], "partial")
                self.assertFalse(semantic["factVerified"])
                self.assertEqual(rows[0]["review"]["status"], "unreviewed")
                json.dumps(rejected, allow_nan=False)

    def test_twelve_actions_are_not_confused_with_three_visual_beats(self):
        rows, _, _ = self.run_candidates([self.good] * 12)
        self.assertEqual(len(rows), 12)
        with self.assertRaises(BroadcastError):
            self.run_candidates([self.good] * 13)

    def test_empty_and_unseen_frames_never_look_like_verified_facts(self):
        for items in ([], [{**self.good, "frameIds": []}]):
            rows, _, semantic = self.run_candidates(items)
            self.assertEqual(rows, [])
            self.assertEqual(semantic["status"], "rejected_all")
            self.assertTrue(semantic["requiresHumanReview"])


class RealMediaConverseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not FFMPEG:
            raise unittest.SkipTest("ffmpeg unavailable")
        cls.folder = tempfile.TemporaryDirectory()
        cls.clip = Path(cls.folder.name) / "source.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i",
                        "testsrc2=size=320x180:rate=25:duration=10", "-an", "-c:v",
                        "libx264", "-pix_fmt", "yuv420p", str(cls.clip)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.folder.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = BroadcastService(Path(self.temp.name) / "workspace")
        p = self.service.create("离线 Bedrock 媒体协议", "assisted")
        self.project = self.service.upload(p["id"], p["revision"], io.BytesIO(self.clip.read_bytes()),
                                           self.clip.stat().st_size, "source.mp4", "video/mp4")
        self.env = patch.dict(os.environ, {"COURTLENS_BEDROCK_REGION": "us-east-1",
                "COURTLENS_SEMANTIC_MODEL_ID": "offline-video-fixture", "COURTLENS_VISION_MODEL_ID": "offline-image-fixture",
                "COURTLENS_BEDROCK_MODALITIES": "text,image,video", "COURTLENS_BEDROCK_TOOLS": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.job = {"id": "c" * 32}

    def execute(self, client):
        with patch("boto3.client", return_value=client):
            return execute_bedrock(self.service, self.project, self.job,
                                   {"providerId": "bedrock-video", "strategy": "video-first"})

    def test_actual_video_and_twenty_four_frames_survive_partial_cloud_handoff(self):
        seen, requests = [], []
        class Client:
            def converse(inner, **kwargs):
                requests.append(kwargs)
                self.assertEqual(kwargs["inferenceConfig"]["maxTokens"], 4000)
                video = next(block["video"]["source"]["bytes"] for block in kwargs["messages"][0]["content"] if "video" in block)
                self.assertEqual(hashlib.sha256(video).hexdigest(), self.project["media"]["sha256"])
                if len(requests) > 1:
                    blocks = kwargs["messages"][-1]["content"][0]["toolResult"]["content"]
                    frames = json.loads(blocks[0]["text"])["frames"]
                    self.assertEqual(len(frames), 8)
                    self.assertTrue(all(block["image"]["source"]["bytes"].startswith(b"\x89PNG") for block in blocks[1:]))
                    seen.extend(frames)
                if len(requests) <= 3:
                    offset = (len(requests) - 1) * 2
                    return {"output": {"message": {"role": "assistant", "content": [{"toolUse": {
                        "toolUseId": "frames-" + str(len(requests)), "name": "inspect_frames",
                        "input": {"times": [offset + .2 + i * .2 for i in range(8)]}}}]}}}
                events = [{"type": "pass", "start": f["actualTime"] - .04,
                           "end": f["actualTime"] + .08, "anchorTime": f["actualTime"],
                           "description": "合成传球协议候选，需核对", "frameIds": [f["id"]]} for f in seen[:5]]
                events.append({**events[0], "playerIds": ["fictional"]})
                return {"output": {"message": {"role": "assistant", "content": [
                    {"text": json.dumps({"observations": events}, ensure_ascii=False)},
                    {"reasoningContent": {"reasoningText": {"text": "DO_NOT_SAVE_REASONING"}}}]}},
                    "usage": {"inputTokens": 42, "authorization": "DO_NOT_SAVE_AUTH"}}
        run = self.execute(Client())
        self.assertEqual(len(run["frameFingerprints"]), 24)
        self.assertEqual(len(run["observations"]), 5)
        self.assertEqual(run["semanticValidation"]["status"], "partial")
        audit = self.service.store.project_dir(self.project["id"]) / "jobs" / self.job["id"] / "bedrock-responses.json"
        content = audit.read_text()
        self.assertNotIn("DO_NOT_SAVE", content)
        self.assertIn("fictional", content)
        self.assertEqual(audit.stat().st_mode & 0o777, 0o600)
        # Simulate the runtime envelope, then re-extract the actual pixel bytes
        # just as the cloud media worker does. No AWS execution is claimed.
        record = {"mediaSha256": self.project["media"]["sha256"], "inputRevision": self.project["revision"],
                  "runtimeArn": "arn:fixture", "strategy": "video-first", "mode": "video-model",
                  "requestHash": run["providerRun"]["requestHash"], "responseHash": run["providerRun"]["responseHash"],
                  "rawProposal": run["rawProposal"], "scope": {"start": 0, "end": 10},
                  "videoInput": run["videoInput"], "frameFingerprints": run["frameFingerprints"],
                  "invokedAt": run["providerRun"]["completedAt"]}
        fixed = self.service.store.project_dir(self.project["id"]) / "agentcore-proposal.json"
        fixed.write_text(json.dumps(record))
        from core.broadcast.providers.agentcore_import import execute_agentcore_proposal
        with patch.dict(os.environ, {"AGENT_RUNTIME_ARN": "arn:fixture"}):
            imported = execute_agentcore_proposal(self.service, self.project,
                    {"inputRevision": self.project["revision"]}, {"_trustedAgentCore": True, "strategy": "video-first"})
        self.assertEqual(len(imported["observations"]), 5)
        self.assertEqual(imported["semanticValidation"], run["semanticValidation"])
        self.assertEqual(imported["providerRun"]["responseHash"], run["providerRun"]["responseHash"])
        self.assertTrue(all(row["review"]["status"] == "unreviewed" for row in imported["observations"]))

    def test_malformed_visible_response_is_saved_before_retry_fails(self):
        class Client:
            def converse(inner, **kwargs):
                return {"output": {"message": {"role": "assistant", "content": [{"text": "not JSON"}]}}}
        with self.assertRaises(BroadcastError):
            self.execute(Client())
        audit = self.service.store.project_dir(self.project["id"]) / "jobs" / self.job["id"] / "bedrock-responses.json"
        self.assertEqual(len(json.loads(audit.read_text())["responses"]), 2)

    def test_no_source_frame_means_no_accepted_candidate(self):
        class Client:
            def converse(inner, **kwargs):
                return {"output": {"message": {"role": "assistant", "content": [{"text": json.dumps({"observations": [{
                    "type": "shot", "start": 1, "end": 2, "description": "无帧提议", "frameIds": []}]})}]}}}
        result = self.execute(Client())
        self.assertEqual(result["observations"], [])
        self.assertEqual(result["semanticValidation"]["status"], "rejected_all")

    def test_selected_late_frame_is_the_actual_single_image_sent(self):
        frame = self.service.frames(self.project["id"], self.project["revision"], [8.4])["frames"][0]
        calls = []
        class Client:
            def converse(inner, **kwargs):
                calls.append(kwargs)
                content = kwargs["messages"][0]["content"]
                images = [b["image"]["source"]["bytes"] for b in content if "image" in b]
                self.assertEqual(len(images), 1)
                self.assertEqual(hashlib.sha256(images[0]).hexdigest(), frame["sha256"])
                self.assertTrue(any(frame["id"] in b.get("text", "") for b in content))
                row = {"type": "other", "start": 8.2, "end": 8.6, "anchorTime": frame["actualTime"],
                       "description": "合成源帧探测候选", "frameIds": [frame["id"]]}
                return {"output": {"message": {"role": "assistant", "content": [{"text": json.dumps({"observations": [row]})}]}}}
        options = {"providerId": "bedrock-image", "strategy": "frames-first", "frameId": frame["id"],
                   "scope": {"start": 8, "end": 9}}
        with patch("boto3.client", return_value=Client()):
            result = execute_bedrock(self.service, self.project, self.job, options)
        self.assertEqual(result["frameFingerprints"][0]["id"], frame["id"])
        self.assertEqual(len(result["observations"]), 1)
        folder = self.service.store.project_dir(self.project["id"]) / "frames" / frame["id"]
        (folder / "frame.png").write_bytes(b"tampered")
        with patch("boto3.client", side_effect=AssertionError("must not invoke on tampered image")):
            with self.assertRaises(BroadcastError) as caught:
                execute_bedrock(self.service, self.project, self.job, options)
        self.assertEqual(caught.exception.code, "media_mismatch")


if __name__ == "__main__":
    unittest.main()
