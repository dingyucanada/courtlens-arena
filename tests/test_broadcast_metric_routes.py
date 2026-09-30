"""Independent metric intake endpoint checks using real local media and mocked AWS.

Tests verify preparation vs explicit import, revision/owner boundaries and private
frame URLs. Synthetic definitions are never presented as official acceptance.
"""
import copy
import importlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.routes import BroadcastRoutes

FFMPEG = os.environ.get("COURTLENS_FFMPEG") or shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
PREFIX = "/api/broadcast/v1"


class _MetricRoutesFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not Path(FFMPEG).is_file() and not shutil.which(FFMPEG):
            raise unittest.SkipTest("ffmpeg unavailable")
        cls.video_temp = tempfile.TemporaryDirectory()
        cls.video = Path(cls.video_temp.name) / "input.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25",
                        "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(cls.video)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.video_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.routes = BroadcastRoutes(self.temp.name)
        self.service = self.routes.service
        p = self.service.create("字段映射接口演练", "manual")
        with self.video.open("rb") as stream:
            p = self.service.upload(p["id"], p["revision"], stream, self.video.stat().st_size, "input.mp4", "video/mp4")
        player = {"id": "player1", "name": "示例球员", "teamId": "team1", "jersey": None,
                  "source": "synthetic unit-test roster", "validOn": None}
        self.project = self.service.edit(p["id"], p["revision"], {"context": {"gameId": "game1", "roster": [player]}})
        self.row = {"rid": "r1", "metric": "test-gravity", "value": 1.8, "event": "event1",
                    "player": "player1", "observed": 1.5, "available": 2, "unit": "test-index"}
        self.request = {"format": "json", "text": json.dumps([self.row]), "sourceName": "raw-test.json",
            "granularity": "event", "timeBase": "video", "mapping": {"recordId": "rid", "metricId": "metric",
                "value": "value", "eventId": "event", "playerId": "player", "observedAt": "observed",
                "availableAt": "available", "unit": "unit"}, "dictionary": {"id": "test-dictionary", "version": "v-test",
                    "provenance": {"kind": "synthetic", "source": "route tests, not official"}, "metrics": {
                    "test-gravity": {"version": "definition-test", "label": "测试指标", "role": "gravity",
                        "semantics": "provider_on_ball_gravity_index", "unit": "test-index", "definition": "纯测试定义。",
                        "granularity": "event", "ballState": "on-ball"}}}}

    def post(self, action, body, project=None):
        project = project or self.project
        return self.routes.dispatch_json("POST", PREFIX + "/projects/" + project["id"] + "/" + action,
                                         {"expectedRevision": project["revision"], **body})

    def preview(self, request=None, project=None):
        status, result = self.post("metrics/preview", {"request": request or self.request}, project)
        self.assertEqual(status, 200)
        return result

    def observation(self):
        return {"id": "observation1", "type": "movement", "start": 1, "end": 2, "anchorTime": None,
            "segmentId": "segment1", "description": "画面中持球人移动", "playerIds": ["player1"],
            "unknownActors": [], "frameIds": [], "source": {"kind": "manual", "runId": None, "recordId": None},
            "confidence": None, "review": {"status": "accepted", "actor": "测试审核员", "reason": "synthetic test",
                                           "at": "2026-10-01T00:00:00Z"}, "geometry": None}

    def binding(self):
        return {"id": "binding1", "observationId": "observation1", "officialEventId": "event1", "shotId": None,
            "gameId": "game1", "playerId": "player1", "metricRecordIds": ["r1"],
            "timeMapping": {"source": "video", "videoTime": 1.5, "period": None, "clock": None, "mappingEvidenceIds": []},
            "status": "confirmed", "reason": "synthetic test mapping", "confirmedBy": "测试审核员",
            "confirmedAt": "2026-10-01T00:00:00Z"}


