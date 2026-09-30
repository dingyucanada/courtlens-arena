"""Publish safety checks with fake AWS clients; no AWS credentials or network."""
import os
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.update(TABLE_NAME="fixture", INPUT_BUCKET="private", RELEASE_BUCKET="published",
                  OWNER_ID="owner", JOB_ID="a" * 32)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

fake_boto = types.ModuleType("boto3")
fake_boto.client = lambda name: object()
sys.modules.setdefault("boto3", fake_boto)
fake_botocore = types.ModuleType("botocore")
fake_exceptions = types.ModuleType("botocore.exceptions")
fake_exceptions.ClientError = type("ClientError", (Exception,), {})
sys.modules.setdefault("botocore", fake_botocore)
sys.modules.setdefault("botocore.exceptions", fake_exceptions)

from cloud.common.snapshot import Conflict  # noqa: E402
from cloud.render import runner  # noqa: E402


class FakeS3:
    def __init__(self):
        self.public_writes = []
        self.objects = {}

    def upload_file(self, source, bucket, key, ExtraArgs=None):
        self.public_writes.append((bucket, key))

    def put_object(self, Bucket, Key, Body, **kwargs):
        self.public_writes.append((Bucket, Key))
        self.objects[Key] = Body


class WorkerPublishSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pid = "b" * 32
        self.rid = "c" * 32
        folder = Path(self.temp.name) / "broadcast" / self.pid / "releases" / self.rid
        folder.mkdir(parents=True)
        for name in ("captions.vtt", "manifest.json", "summary.json", "film.mp4"):
            (folder / name).write_bytes(b"verified")
        self.job = {"expectedRevision": 3}
        self.previous = {"snapshotKey": f"projects/{self.pid}/snapshots/" + "d" * 32 + ".zip"}
        self.updated = {"revision": 3, "title": "Review"}
        self.result = {"job": {"status": "succeeded"}, "release": {"id": self.rid}}
        self.s3 = FakeS3()

    def test_cas_conflict_writes_no_public_release(self):
        with patch.object(runner, "S3", self.s3), patch.object(runner, "still_running"), \
             patch.object(runner, "set_job"), patch.object(runner, "persist", side_effect=Conflict("stale")):
            with self.assertRaises(Conflict):
                runner.commit_and_publish(self.temp.name, self.pid, self.job, self.previous, self.updated, self.result)
        self.assertEqual(self.s3.public_writes, [])

    def test_cancel_before_commit_writes_nothing(self):
        with patch.object(runner, "S3", self.s3), patch.object(runner, "still_running", side_effect=Conflict("cancelled")), \
             patch.object(runner, "set_job") as state, patch.object(runner, "persist") as save:
            with self.assertRaises(Conflict):
                runner.commit_and_publish(self.temp.name, self.pid, self.job, self.previous, self.updated, self.result)
            state.assert_not_called()
            save.assert_not_called()
        self.assertEqual(self.s3.public_writes, [])

    def test_frame_cas_conflict_does_not_mark_job_success(self):
        frame_id = "e" * 32
        frame_folder = Path(self.temp.name) / "broadcast" / self.pid / "frames" / frame_id
        frame_folder.mkdir(parents=True)
        (frame_folder / "frame.png").write_bytes(b"png")
        frame = {"id": frame_id, "mediaSha256": "f" * 64, "sha256": "0" * 64,
                 "requestedTime": 2, "actualTime": 2, "pts": 2, "timeBase": "1/1",
                 "url": "/api/broadcast/v1/frames/" + frame_id, "width": 640, "height": 360}
        with patch.object(runner, "S3", self.s3), patch.object(runner, "still_running"), \
             patch.object(runner, "set_job") as state, patch.object(runner, "persist", side_effect=Conflict("stale")), \
             patch.object(runner, "DDB") as ddb:
            with self.assertRaises(Conflict):
                runner.commit_frames(self.temp.name, self.pid, self.job, self.previous, self.updated, [frame])
            state.assert_called_once_with("committing", expected="running")
            ddb.update_item.assert_not_called()
        self.assertEqual(self.s3.public_writes, [("private", f"projects/{self.pid}/frames/{frame_id}/frame.png")])

    def test_cancel_before_frame_commit_writes_no_frame(self):
        with patch.object(runner, "S3", self.s3), patch.object(runner, "still_running", side_effect=Conflict("cancelled")), \
             patch.object(runner, "set_job") as state, patch.object(runner, "persist") as save:
            with self.assertRaises(Conflict):
                runner.commit_frames(self.temp.name, self.pid, self.job, self.previous, self.updated, [])
            state.assert_not_called()
            save.assert_not_called()
        self.assertEqual(self.s3.public_writes, [])

    def test_public_manifest_removes_private_source_url_and_rehashes(self):
        from core.broadcast.common import hash_json
        folder = Path(self.temp.name) / "broadcast" / self.pid / "releases" / self.rid
        manifest = {"schema": "courtlens-broadcast-release/1", "source": {"mediaUrl": "/api/broadcast/v1/media/secret"}}
        manifest["manifestHash"] = hash_json(manifest)
        (folder / "manifest.json").write_text(json.dumps(manifest))
        assets = [("manifest.json", "application/json", folder / "manifest.json")]
        with patch.object(runner, "S3", self.s3):
            runner.publish_release(self.rid, assets)
        public = json.loads(self.s3.objects[f"releases/{self.rid}/manifest.json"])
        self.assertIsNone(public["source"]["mediaUrl"])
        self.assertFalse(public["source"]["playbackAvailable"])
        public_hash = public.pop("manifestHash")
        self.assertEqual(public_hash, hash_json(public))

    def test_main_passes_hydrated_project_to_frame_extraction(self):
        pid = self.pid
        media = {"id": "e" * 32, "sha256": "f" * 64}
        hydrated = {"id": pid, "title": "Frame test", "revision": 3, "media": media}
        pointer = {"revision": 3, "snapshotKey": "projects/" + pid + "/snapshots/" + "d" * 32 + ".zip"}
        job = {"projectId": pid, "expectedRevision": 3, "jobType": "frames", "options": {"times": [1]}}

        def hydrate(bucket, key, project_id, root, include_media=False):
            folder = Path(root) / "broadcast" / project_id
            folder.mkdir(parents=True)
            (folder / "project.json").write_text(json.dumps(hydrated))
            self.assertTrue(include_media)
            return folder

        with patch.object(runner, "load_job", return_value=job), patch.object(runner, "get_project", return_value=pointer), \
             patch.object(runner, "hydrate", side_effect=hydrate), patch.object(runner, "extract_frames", return_value={"frames": []}) as extract, \
             patch.object(runner, "commit_frames") as commit, patch.object(runner, "set_job"), patch.object(runner, "unlock"):
            runner.main()
        self.assertEqual(extract.call_args.args[2], hydrated)
        commit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
