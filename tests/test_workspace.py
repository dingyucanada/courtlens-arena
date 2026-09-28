"""Real SQLite reopen, transaction conflict, media probing and isolation tests."""

import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core.workspace import MAX_MEDIA_BYTES, Workspace, WorkspaceError, sha256_file
from core.workspace_routes import FileResponse, Response, WorkspaceRoutes
from core.jobs import JobManager


def small_dataset():
    d = json.loads((ROOT / "data" / "demo.json").read_text(encoding="utf-8"))
    d["video"] = {"url": "/unbound.mp4", "duration": 1, "width": 64, "height": 48}
    p = d["possessions"][0]
    p.update(start=0, end=1, shot_time=0.4, result_time=0.7, tracks=[], annotations=[])
    p["camera_segments"] = [{"start": 0, "end": 1, "calibrated": False}]
    p["metrics"] = dict.fromkeys(("xfg_pct", "gravity", "leverage"))
    d["possessions"] = [p]
    d["workflow"] = {"state": "reviewed"}
    return d


class MediaTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise unittest.SkipTest("Real media tests require local FFmpeg and FFprobe")
        cls.media_temp = tempfile.TemporaryDirectory(prefix="courtlens-test-video-")
        cls.source = Path(cls.media_temp.name) / "test.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=64x48:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.source)], check=True, capture_output=True, timeout=20)
        cls.video_bytes = cls.source.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.media_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="courtlens-workspace-test-")
        self.root = Path(self.temp.name) / "workspace"
        self.workspace = Workspace(self.root, app_root=ROOT, render_python=os.environ.get("COURTLENS_RENDER_PYTHON", sys.executable))
        self.dataset = small_dataset()

    def tearDown(self):
        self.temp.cleanup()

    def registered_project(self, name="可复核项目"):
        project = self.workspace.create_project(name, self.dataset)
        return self.workspace.import_media(project["id"], io.BytesIO(self.video_bytes), len(self.video_bytes), "本地视频.mp4", 1, "video/mp4")

    def assert_workspace_error(self, status, call, code=None):
        with self.assertRaises(WorkspaceError) as caught:
            call()
        self.assertEqual(caught.exception.status, status)
        if code:
            self.assertEqual(caught.exception.code, code)


