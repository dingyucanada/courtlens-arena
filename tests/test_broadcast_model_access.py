"""Offline model declarations and probe isolation; no model/AWS calls."""
import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.common import BroadcastError, now
from core.broadcast.providers import capabilities, check_configured
from core.broadcast.providers.model_access import (configuration_fingerprint, declared_modalities,
    matching_probe, probe_filename, require_access, supports)
from core.broadcast.service import BroadcastService

VISUAL = {"COURTLENS_BEDROCK_MODALITIES": "text,image,video", "COURTLENS_BEDROCK_TOOLS": "1",
          "COURTLENS_SEMANTIC_MODEL_ID": "fixture-model", "COURTLENS_VISION_MODEL_ID": "fixture-model",
          "COURTLENS_BEDROCK_REGION": "us-east-1"}


class ModelAccessTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def rows(self):
        with patch("importlib.util.find_spec", return_value=object()), patch("shutil.which", return_value=None):
            return {row["id"]: row for row in capabilities(self.root)}

    def record(self, pid="bedrock-video", strategy="video-first", **changes):
        row = {"passed": True, "fingerprint": configuration_fingerprint(pid), "strategy": strategy, "at": now(), **changes}
        (self.root / probe_filename(pid, strategy)).write_text(json.dumps(row))
        return row

    def test_text_default_never_infers_visual_from_model_name(self):
        os.environ.update(COURTLENS_SEMANTIC_MODEL_ID="qwen-235b-example", COURTLENS_BEDROCK_REGION="us-east-1")
        self.assertEqual(declared_modalities(), ["text"])
        self.assertTrue(supports("bedrock-story"))
        rows = self.rows()
        self.assertTrue(rows["bedrock-story"]["available"])
        self.assertFalse(rows["bedrock-video"]["available"])
        self.assertNotIn("video", rows["bedrock-video"]["modalities"])
        for strategy in ("video-first", "frames-first"):
            with self.assertRaises(BroadcastError):
                check_configured("analyze", {"providerId": "bedrock-video", "strategy": strategy})

    def test_video_needs_image_and_tools_and_malformed_declarations_close(self):
        os.environ.update(VISUAL)
        require_access("bedrock-video", "video-first")
        self.assertFalse(supports("bedrock-image", "video-first"))
        for value in ("text,video", "text,unknown", "", "text,text,image,video"):
            os.environ["COURTLENS_BEDROCK_MODALITIES"] = value
            self.assertFalse(supports("bedrock-video", "video-first"))
        os.environ.update(VISUAL)
        os.environ["COURTLENS_BEDROCK_TOOLS"] = "true"
        self.assertFalse(supports("bedrock-video", "video-first"))

    def test_image_probe_does_not_verify_video(self):
        os.environ.update(VISUAL)
        self.record(strategy="frames-first")
        self.assertIsNotNone(matching_probe(self.root, "bedrock-video", "frames-first"))
        self.assertFalse(self.rows()["bedrock-video"]["verified"])
        self.record("bedrock-image", "frames-first")
        self.assertTrue(self.rows()["bedrock-image"]["verified"])
        self.record()
        self.assertTrue(self.rows()["bedrock-video"]["verified"])

    def test_model_region_profile_and_declaration_changes_invalidate_probe(self):
        os.environ.update(VISUAL)
        self.record()
        for key, value in (("COURTLENS_SEMANTIC_MODEL_ID", "different-model"),
                           ("COURTLENS_BEDROCK_REGION", "us-west-2"),
                           ("COURTLENS_ALLOWED_INFERENCE_PROFILE", "other-profile"),
                           ("COURTLENS_BEDROCK_TOOLS", "0"),
                           ("COURTLENS_BEDROCK_MODALITIES", "text,image")):
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                self.assertFalse(self.rows()["bedrock-video"]["verified"])
        del os.environ["COURTLENS_SEMANTIC_MODEL_ID"]
        self.assertFalse(self.rows()["bedrock-video"]["verified"])

    def test_legacy_probe_record_and_nonboolean_pass_do_not_verify(self):
        os.environ.update(VISUAL)
        (self.root / "bedrock-video.json").write_text(json.dumps({"passed": True, "modelId": "fixture-model"}))
        self.assertFalse(self.rows()["bedrock-video"]["verified"])
        self.record(passed="false")
        self.assertFalse(self.rows()["bedrock-video"]["verified"])

    def test_successful_probe_persists_executed_strategy_and_configuration(self):
        os.environ.update(VISUAL)
        service = BroadcastService(self.root)
        project = service.create("Probe fixture", "manual")
        rid = "a" * 32
        row = {"id": "b" * 32, "type": "movement", "start": 0, "end": 1,
               "anchorTime": None, "segmentId": "s1", "description": "模拟响应仅测试协议",
               "playerIds": [], "unknownActors": [], "frameIds": [],
               "source": {"kind": "model", "runId": rid, "recordId": None}, "confidence": None,
               "review": {"status": "unreviewed", "actor": None, "reason": None, "at": None}, "geometry": None}
        run = {"providerRun": {"id": rid, "modelId": "fixture-model"}, "observations": [row]}
        with patch("core.broadcast.providers.execute", return_value=run):
            job = service.start_job(project["id"], project["revision"], "probe-provider",
                                    {"providerId": "bedrock-video", "strategy": "frames-first"})
            service._threads[job["id"]].join(5)
        self.assertEqual(service.job(job["id"])["status"], "succeeded")
        record = matching_probe(service.store.root, "bedrock-video", "frames-first")
        self.assertTrue(record["passed"])
        self.assertEqual(record["fingerprint"], configuration_fingerprint("bedrock-video"))
        self.assertIsNone(matching_probe(service.store.root, "bedrock-video", "video-first"))

    def test_current_probe_failure_replaces_prior_pass_for_only_that_strategy(self):
        os.environ.update(VISUAL)
        service = BroadcastService(self.root)
        project = service.create("Probe fixture", "manual")
        provider_root = service.store.root
        for strategy in ("video-first", "frames-first"):
            (provider_root / probe_filename("bedrock-video", strategy)).write_text(json.dumps({
                "passed": True, "fingerprint": configuration_fingerprint("bedrock-video"), "strategy": strategy, "at": now()}))
        for failure in (BroadcastError("provider_failed", "offline failure", 502), RuntimeError("offline failure")):
            with self.subTest(error=type(failure).__name__), patch("core.broadcast.providers.execute", side_effect=failure):
                job = service.start_job(project["id"], project["revision"], "probe-provider", {"providerId": "bedrock-video", "strategy": "video-first"})
                service._threads[job["id"]].join(5)
                self.assertEqual(service.job(job["id"])["status"], "failed")
            self.assertFalse(matching_probe(provider_root, "bedrock-video", "video-first")["passed"])
            self.assertTrue(matching_probe(provider_root, "bedrock-video", "frames-first")["passed"])

    def test_cloud_text_only_capability_and_enqueue_gate(self):
        import boto3
        os.environ.update(TABLE_NAME="fixture", INPUT_BUCKET="fixture", RELEASE_BUCKET="fixture", MODEL_ID="fixture-text", AWS_REGION="us-east-1")
        with patch.object(boto3, "client", return_value=object()):
            api = importlib.reload(importlib.import_module("cloud.api.api"))
        event = {"httpMethod": "GET", "path": "/api/broadcast/v1/capabilities",
                 "requestContext": {"authorizer": {"claims": {"sub": "fixture-owner"}}}}
        rows = {row["id"]: row for row in json.loads(api.handler(event, None)["body"])["data"]["providers"]}
        self.assertFalse(rows["agentcore-proposal"]["available"])
        self.assertTrue(rows["agentcore-story"]["available"])
        self.assertFalse(rows["agentcore-story"]["verified"])
        event.update(httpMethod="POST", path="/api/broadcast/v1/projects/" + "a" * 32 + "/analyze",
                     body=json.dumps({"expectedRevision": 0, "providerId": "agentcore-proposal", "strategy": "video-first"}))
        with patch.object(api, "start_job", side_effect=AssertionError("must not queue")):
            self.assertEqual(api.handler(event, None)["statusCode"], 422)
        with patch.dict(os.environ, VISUAL), patch.object(api, "start_job", return_value={"status": "queued"}) as enqueue:
            self.assertEqual(api.handler(event, None)["statusCode"], 202)
            enqueue.assert_called_once()


if __name__ == "__main__":
    unittest.main()