class MetricRoutesTest(_MetricRoutesFixture):
    def test_source_and_conversion_preview_leave_snapshot_revision_and_media_unchanged(self):
        folder = self.service.store.project_dir(self.project["id"])
        before = {path.relative_to(folder).as_posix(): path.read_bytes() for path in folder.rglob("*") if path.is_file()}
        status, source = self.post("metrics/source", {"format": "json", "text": self.request["text"]})
        self.assertEqual(status, 200)
        self.assertIn("observed", source["columns"])
        result = self.preview()
        self.assertEqual(result["projectRevision"], self.project["revision"])
        self.assertEqual(result["counts"]["accepted"], 1)
        self.assertIsNone(self.service.get(self.project["id"])["metrics"])
        after = {path.relative_to(folder).as_posix(): path.read_bytes() for path in folder.rglob("*") if path.is_file()}
        self.assertEqual(after, before)

    def test_stale_revisions_and_extra_route_fields_are_rejected_before_conversion(self):
        stale = {**self.project, "revision": self.project["revision"] - 1}
        for action, body in (("metrics/source", {"format": "json", "text": self.request["text"]}),
                             ("metrics/preview", {"request": self.request})):
            with self.subTest(action=action), self.assertRaises(BroadcastError) as error:
                self.post(action, body, stale)
            self.assertEqual(error.exception.code, "revision_conflict")
            self.assertEqual(error.exception.status, 409)
            with self.assertRaises(BroadcastError):
                self.post(action, {**body, "apply": True})
        self.assertEqual(self.service.get(self.project["id"])["revision"], self.project["revision"])

    def test_all_rejected_preview_never_provides_an_importable_empty_bundle(self):
        request = copy.deepcopy(self.request)
        request["text"] = json.dumps([self.row, {**self.row, "rid": "r2", "value": 7}])
        result = self.preview(request)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["counts"], {"source": 2, "accepted": 0, "rejected": 2})
        self.assertIsNone(result["bundle"])
        self.assertEqual(self.service.get(self.project["id"]), self.project)

    def test_explicit_import_preserves_audit_and_invalidates_old_binding_story_and_review(self):
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self.observation()]})
        bundle = self.preview(project=p)["bundle"]
        _, p = self.post("metrics", {"bundle": bundle}, p)
        p = self.service.edit(p["id"], p["revision"], {"bindings": [self.binding()]})
        story = {"schema": "courtlens-broadcast-story/1", "title": "测试解说", "audience": "fan",
            "sourceRange": {"start": 0, "end": 5}, "beats": [{"id": "beat1", "label": "观察",
                "sourceStart": 2, "sourceEnd": 4, "anchorTime": 2, "observationIds": ["observation1"],
                "bindingIds": [], "text": "画面中持球人移动", "explanationKind": "visible-fact",
                "metricRecordId": None, "secondaryLabel": None, "annotation": None}]}
        p = self.service.edit(p["id"], p["revision"], {"story": story})
        p = self.service.review(p["id"], p["revision"], "测试审核员",
                                {key: True for key in ("identity", "timing", "metrics", "wording", "geometry")}, "")
        self.assertIsNotNone(p["review"])
        result = self.preview(project=p)
        self.assertEqual(self.service.get(p["id"]), p)  # Preview does not revoke anything.
        _, imported = self.post("metrics", {"bundle": result["bundle"]}, p)
        self.assertEqual(imported["revision"], p["revision"] + 1)
        self.assertEqual(imported["bindings"], [])
        self.assertIsNone(imported["story"])
        self.assertIsNone(imported["review"])
        restored = self.service.get(p["id"])
        self.assertEqual(restored["metrics"]["intakeAudit"], result["bundle"]["intakeAudit"])
        self.assertEqual(restored["metrics"]["records"][0]["intake"]["rawRow"], self.row)

    def test_unknown_value_or_availability_cannot_be_confirmed_binding(self):
        p = self.service.edit(self.project["id"], self.project["revision"], {"observations": [self.observation()]})
        for field in ("value", "available"):
            with self.subTest(field=field):
                request = copy.deepcopy(self.request)
                request["text"] = json.dumps([{**self.row, field: None}])
                bundle = self.preview(request, p)["bundle"]
                _, p = self.post("metrics", {"bundle": bundle}, p)
                with self.assertRaises(BroadcastError) as error:
                    self.service.edit(p["id"], p["revision"], {"bindings": [self.binding()]})
                self.assertEqual(error.exception.code, "unresolved_binding")
                self.assertEqual(self.service.get(p["id"])["bindings"], [])

    def test_game_clock_preview_reads_existing_real_frame_anchors_without_revision_change(self):
        frames = self.service.frames(self.project["id"], self.project["revision"], [1, 4])["frames"]
        p = self.service.get(self.project["id"])
        request = copy.deepcopy(self.request)
        request["timeBase"] = "game-clock"
        request["clockAlignment"] = {"segmentId": "segment1", "period": 1,
            "anchors": [{"frameId": frames[0]["id"], "clock": "10:00"}, {"frameId": frames[1]["id"], "clock": "09:57"}]}
        request["text"] = json.dumps([{**self.row, "observed": "09:59", "available": "09:58"}])
        result = self.preview(request, p)
        record = result["bundle"]["records"][0]
        self.assertAlmostEqual(record["time"]["observedAt"], 2)
        self.assertAlmostEqual(record["time"]["availableAt"], 3)
        self.assertEqual(self.service.get(p["id"])["revision"], p["revision"])
        self.assertEqual(set(record["intake"]["clockMappings"]), {"observedAt", "availableAt"})