class WorkspaceTests(MediaTestCase):
    def test_longer_audio_tail_is_rejected_before_media_registration(self):
        uneven = Path(self.temp.name) / "audio-tail.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=64x48:r=10:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(uneven)], check=True, capture_output=True, timeout=20)
        project = self.workspace.create_project("尾部不齐", self.dataset)
        with self.assertRaisesRegex(WorkspaceError, "画面轨短于容器"):
            content = uneven.read_bytes()
            self.workspace.import_media(project["id"], io.BytesIO(content), len(content), "uneven.mp4", 1)
        self.assertEqual(self.workspace.get_project(project["id"])["revision"], 1)
        self.assertIsNone(self.workspace.get_project(project["id"])["media"])
        self.assertEqual(list((self.root / "incoming").iterdir()), [])

    def test_reopen_keeps_current_and_history_and_restore_creates_new_revision(self):
        project = self.workspace.create_project("初始名称", self.dataset)
        changed = copy.deepcopy(self.dataset)
        changed["possessions"][0]["title"] = "已核对的回合"
        saved = self.workspace.save_project(project["id"], "新名称", changed, 1)
        self.assertEqual(saved["revision"], 2)
        reopened = Workspace(self.root, app_root=ROOT)
        self.assertEqual(reopened.get_project(project["id"])["dataset"]["possessions"][0]["title"], "已核对的回合")
        restored = reopened.restore_project(project["id"], 1, 2)
        self.assertEqual((restored["name"], restored["revision"]), ("初始名称", 3))
        self.assertEqual([r["revision"] for r in reopened.history(project["id"])], [3, 2, 1])
        self.assertEqual(reopened.list_projects()[0]["possession_count"], 1)

    def test_legacy_create_save_and_restore_require_explicit_review(self):
        legacy = copy.deepcopy(self.dataset)
        del legacy["workflow"]
        project = self.workspace.create_project("旧格式", legacy)
        self.assertEqual(project["dataset"]["workflow"], {"state": "draft"})
        reviewed = self.workspace.save_project(project["id"], "已复核", self.dataset, 1)
        self.assertEqual(reviewed["dataset"]["workflow"]["state"], "reviewed")
        dropped = self.workspace.save_project(project["id"], "遗漏声明", legacy, 2)
        self.assertEqual(dropped["dataset"]["workflow"]["state"], "draft")
        # An actual pre-product history row may have no workflow at all.
        with self.workspace.transaction() as db:
            db.execute("UPDATE revisions SET dataset_json=? WHERE project_id=? AND revision=1", (json.dumps(legacy), project["id"]))
        restored = self.workspace.restore_project(project["id"], 1, 3)
        self.assertEqual(restored["dataset"]["workflow"]["state"], "draft")

    def test_concurrent_saves_have_exactly_one_winner(self):
        project = self.workspace.create_project("初始", self.dataset)
        barrier = threading.Barrier(2)
        outcomes = []
        def save(name):
            barrier.wait()
            try:
                outcomes.append(self.workspace.save_project(project["id"], name, self.dataset, 1)["revision"])
            except WorkspaceError as exc:
                outcomes.append(exc.status)
        threads = [threading.Thread(target=save, args=(name,)) for name in ("编辑一", "编辑二")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertCountEqual(outcomes, [2, 409])
        self.assertEqual(len(self.workspace.history(project["id"])), 2)

    def test_failed_write_rolls_back_current_and_history(self):
        project = self.workspace.create_project("初始", self.dataset)
        original = self.workspace._write_revision
        def fail_after_write(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("injected commit failure")
        with mock.patch.object(self.workspace, "_write_revision", side_effect=fail_after_write):
            with self.assertRaises(RuntimeError):
                self.workspace.save_project(project["id"], "不得保存", self.dataset, 1)
        unchanged = self.workspace.get_project(project["id"])
        self.assertEqual((unchanged["name"], unchanged["revision"]), ("初始", 1))
        self.assertEqual(len(self.workspace.history(project["id"])), 1)

    def test_real_upload_fingerprint_persistence_and_historical_binding(self):
        project = self.registered_project()
        self.assertEqual(project["revision"], 2)
        self.assertEqual(project["media"]["sha256"], sha256_file(self.source))
        self.assertEqual(project["dataset"]["video"]["sha256"], sha256_file(self.source))
        self.assertNotIn("_storage", project["media"])
        path, mime = self.workspace.media_file(project["id"])
        self.assertEqual(path.read_bytes(), self.video_bytes)
        self.assertEqual(mime, "video/mp4")
        restored = self.workspace.restore_project(project["id"], 1, 2)
        self.assertIsNone(restored["media"])
        rebound = self.workspace.restore_project(project["id"], 2, 3)
        self.assertEqual(rebound["revision"], 4)
        self.assertEqual(self.workspace.media_file(project["id"])[0], path)
        self.assertEqual(list((self.root / "incoming").iterdir()), [])

    def test_interrupted_invalid_oversized_and_mismatched_uploads_do_not_mutate_project(self):
        project = self.workspace.create_project("待导入", self.dataset)
        self.assert_workspace_error(400, lambda: self.workspace.import_media(project["id"], io.BytesIO(b"short"), len(self.video_bytes), "file.mp4", 1), "upload_interrupted")
        self.assert_workspace_error(400, lambda: self.workspace.import_media(project["id"], io.BytesIO(b"not video"), 9, "file.mp4", 1), "invalid_media")
        self.assert_workspace_error(413, lambda: self.workspace.import_media(project["id"], io.BytesIO(b""), MAX_MEDIA_BYTES + 1, "file.mp4", 1), "media_too_large")
        changed = copy.deepcopy(self.dataset)
        changed["video"]["width"] = 128
        mismatch = self.workspace.create_project("尺寸不符", changed)
        self.assert_workspace_error(400, lambda: self.workspace.import_media(mismatch["id"], io.BytesIO(self.video_bytes), len(self.video_bytes), "file.mp4", 1), "media_dimensions_mismatch")
        changed["video"]["width"] = 64
        changed["video"]["duration"] = 2
        duration_mismatch = self.workspace.create_project("时长不符", changed)
        self.assert_workspace_error(400, lambda: self.workspace.import_media(duration_mismatch["id"], io.BytesIO(self.video_bytes), len(self.video_bytes), "file.mp4", 1), "media_duration_mismatch")
        self.assertEqual(self.workspace.get_project(project["id"])["revision"], 1)
        self.assertIsNone(self.workspace.get_project(project["id"])["media"])
        self.assertEqual(list((self.root / "incoming").iterdir()), [])
        self.assertEqual(list((self.root / "media").iterdir()), [])

    def test_upload_rechecks_revision_after_streaming(self):
        project = self.workspace.create_project("初始", self.dataset)
        workspace, dataset = self.workspace, self.dataset
        class SavingStream(io.BytesIO):
            def read(self, count=-1):
                if self.tell() == 0:
                    workspace.save_project(project["id"], "其他窗口保存", dataset, 1)
                return super().read(count)
        self.assert_workspace_error(409, lambda: self.workspace.import_media(project["id"], SavingStream(self.video_bytes), len(self.video_bytes), "file.mp4", 1), "revision_conflict")
        self.assertEqual(self.workspace.get_project(project["id"])["name"], "其他窗口保存")
        self.assertEqual(list((self.root / "media").iterdir()), [])
        self.assertEqual(list((self.root / "incoming").iterdir()), [])

    def test_upload_commit_failure_removes_unregistered_atomic_file(self):
        project = self.workspace.create_project("事务失败", self.dataset)
        with mock.patch.object(self.workspace, "_write_revision", side_effect=RuntimeError("commit fault")):
            with self.assertRaises(RuntimeError):
                self.workspace.import_media(project["id"], io.BytesIO(self.video_bytes), len(self.video_bytes), "file.mp4", 1)
        self.assertEqual(self.workspace.get_project(project["id"])["revision"], 1)
        self.assertEqual(list((self.root / "media").iterdir()), [])
        self.assertEqual(list((self.root / "incoming").iterdir()), [])

    def test_failed_upload_cleanup_preserves_another_projects_identical_blob(self):
        first = self.workspace.create_project("失败上传", self.dataset)
        second = self.workspace.create_project("成功上传", self.dataset)
        cleanup_entered, allow_cleanup = threading.Event(), threading.Event()
        original_write, original_cleanup = self.workspace._write_revision, self.workspace._discard_unregistered_media
        errors = []
        def write(*args, **kwargs):
            result = original_write(*args, **kwargs)
            if args[1] == first["id"]:
                raise RuntimeError("first upload commit failed")
            return result
        def cleanup(relative):
            cleanup_entered.set()
            if not allow_cleanup.wait(5):
                raise AssertionError("second upload did not finish")
            original_cleanup(relative)
        def upload_first():
            try:
                self.workspace.import_media(first["id"], io.BytesIO(self.video_bytes), len(self.video_bytes), "first.mp4", 1)
            except RuntimeError as exc:
                errors.append(str(exc))
        with mock.patch.object(self.workspace, "_write_revision", side_effect=write), mock.patch.object(self.workspace, "_discard_unregistered_media", side_effect=cleanup):
            thread = threading.Thread(target=upload_first)
            thread.start()
            try:
                self.assertTrue(cleanup_entered.wait(5))
                saved = self.workspace.import_media(second["id"], io.BytesIO(self.video_bytes), len(self.video_bytes), "second.mp4", 1)
            finally:
                allow_cleanup.set()
                thread.join(5)
        self.assertTrue(errors)
        self.assertEqual(self.workspace.get_project(first["id"])["revision"], 1)
        self.assertEqual(saved["revision"], 2)
        self.assertEqual(self.workspace.media_file(second["id"])[0].read_bytes(), self.video_bytes)

    def test_demo_blob_registration_is_serialized_with_project_commit(self):
        demo = json.loads((ROOT / "data" / "demo.json").read_text(encoding="utf-8"))
        first_registered, allow_first, second_started, second_done = (threading.Event() for _ in range(4))
        original = self.workspace._register_demo
        count = 0
        result, errors = [], []
        def register(*args):
            nonlocal count
            count += 1
            registered = original(*args)
            if count == 1:
                first_registered.set()
                if not allow_first.wait(5):
                    raise AssertionError("test release timed out")
            return registered
        def create(name):
            if name == "第二个":
                second_started.set()
            try:
                result.append(self.workspace.create_project(name, demo))
            except Exception as exc:
                errors.append(exc)
            finally:
                if name == "第二个":
                    second_done.set()
        with mock.patch.object(self.workspace, "_register_demo", side_effect=register):
            first = threading.Thread(target=create, args=("第一个",))
            second = threading.Thread(target=create, args=("第二个",))
            first.start()
            try:
                self.assertTrue(first_registered.wait(5))
                second.start()
                self.assertTrue(second_started.wait(5))
                self.assertFalse(second_done.wait(0.1))
            finally:
                allow_first.set()
                first.join(5)
                if second.ident:
                    second.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(len(result), 2)
        self.assertEqual(self.workspace.media_file(result[0]["id"])[0], self.workspace.media_file(result[1]["id"])[0])

    def test_restore_rebinds_original_media_and_rejects_corrupted_history(self):
        project = self.registered_project()
        original_path = self.workspace.media_file(project["id"])[0]
        alternate = Path(self.temp.name) / "alternate.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(alternate)], capture_output=True, check=True, timeout=20)
        payload = alternate.read_bytes()
        changed = self.workspace.import_media(project["id"], io.BytesIO(payload), len(payload), "alternate.mp4", 2)
        self.assertNotEqual(changed["media"]["sha256"], project["media"]["sha256"])
        restored = self.workspace.restore_project(project["id"], 2, 3)
        self.assertEqual(restored["revision"], 4)
        self.assertEqual(restored["dataset"]["video"]["sha256"], project["media"]["sha256"])
        self.assertEqual(self.workspace.media_file(project["id"])[0], original_path)
        original_path.write_bytes(b"corrupt old file")
        self.assert_workspace_error(409, lambda: self.workspace.restore_project(project["id"], 2, 4), "historical_media_corrupt")
        self.assertEqual(self.workspace.get_project(project["id"])["revision"], 4)
        valid_alternate = self.workspace.restore_project(project["id"], 3, 4)
        self.assertEqual(valid_alternate["media"]["sha256"], sha256_file(alternate))

    def test_paths_symlinks_unknown_ids_and_unregistered_media_are_isolated(self):
        project = self.workspace.create_project("无视频", self.dataset)
        self.assert_workspace_error(404, lambda: self.workspace.media_file(project["id"]))
        self.assert_workspace_error(404, lambda: self.workspace.get_project("../workspace.sqlite3"))
        self.assert_workspace_error(404, lambda: self.workspace.controlled_path("../outside"))
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_text("do not expose", encoding="utf-8")
        link = self.root / "media" / "linked.mp4"
        link.symlink_to(outside)
        self.assert_workspace_error(404, lambda: self.workspace.controlled_path("media/linked.mp4"))
        self.assertEqual(outside.read_text(), "do not expose")

    def test_builtin_demo_is_registered_only_for_exact_known_url_and_fingerprint(self):
        demo = json.loads((ROOT / "data" / "demo.json").read_text(encoding="utf-8"))
        project = self.workspace.create_project("内置演练", demo)
        self.assertEqual(project["revision"], 1)
        self.assertEqual(project["media"]["sha256"], sha256_file(ROOT / "media" / "demo.mp4"))
        self.assertEqual(project["dataset"]["video"]["url"], f"/api/projects/{project['id']}/media")
        demo["video"]["sha256"] = "0" * 64
        self.assert_workspace_error(400, lambda: self.workspace.create_project("假演练", demo), "demo_fingerprint_mismatch")

    def test_http_neutral_routes_return_expected_shapes_and_controlled_files(self):
        jobs = JobManager(self.workspace, autostart=False)
        routes = WorkspaceRoutes(self.workspace, jobs)
        try:
            response = routes.dispatch_post("/api/projects", {"name": "路由项目", "dataset": self.dataset})
            self.assertIsInstance(response, Response)
            self.assertEqual(response.status, 201)
            pid = response.body["project"]["id"]
            response = routes.dispatch_media(f"/api/projects/{pid}/media", io.BytesIO(self.video_bytes), len(self.video_bytes), "input.mp4", 1)
            self.assertEqual(response.body["project"]["revision"], 2)
            file_response = routes.dispatch_get(f"/api/projects/{pid}/media")
            self.assertIsInstance(file_response, FileResponse)
            self.assertEqual(file_response.path.read_bytes(), self.video_bytes)
            self.assertEqual(routes.dispatch_get(f"/api/projects/{pid}/history").body["revisions"][0]["revision"], 2)
            self.assertIsNone(routes.dispatch_get("/api/not-handled"))
            self.assert_workspace_error(409, lambda: routes.dispatch_post(f"/api/projects/{pid}/save", {"name": "冲突", "dataset": self.dataset, "expected_revision": 1}))
        finally:
            routes.close()

    def test_capabilities_probe_selected_runtime_without_cloud_calls(self):
        cap = self.workspace.capabilities()
        self.assertTrue(cap["ffmpeg"])
        self.assertTrue(cap["ffprobe"])
        self.assertEqual(cap["mode"], "local")
        self.assertFalse(cap["cloud_configured"])
        self.assertEqual(cap["tts_available"], sys.platform == "darwin" and bool(shutil.which("say")))
        self.assertEqual(cap["max_media_bytes"], 536870912)
        unavailable = Workspace(Path(self.temp.name) / "missing-tools", app_root=ROOT, ffmpeg="/nonexistent/ffmpeg", ffprobe="/nonexistent/ffprobe")
        missing = unavailable.capabilities()
        self.assertFalse(missing["ffmpeg"])
        self.assertFalse(missing["ffprobe"])
        self.assertFalse(missing["render_available"])


if __name__ == "__main__":
    unittest.main()
