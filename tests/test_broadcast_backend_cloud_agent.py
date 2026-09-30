"""AgentCore protocol fixtures: actual bounded clip, real frame images, replay verification."""
import copy
import hashlib
import importlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.common import BroadcastError, now
from core.broadcast.media import FFPROBE
from core.broadcast.providers.agentcore_import import execute_agentcore_proposal
from core.broadcast.service import BroadcastService


FFMPEG = os.environ.get("COURTLENS_FFMPEG") or shutil.which("ffmpeg")


class _S3:
    def __init__(self, content):
        self.content = content
        self.sha = hashlib.sha256(content).hexdigest()

    def head_object(self, **kwargs):
        return {"ContentLength": len(self.content), "Metadata": {"sha256": self.sha}}

    def get_object(self, **kwargs):
        return {"Body": io.BytesIO(self.content)}


class _Bedrock:
    def __init__(self, mode):
        self.mode = mode
        self.calls = []
        self.seen_frame = None
        self.video_bytes = None

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        content = kwargs["messages"][0]["content"]
        if self.mode == "video-first":
            if len(self.calls) == 1:
                self.video_bytes = next(block["video"]["source"]["bytes"] for block in content if "video" in block)
                return {"output": {"message": {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "inspect_frames", "input": {"times": [1.4]}}}]}}, "usage": {"inputTokens": 5}}
            result = kwargs["messages"][-1]["content"][0]["toolResult"]["content"]
            assert result[1]["image"]["source"]["bytes"].startswith(b"\x89PNG\r\n\x1a\n")
            self.seen_frame = json.loads(result[0]["text"])["frames"][0]
        else:
            assert not any("video" in block for block in content)
            assert any("image" in block and block["image"]["source"]["bytes"].startswith(b"\x89PNG\r\n\x1a\n") for block in content)
            label = next(block["text"] for block in content if "text" in block and "frameId=" in block["text"])
            import re
            self.seen_frame = {"id": re.search(r"frameId=([a-f0-9]{32})", label).group(1)}
        raw = json.dumps({"observations": [{"type": "shot", "start": 1.2, "end": 1.8,
                                             "anchorTime": 1.4, "description": "候选出手，待人工核对",
                                             "frameIds": [self.seen_frame["id"]]}]}, ensure_ascii=False)
        return {"output": {"message": {"role": "assistant", "content": [{"text": raw}]}}, "usage": {"outputTokens": 20}}


class CloudAgentEvidenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not FFMPEG:
            raise unittest.SkipTest("ffmpeg unavailable")
        cls.temporary = tempfile.TemporaryDirectory()
        cls.source = Path(cls.temporary.name) / "source.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(cls.source)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.service = BroadcastService(self.temporary.name)
        p = self.service.create("云 Agent 测试", "assisted")
        with self.source.open("rb") as stream:
            self.project = self.service.upload(p["id"], p["revision"], stream, self.source.stat().st_size, self.source.name, "video/mp4")

    def _propose(self, strategy, model=None):
        import boto3
        s3 = _S3(self.source.read_bytes())
        model = model or _Bedrock(strategy)
        with patch.dict(os.environ, {"INPUT_BUCKET": "private-fixture", "MODEL_ID": "stub-model", "AWS_REGION": "us-east-1"}), patch.object(boto3, "client", side_effect=lambda name, **kwargs: s3 if name == "s3" else model):
            agent = importlib.reload(importlib.import_module("cloud.agent.main"))
            payload = {"kind": "video-proposal", "projectId": self.project["id"], "inputRevision": self.project["revision"],
                       "key": f"projects/{self.project['id']}/media/{self.project['media']['id']}/source.mp4",
                       "mediaSha256": self.project["media"]["sha256"], "scope": {"start": 1, "end": 3},
                       "strategy": strategy, "rosterIds": []}
            proposal = agent.propose(payload)
        return proposal, model

    def _import(self, proposal):
        record = {key: proposal.get(key) for key in ("mediaSha256", "requestHash", "responseHash", "rawProposal", "scope", "strategy", "mode", "frameFingerprints", "videoInput", "toolCalls", "usage")}
        record.update({"inputRevision": self.project["revision"], "runtimeArn": "arn:fixture:agentcore", "invokedAt": now(), "modelId": "stub-model"})
        fixed = self.service.store.project_dir(self.project["id"]) / "agentcore-proposal.json"
        fixed.write_text(json.dumps(record))
        with patch.dict(os.environ, {"AGENT_RUNTIME_ARN": "arn:fixture:agentcore"}):
            return execute_agentcore_proposal(self.service, self.project, {"inputRevision": self.project["revision"]}, {"_trustedAgentCore": True, "scope": {"start": 1, "end": 3}, "strategy": proposal["strategy"]})

    def test_video_first_sends_only_scope_derivative_then_actual_tool_image(self):
        proposal, model = self._propose("video-first")
        self.assertEqual(len(model.calls), 2)
        self.assertIsNotNone(model.video_bytes)
        self.assertNotEqual(hashlib.sha256(model.video_bytes).hexdigest(), self.project["media"]["sha256"])
        derivative = Path(self.temporary.name) / "model-input.mp4"
        derivative.write_bytes(model.video_bytes)
        duration = float(subprocess.check_output([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(derivative)]))
        self.assertTrue(1.9 <= duration <= 2.1)
        self.assertEqual(proposal["videoInput"]["sourceStart"], 1)
        self.assertEqual(proposal["videoInput"]["sourceEnd"], 3)
        self.assertEqual(proposal["toolCalls"], 1)
        run = self._import(proposal)
        self.assertEqual(run["providerRun"]["mode"], "video-model")
        self.assertEqual(run["observations"][0]["review"]["status"], "unreviewed")
        self.assertEqual(run["frameFingerprints"][0]["sha256"], proposal["frameFingerprints"][0]["sha256"])

    def test_frames_first_sends_no_video_and_replays_seen_frame(self):
        proposal, model = self._propose("frames-first")
        self.assertEqual(len(model.calls), 1)
        self.assertIsNone(proposal["videoInput"])
        run = self._import(proposal)
        self.assertEqual(run["providerRun"]["mode"], "image-model")
        self.assertTrue(run["observations"][0]["frameIds"])

    def test_forged_frame_fingerprint_fails_closed(self):
        proposal, _ = self._propose("frames-first")
        forged = copy.deepcopy(proposal)
        forged["frameFingerprints"][0]["sha256"] = "0" * 64
        with self.assertRaises(BroadcastError) as caught:
            self._import(forged)
        self.assertEqual(caught.exception.code, "media_mismatch")

    def test_fargate_agent_handoff_preserves_scope_and_seen_frames(self):
        import boto3
        proposal, _ = self._propose("frames-first")
        observed_payload = []
        class AgentRuntime:
            def invoke_agent_runtime(self, **kwargs):
                observed_payload.append(json.loads(kwargs["payload"]))
                return {"statusCode": 200, "contentType": "application/json", "response": io.BytesIO(json.dumps(proposal).encode())}
        s3 = _S3(self.source.read_bytes())
        with patch.dict(os.environ, {"TABLE_NAME": "fixture", "INPUT_BUCKET": "private-fixture", "RELEASE_BUCKET": "release-fixture", "OWNER_ID": "owner", "JOB_ID": "a" * 32, "AGENT_RUNTIME_ARN": "arn:fixture:agentcore"}), patch.object(boto3, "client", side_effect=lambda name, **kwargs: s3 if name == "s3" else AgentRuntime() if name == "bedrock-agentcore" else object()):
            runner = importlib.reload(importlib.import_module("cloud.render.runner"))
            job = {"jobType": "analyze", "projectId": self.project["id"], "expectedRevision": self.project["revision"],
                   "options": {"providerId": "agentcore-proposal", "strategy": "frames-first", "scope": {"start": 1, "end": 3}}}
            runner.invoke_agent_proposal(self.temporary.name, job, self.project)
            self.assertEqual(observed_payload[0]["strategy"], "frames-first")
            self.assertEqual(observed_payload[0]["scope"], {"start": 1, "end": 3})
            fixed = self.service.store.project_dir(self.project["id"]) / "agentcore-proposal.json"
            record = json.loads(fixed.read_text())
            self.assertEqual(record["frameFingerprints"], proposal["frameFingerprints"])
            run = execute_agentcore_proposal(self.service, self.project, {"inputRevision": self.project["revision"]}, {"_trustedAgentCore": True, "scope": {"start": 1, "end": 3}, "strategy": "frames-first"})
            self.assertEqual(run["providerRun"]["mode"], "image-model")

    def test_model_cannot_finish_without_frame_or_inspect_outside_scope(self):
        class NoFrame:
            def converse(self, **kwargs):
                raw = json.dumps({"observations": [{"type": "shot", "start": 1.2, "end": 1.8,
                                                   "anchorTime": 1.4, "description": "未经回看的候选", "frameIds": []}]})
                return {"output": {"message": {"role": "assistant", "content": [{"text": raw}]}}}
        with self.assertRaises(Exception) as no_frame:
            self._propose("video-first", NoFrame())
        self.assertIn("frame", str(no_frame.exception).lower())
        class Outside:
            def converse(self, **kwargs):
                return {"output": {"message": {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "inspect_frames", "input": {"times": [4.5]}}}]}}}
        with self.assertRaises(BroadcastError) as outside:
            self._propose("video-first", Outside())
        self.assertEqual(outside.exception.code, "schema_invalid")