class CloudMetricRoutesTest(_MetricRoutesFixture):
    """Run the real cloud handler/service over mocked owner pointers and hydration."""
    def setUp(self):
        super().setUp()
        try:
            import boto3
        except ImportError:
            raise unittest.SkipTest("boto3 unavailable")
        self.frames = self.service.frames(self.project["id"], self.project["revision"], [1, 4])["frames"]
        self.project = self.service.get(self.project["id"])
        self.owner, self.job_id = "owner-one", "d" * 32
        self.signed = []
        test = self
        class DDB:
            def get_item(self, **kwargs):
                key = kwargs["Key"]
                if key["pk"]["S"] != "OWNER#" + test.owner:
                    return {}
                if key["sk"]["S"] == "PROJECT#" + test.project["id"]:
                    return {"Item": {"revision": {"N": str(test.project["revision"])},
                            "snapshotKey": {"S": f"projects/{test.project['id']}/snapshots/" + "e" * 32 + ".zip"},
                            "title": {"S": test.project["title"]}}}
                if key["sk"]["S"] == "JOB#" + test.job_id:
                    return {"Item": {"projectId": {"S": test.project["id"]}, "jobType": {"S": "frames"},
                        "expectedRevision": {"N": str(test.project["revision"])}, "status": {"S": "succeeded"},
                        "framesResult": {"S": json.dumps(test.frames)}}}
                return {}
        class S3:
            def generate_presigned_url(self, operation, **kwargs):
                test.signed.append({"operation": operation, **kwargs})
                return "https://private.example.test/" + kwargs["Params"]["Key"] + "?signed=test&expires=600"
        self.s3, self.ddb = S3(), DDB()
        settings = {"TABLE_NAME": "table-test", "INPUT_BUCKET": "private-input-test", "RELEASE_BUCKET": "release-test", "AWS_REGION": "us-east-1"}
        env = patch.dict(os.environ, settings)
        env.start()
        self.addCleanup(env.stop)
        clients = patch.object(boto3, "client", side_effect=lambda name, **kwargs: self.ddb if name == "dynamodb" else self.s3 if name == "s3" else object())
        clients.start()
        self.addCleanup(clients.stop)
        # Patch cached clients as well as construction; this is safe when another
        # cloud suite imported these modules earlier, and cleanup restores them.
        snapshot = importlib.import_module("cloud.common.snapshot")
        self.api = importlib.import_module("cloud.api.api")
        for module, name, value in ((snapshot, "s3", self.s3), (snapshot, "ddb", self.ddb),
                                    (self.api, "S3", self.s3), (self.api, "DDB", self.ddb),
                                    (self.api, "INPUT", settings["INPUT_BUCKET"]),
                                    (self.api, "TABLE", settings["TABLE_NAME"]),
                                    (self.api, "RELEASES", settings["RELEASE_BUCKET"])):
            mocked = patch.object(module, name, value)
            mocked.start()
            self.addCleanup(mocked.stop)
        def hydrate(bucket, snapshot_key, project_id, root, **kwargs):
            target = Path(root) / "broadcast" / project_id
            shutil.copytree(self.service.store.project_dir(project_id), target)
            return target
        self.hydration = patch.object(self.api, "hydrate", side_effect=hydrate)
        self.hydration_mock = self.hydration.start()
        self.addCleanup(self.hydration.stop)
        self.persistence = patch.object(self.api, "persist")
        self.persist_mock = self.persistence.start()
        self.addCleanup(self.persistence.stop)

    def event(self, action, body=None, owner="owner-one", method="POST"):
        path = PREFIX + ("/jobs/" + self.job_id if action == "job" else "/projects/" + self.project["id"] + "/" + action)
        event = {"httpMethod": method, "path": path, "body": json.dumps(body) if body is not None else ""}
        if owner is not None:
            event["requestContext"] = {"authorizer": {"claims": {"sub": owner}}}
        return event

    def test_cloud_source_and_preview_use_authenticated_owner_and_never_persist(self):
        for action, body in (("metrics/source", {"expectedRevision": self.project["revision"], "format": "json", "text": self.request["text"]}),
                             ("metrics/preview", {"expectedRevision": self.project["revision"], "request": self.request})):
            response = self.api.handler(self.event(action, body), None)
            self.assertEqual(response["statusCode"], 200, response["body"])
            self.assertIn("data", json.loads(response["body"]))
        self.persist_mock.assert_not_called()
        self.assertEqual(self.service.get(self.project["id"]), self.project)
        self.assertEqual(self.signed, [])

    def test_cloud_wrong_owner_and_anonymous_requests_cannot_access_preview_or_frames(self):
        body = {"expectedRevision": self.project["revision"], "request": self.request}
        for owner, status in ((None, 401), ("other-owner", 404)):
            for action, method, payload in (("metrics/preview", "POST", body), ("preflight", "GET", None), ("job", "GET", None)):
                with self.subTest(owner=owner, action=action):
                    result = self.api.handler(self.event(action, payload, owner, method), None)
                    self.assertEqual(result["statusCode"], status, result["body"])
                    self.assertNotIn("signed=test", result["body"])
        self.hydration_mock.assert_not_called()
        self.assertEqual(self.signed, [])

    def test_cloud_preflight_and_frame_jobs_presign_only_owner_frame_png_for_ten_minutes(self):
        for action in ("preflight", "job"):
            result = self.api.handler(self.event(action, method="GET"), None)
            self.assertEqual(result["statusCode"], 200, result["body"])
            report = json.loads(result["body"])["data"]
            frames = report["frames"] if action == "preflight" else report["result"]["frames"]
            self.assertEqual(len(frames), 2)
            self.assertTrue(all(frame["url"].startswith("https://private.example.test/") for frame in frames))
            self.assertNotIn("source.mp4", result["body"])
        self.assertEqual(len(self.signed), 4)
        for signed in self.signed:
            self.assertEqual(signed["Params"]["Bucket"], "private-input-test")
            self.assertTrue(signed["Params"]["Key"].startswith("projects/" + self.project["id"] + "/frames/"))
            self.assertTrue(signed["Params"]["Key"].endswith("/frame.png"))
            self.assertEqual(signed["ExpiresIn"], 600)
        self.persist_mock.assert_not_called()

    def test_cloud_stale_preview_revision_returns_409_and_does_not_sign_or_persist(self):
        body = {"expectedRevision": self.project["revision"] - 1, "request": self.request}
        result = self.api.handler(self.event("metrics/preview", body), None)
        self.assertEqual(result["statusCode"], 409, result["body"])
        self.assertEqual(json.loads(result["body"])["error"]["code"], "revision_conflict")
        self.persist_mock.assert_not_called()
        self.assertEqual(self.signed, [])


if __name__ == "__main__":
    unittest.main()
