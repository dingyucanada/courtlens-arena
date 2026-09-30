"""Cloud frame 202/poll contract without AWS calls."""
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.update(TABLE_NAME="fixture", INPUT_BUCKET="private", RELEASE_BUCKET="published")
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
fake_boto = types.ModuleType("boto3")
fake_boto.client = lambda name: object()
sys.modules.setdefault("boto3", fake_boto)
fake_botocore = types.ModuleType("botocore")
fake_exceptions = types.ModuleType("botocore.exceptions")
fake_exceptions.ClientError = type("ClientError", (Exception,), {})
sys.modules.setdefault("botocore", fake_botocore)
sys.modules.setdefault("botocore.exceptions", fake_exceptions)

from cloud.api import api  # noqa: E402


class FramesContract(unittest.TestCase):
    def test_cloud_capabilities_report_configured_renderer_without_claiming_verification(self):
        event = {"httpMethod": "GET", "path": "/api/broadcast/v1/capabilities",
                 "requestContext": {"authorizer": {"claims": {"sub": "owner"}}}}
        response = api.handler(event, None)
        self.assertEqual(response["statusCode"], 200)
        capabilities = json.loads(response["body"])["data"]
        self.assertTrue(capabilities["renderer"]["available"])
        self.assertEqual(capabilities["deployment"]["mode"], "aws")
        self.assertFalse(capabilities["deployment"]["verified"])
        voices = {row["id"]: row for row in capabilities["providers"] if row["kind"] == "voice"}
        self.assertFalse(voices["minimax"]["available"])
        self.assertFalse(voices["stepfun"]["available"])
        self.assertFalse(voices["polly"]["available"])

    def test_configured_voice_capability_is_not_claimed_verified(self):
        event = {"httpMethod": "GET", "path": "/api/broadcast/v1/capabilities",
                 "requestContext": {"authorizer": {"claims": {"sub": "owner"}}}}
        with patch.object(api, "VOICE_PROVIDERS", frozenset({"minimax", "stepfun", "polly"})):
            response = api.handler(event, None)
        voices = [row for row in json.loads(response["body"])["data"]["providers"] if row["kind"] == "voice"]
        self.assertEqual({row["id"] for row in voices}, {"minimax", "stepfun", "polly"})
        self.assertTrue(all(row["configured"] and row["available"] and not row["verified"] for row in voices))

    def test_mutation_response_renews_private_media_url_after_cas(self):
        pid, mid = "a" * 32, "b" * 32
        source = {"id": pid, "title": "Review", "revision": 4,
                  "media": {"id": mid, "mediaUrl": f"/api/broadcast/v1/media/{mid}"}, "releases": []}

        def hydrate(bucket, key, project_id, root):
            folder = Path(root) / "broadcast" / project_id
            folder.mkdir(parents=True)
            (folder / "project.json").write_text(json.dumps(source))
            return folder

        def mutate(svc, current, root):
            updated = {**current, "revision": 5}
            (Path(root) / "broadcast" / pid / "project.json").write_text(json.dumps(updated))
            return updated

        with patch.object(api, "get_project", return_value={"snapshotKey": "snapshot", "revision": 4}), \
             patch.object(api, "hydrate", side_effect=hydrate), patch.object(api, "service"), \
             patch.object(api, "persist") as persist, patch.object(api, "media_object", return_value=f"projects/{pid}/media/{mid}/source.mp4"), \
             patch.object(api, "S3") as s3:
            s3.generate_presigned_url.return_value = "https://signed.example/fresh"
            result = api.with_project("owner", pid, mutate, True)
        persist.assert_called_once()
        self.assertEqual(result["media"]["mediaUrl"], "https://signed.example/fresh")
        self.assertEqual(source["media"]["mediaUrl"], f"/api/broadcast/v1/media/{mid}")

    def test_post_frames_returns_202_job_with_exact_options(self):
        pid = "a" * 32
        request = {"expectedRevision": 4, "times": [1.25, 2]}
        event = {"httpMethod": "POST", "path": f"/api/broadcast/v1/projects/{pid}/frames",
                 "requestContext": {"authorizer": {"claims": {"sub": "owner"}}},
                 "headers": {"Idempotency-Key": "frames-12345"}, "body": json.dumps(request)}
        with patch.object(api, "start_job", return_value={"id": "b" * 32, "type": "frames", "status": "queued"}) as start:
            response = api.handler(event, None)
        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(json.loads(response["body"])["data"]["type"], "frames")
        start.assert_called_once_with("owner", pid, 4, "frames", {"times": [1.25, 2]}, "frames-12345")

    def test_poll_renews_private_frame_url(self):
        pid, fid, jid = "a" * 32, "b" * 32, "c" * 32
        frame = {"id": fid, "mediaSha256": "d" * 64, "sha256": "e" * 64,
                 "requestedTime": 1, "actualTime": 1, "pts": 30, "timeBase": "1/30",
                 "url": f"/api/broadcast/v1/frames/{fid}", "width": 640, "height": 360}
        row = {"status": {"S": "succeeded"}, "projectId": {"S": pid}, "expectedRevision": {"N": "4"},
               "jobType": {"S": "frames"}, "framesResult": {"S": json.dumps([frame])}}
        with patch.object(api, "DDB") as ddb, patch.object(api, "S3") as s3:
            ddb.get_item.return_value = {"Item": row}
            s3.generate_presigned_url.side_effect = ["https://signed.example/one", "https://signed.example/two"]
            first, second = api.get_job("owner", jid), api.get_job("owner", jid)
        self.assertEqual(first["result"]["frames"][0]["url"], "https://signed.example/one")
        self.assertEqual(second["result"]["frames"][0]["url"], "https://signed.example/two")
        self.assertEqual(frame["url"], f"/api/broadcast/v1/frames/{fid}")
        self.assertEqual(s3.generate_presigned_url.call_args.kwargs["Params"],
                         {"Bucket": "private", "Key": f"projects/{pid}/frames/{fid}/frame.png"})

    def test_model_story_uses_async_agentcore_job(self):
        pid = "a" * 32
        event = {"httpMethod": "POST", "path": f"/api/broadcast/v1/projects/{pid}/story",
                 "requestContext": {"authorizer": {"claims": {"sub": "owner"}}},
                 "headers": {"Idempotency-Key": "story-12345"},
                 "body": json.dumps({"expectedRevision": 7, "audience": "fan", "mode": "model", "providerId": "agentcore-story"})}
        with patch.object(api, "start_job", return_value={"id": "b" * 32, "type": "model-story", "status": "queued"}) as start:
            response = api.handler(event, None)
        self.assertEqual(response["statusCode"], 202)
        start.assert_called_once_with("owner", pid, 7, "model-story", {"audience": "fan", "providerId": "agentcore-story", "commentaryStyle": "zh-analysis", "language": None}, "story-12345")

    def test_model_story_forwards_language_independently_of_style(self):
        pid = "a" * 32
        for language in ("zh-CN", "en-US", "yue-HK"):
            event = {"httpMethod": "POST", "path": f"/api/broadcast/v1/projects/{pid}/story",
                     "requestContext": {"authorizer": {"claims": {"sub": "owner"}}},
                     "headers": {"Idempotency-Key": "story-language"},
                     "body": json.dumps({"expectedRevision": 7, "audience": "fan", "mode": "model",
                                         "providerId": "agentcore-story", "commentaryStyle": "data", "language": language})}
            with self.subTest(language=language), patch.object(api, "start_job", return_value={"id": "b" * 32}) as start:
                response = api.handler(event, None)
                self.assertEqual(response["statusCode"], 202)
                start.assert_called_once_with("owner", pid, 7, "model-story",
                    {"audience": "fan", "providerId": "agentcore-story", "commentaryStyle": "data", "language": language},
                    "story-language")

    def test_model_story_poll_reports_committed_revision(self):
        pid, jid, audit = "a" * 32, "c" * 32, "d" * 32
        row = {"status": {"S": "succeeded"}, "projectId": {"S": pid}, "expectedRevision": {"N": "7"},
               "jobType": {"S": "model-story"}, "resultRevision": {"N": "8"}, "resultId": {"S": audit}}
        with patch.object(api, "DDB") as ddb:
            ddb.get_item.return_value = {"Item": row}
            job = api.get_job("owner", jid)
        self.assertEqual(job["result"], {"projectId": pid, "projectRevision": 8})
        self.assertEqual(job["resultId"], audit)

    def test_cancel_releases_lock_when_stop_execution_fails(self):
        jid = "a" * 32
        running = {"status": "running", "type": "frames"}
        cancelled = {"status": "cancelled", "type": "frames"}
        row = {"executionArn": {"S": "arn:aws:states:fixture:execution:job"}, "jobType": {"S": "frames"}}
        with patch.object(api, "get_job", side_effect=[running, cancelled]), patch.object(api, "DDB") as ddb, \
             patch.object(api, "SFN") as sfn:
            ddb.get_item.return_value = {"Item": row}
            sfn.stop_execution.side_effect = RuntimeError("transport timeout")
            result = api.cancel_job("owner", jid)
        self.assertEqual(result["status"], "cancelled")
        ddb.delete_item.assert_called_once()
        self.assertEqual(ddb.delete_item.call_args.kwargs["Key"]["sk"]["S"], "LOCK#analyze")


if __name__ == "__main__":
    unittest.main()
