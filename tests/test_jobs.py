"""Durable job state, real child-process failure/cancel and real MP4 export."""

import copy
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
import sys
import threading
import time
import types
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_workspace import MediaTestCase
from core.jobs import JobManager, acquire_service_lock, release_service_lock
from core.workspace import Workspace, sha256_file


def wait_terminal(manager, job_id, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = manager.get_job(job_id)
        if job["status"] in ("complete", "failed", "cancelled"):
            return job
        time.sleep(0.03)
    raise AssertionError("job did not finish before deadline")


class JobTests(MediaTestCase):
    def setUp(self):
        super().setUp()
        self.managers = []

    def tearDown(self):
        for manager in self.managers:
            manager.close()
        super().tearDown()

    def manager(self, **kwargs):
        manager = JobManager(self.workspace, **kwargs)
        self.managers.append(manager)
        return manager

    def test_frozen_snapshot_and_media_survive_project_edits(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        job = manager.enqueue(project["id"], 2, "fan")
        directory = self.root / "jobs" / job["id"]
        frozen = json.loads((directory / "snapshot.json").read_text())
        modified = copy.deepcopy(project["dataset"])
        modified["possessions"][0]["title"] = "保存后修改，不得污染任务"
        self.workspace.save_project(project["id"], "新版本", modified, 2)
        self.assertEqual(job["revision"], 2)
        self.assertEqual(frozen["possessions"][0]["title"], project["dataset"]["possessions"][0]["title"])
        original, _ = self.workspace.media_file(project["id"])
        original.write_bytes(b"external corruption after snapshot")
        self.assertEqual(sha256_file(directory / "input.media"), job["media_sha256"])
        self.assert_workspace_error(409, lambda: manager.enqueue(project["id"], 2), "revision_conflict")

    def test_queue_limit_queued_cancel_and_idempotence(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        jobs = [manager.enqueue(project["id"], 2) for _ in range(4)]
        self.assert_workspace_error(429, lambda: manager.enqueue(project["id"], 2), "queue_full")
        cancelled = manager.cancel(jobs[1]["id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(manager.cancel(jobs[1]["id"])["status"], "cancelled")
        self.assertFalse((self.root / "jobs" / jobs[1]["id"]).exists())
        replacement = manager.enqueue(project["id"], 2)
        self.assertEqual(replacement["status"], "queued")
        self.assertEqual(manager.get_job(jobs[0]["id"])["status"], "queued")

    def test_real_process_failure_removes_partial_outputs_and_prevents_download(self):
        project = self.registered_project()
        def command(job, directory):
            return [sys.executable, "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(b'partial'); print('deliberate encoder failure'); sys.exit(7)", str(directory / "replay.mp4")]
        manager = self.manager(command_builder=command)
        job = wait_terminal(manager, manager.enqueue(project["id"], 2)["id"])
        self.assertEqual(job["status"], "failed")
        self.assertIn("deliberate encoder failure", job["error"])
        self.assertEqual(job["files"], [])
        self.assertFalse((self.root / "jobs" / job["id"]).exists())
        self.assert_workspace_error(409, lambda: manager.file(job["id"], "replay.mp4"))

    def test_failed_status_is_not_published_while_cleanup_is_blocked(self):
        project = self.registered_project()
        manager = self.manager(command_builder=lambda job, directory: [sys.executable, "-c", "raise SystemExit(7)"])
        cleanup_entered, release_cleanup = threading.Event(), threading.Event()
        original = manager._clean
        def blocked_cleanup(job_id):
            cleanup_entered.set()
            if not release_cleanup.wait(8):
                raise AssertionError("cleanup barrier was not released")
            original(job_id)
        with mock.patch.object(manager, "_clean", side_effect=blocked_cleanup):
            job = manager.enqueue(project["id"], 2)
            try:
                self.assertTrue(cleanup_entered.wait(8))
                self.assertTrue((self.root / "jobs" / job["id"]).exists())
                observed = manager.get_job(job["id"])
                self.assertEqual(observed["status"], "running")
                self.assertEqual(observed["files"], [])
                self.assert_workspace_error(409, lambda: manager.file(job["id"], "replay.mp4"))
            finally:
                release_cleanup.set()
            final = wait_terminal(manager, job["id"])
        self.assertEqual(final["status"], "failed")
        self.assertFalse((self.root / "jobs" / job["id"]).exists())

    def test_queued_cancel_is_not_published_while_cleanup_is_blocked(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        job = manager.enqueue(project["id"], 2)
        cleanup_entered, release_cleanup = threading.Event(), threading.Event()
        original, returned, errors = manager._clean, [], []
        def blocked_cleanup(job_id):
            cleanup_entered.set()
            if not release_cleanup.wait(8):
                raise AssertionError("cleanup barrier was not released")
            original(job_id)
        def cancel():
            try:
                returned.append(manager.cancel(job["id"]))
            except Exception as exc:
                errors.append(exc)
        with mock.patch.object(manager, "_clean", side_effect=blocked_cleanup):
            thread = threading.Thread(target=cancel)
            thread.start()
            try:
                self.assertTrue(cleanup_entered.wait(8))
                self.assertEqual(manager.get_job(job["id"])["status"], "queued")
                self.assertTrue((self.root / "jobs" / job["id"]).exists())
                self.assertEqual(returned, [])
            finally:
                release_cleanup.set()
                thread.join(8)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(returned[0]["status"], "cancelled")
        self.assertFalse((self.root / "jobs" / job["id"]).exists())

    def test_running_cancel_terminates_actual_process_and_serial_worker_continues(self):
        project = self.registered_project()
        def command(job, directory):
            return [sys.executable, "-c", "import os,pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)", str(directory / "pid.txt")]
        manager = self.manager(command_builder=command)
        first = manager.enqueue(project["id"], 2)
        second = manager.enqueue(project["id"], 2)
        pid_path = self.root / "jobs" / first["id"] / "pid.txt"
        deadline = time.monotonic() + 5
        while not pid_path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(pid_path.exists())
        pid = int(pid_path.read_text())
        self.assertEqual(manager.get_job(second["id"])["status"], "queued")
        manager.cancel(first["id"])
        final = wait_terminal(manager, first["id"])
        self.assertEqual(final["status"], "cancelled")
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertFalse((self.root / "jobs" / first["id"]).exists())
        manager.cancel(second["id"])
        self.assertEqual(wait_terminal(manager, second["id"])["status"], "cancelled")

    def test_restart_marks_interrupted_jobs_failed_and_keeps_terminal_history(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        first = manager.enqueue(project["id"], 2)
        second = manager.enqueue(project["id"], 2)
        cancelled = manager.enqueue(project["id"], 2)
        manager.cancel(cancelled["id"])
        with self.workspace.transaction() as db:
            db.execute("UPDATE jobs SET status='running' WHERE id=?", (first["id"],))
        manager.close()
        # Simulate abrupt termination, rather than the orderly close above,
        # for the queued row that must be recovered on the next process start.
        with self.workspace.transaction() as db:
            db.execute("UPDATE jobs SET status='queued' WHERE id=?", (second["id"],))
        restarted = self.manager(autostart=False)
        for job in (first, second):
            recovered = restarted.get_job(job["id"])
            self.assertEqual(recovered["status"], "failed")
            self.assertIn("重启", recovered["error"])
            self.assertFalse((self.root / "jobs" / job["id"]).exists())
        self.assertEqual(restarted.get_job(cancelled["id"])["status"], "cancelled")

    @unittest.skipUnless(os.name == "posix", "POSIX workspace service lock")
    def test_second_live_service_cannot_recover_first_services_active_queue(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        queued = manager.enqueue(project["id"], 2)
        live_partial = self.root / "incoming" / "upload.part"
        live_partial.write_bytes(b"upload in progress")
        second_workspace = Workspace(self.root)
        self.assertTrue(live_partial.exists())
        self.assert_workspace_error(409, lambda: JobManager(second_workspace, autostart=False), "workspace_in_use")
        self.assertTrue(live_partial.exists())
        self.assertEqual(manager.get_job(queued["id"])["status"], "queued")
        manager.close()
        restarted = self.manager(autostart=False)
        self.assertEqual(restarted.get_job(queued["id"])["status"], "failed")
        self.assertFalse(live_partial.exists())
        self.assertTrue(self.workspace.media_file(project["id"])[0].exists())

    def test_shutdown_timeout_keeps_lock_and_prevents_late_process_start(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "raise SystemExit(0)"])
        first = manager.enqueue(project["id"], 2)
        second = manager.enqueue(project["id"], 2)
        entered, release = threading.Event(), threading.Event()
        original_hash = sha256_file
        def slow_hash(path):
            if Path(path).name == "input.media":
                entered.set()
                if not release.wait(5):
                    raise AssertionError("blocked hash was not released")
            return original_hash(path)
        with mock.patch("core.jobs.sha256_file", side_effect=slow_hash), mock.patch("core.jobs.subprocess.Popen") as popen:
            manager.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assert_workspace_error(503, lambda: manager.close(timeout=0.02), "shutdown_timeout")
                self.assert_workspace_error(409, lambda: JobManager(self.workspace, autostart=False), "workspace_in_use")
                self.assert_workspace_error(503, lambda: manager.enqueue(project["id"], 2), "service_closed")
            finally:
                release.set()
                manager.close(timeout=5)
            popen.assert_not_called()
        for item in (first, second):
            self.assertEqual(manager.get_job(item["id"])["status"], "failed")
            self.assertFalse((self.root / "jobs" / item["id"]).exists())
        self.assert_workspace_error(503, manager.start, "service_closed")
        reopened = self.manager(autostart=False)
        self.assertEqual(reopened.get_job(first["id"])["status"], "failed")

    def test_cancel_during_final_validation_cannot_publish_completed_files(self):
        if not self.workspace.capabilities()["render_available"]:
            self.skipTest("Requires local Pillow runtime")
        project = self.registered_project()
        entered, release = threading.Event(), threading.Event()
        original_probe = self.workspace.probe_media
        def paused_probe(path):
            if Path(path).name == "replay.mp4":
                entered.set()
                if not release.wait(8):
                    raise AssertionError("validation test timed out")
            return original_probe(path)
        manager = self.manager()
        with mock.patch.object(self.workspace, "probe_media", side_effect=paused_probe):
            job = manager.enqueue(project["id"], 2)
            try:
                self.assertTrue(entered.wait(8))
                manager.cancel(job["id"])
                self.assert_workspace_error(409, lambda: manager.file(job["id"], "replay.mp4"))
            finally:
                release.set()
            final = wait_terminal(manager, job["id"])
        self.assertEqual(final["status"], "cancelled")
        self.assertEqual(final["files"], [])
        self.assertEqual(manager.cancel(job["id"])["status"], "cancelled")

    def test_windows_byte_lock_branch_uses_first_byte_without_claiming_windows_execution(self):
        # This is a simulated msvcrt API contract check, not a Windows OS test.
        module = types.SimpleNamespace(LK_NBLCK=2, LK_UNLCK=0, locking=mock.Mock())
        with (Path(self.temp.name) / "windows-lock-simulation").open("a+b") as stream:
            with mock.patch.dict(sys.modules, {"msvcrt": module}):
                acquire_service_lock(stream, platform="nt")
                self.assertEqual(stream.tell(), 0)
                release_service_lock(stream, platform="nt")
                self.assertEqual(stream.tell(), 0)
            self.assertEqual(module.locking.call_args_list, [mock.call(stream.fileno(), 2, 1), mock.call(stream.fileno(), 0, 1)])
            stream.seek(0)
            self.assertEqual(stream.read(), b"\0")

    def test_frame_progress_updates_from_real_process_without_premature_completion(self):
        project = self.registered_project()
        def command(job, directory):
            return [sys.executable, "-c", "import json,time; print(json.dumps({'event':'progress','completed':1,'total':4,'progress':0.99}),flush=True); time.sleep(60)"]
        manager = self.manager(command_builder=command)
        job = manager.enqueue(project["id"], 2)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            current = manager.get_job(job["id"])
            if current["progress"] > 0:
                break
            time.sleep(0.03)
        self.assertEqual(current["status"], "running")
        self.assertEqual(current["progress"], 0.25)  # computed from counts, not the claimed 0.99
        self.assertIn("25%", current["progress_label"])
        self.assertEqual(current["files"], [])
        manager.cancel(job["id"])
        self.assertEqual(wait_terminal(manager, job["id"])["status"], "cancelled")

    def test_error_messages_do_not_disclose_absolute_paths(self):
        project = self.registered_project()
        manager = self.manager(command_builder=lambda job, directory: [sys.executable, "-c", "import sys; print('/Users/example/private/project.py /tmp/private.log'); sys.exit(1)"])
        job = wait_terminal(manager, manager.enqueue(project["id"], 2)["id"])
        self.assertEqual(job["status"], "failed")
        self.assertNotIn("/Users/", job["error"])
        self.assertNotIn("/tmp/", job["error"])
        self.assertIn("[local-path]", job["error"])
        self.assertNotIn("C:\\", manager._safe_error(r"error at C:\Users\name\private.py"))
        self.assertNotIn("\\\\server", manager._safe_error(r"error at \\server\share\private.log"))

    def test_draft_and_missing_sha_rejected_but_reviewed_missing_metrics_allowed(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        draft = copy.deepcopy(project["dataset"])
        draft["workflow"] = {"state": "draft"}
        saved = self.workspace.save_project(project["id"], "草稿", draft, 2)
        self.assert_workspace_error(400, lambda: manager.enqueue(project["id"], saved["revision"]), "draft_not_reviewed")
        unbound = self.workspace.create_project("无指纹", self.dataset)
        self.assert_workspace_error(400, lambda: manager.enqueue(unbound["id"], 1), "quality_blocked")
        draft["workflow"]["state"] = "reviewed"
        reviewed = self.workspace.save_project(project["id"], "复核", draft, 3)
        job = manager.enqueue(project["id"], reviewed["revision"])
        self.assertEqual(job["status"], "queued")
        self.assertTrue(any("缺失" in warning for warning in job["quality_warnings"]))

    def test_legacy_persisted_row_cannot_bypass_review_gate(self):
        project = self.registered_project()
        legacy = copy.deepcopy(project["dataset"])
        del legacy["workflow"]
        with self.workspace.transaction() as db:
            db.execute("UPDATE projects SET dataset_json=? WHERE id=?", (json.dumps(legacy), project["id"]))
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        self.assert_workspace_error(400, lambda: manager.enqueue(project["id"], 2), "draft_not_reviewed")

    def test_voice_unavailable_and_invalid_voice_do_not_silently_export_silent_video(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        with mock.patch.object(self.workspace, "capabilities", return_value={"render_available": True, "tts_available": False}):
            self.assert_workspace_error(503, lambda: manager.enqueue(project["id"], 2, voice=True), "tts_unavailable")
            default = manager.enqueue(project["id"], 2)
            self.assertFalse(default["voice"])
        for value in ("true", 1, None):
            self.assert_workspace_error(400, lambda value=value: manager.enqueue(project["id"], 2, voice=value), "invalid_voice")

    def test_voice_failure_removes_silent_intermediate_instead_of_fallback(self):
        if not self.workspace.capabilities()["render_available"]:
            self.skipTest("Requires local Pillow runtime")
        project = self.registered_project()
        manager = self.manager()
        with mock.patch.object(self.workspace, "capabilities", return_value={"render_available": True, "tts_available": True}), mock.patch.object(manager, "_voice_command", return_value=[sys.executable, "-c", "import sys; print('deliberate TTS error'); sys.exit(3)"]):
            job = wait_terminal(manager, manager.enqueue(project["id"], 2, voice=True)["id"])
        self.assertEqual(job["status"], "failed")
        self.assertTrue(job["voice"])
        self.assertIn("deliberate TTS error", job["error"])
        self.assertEqual(job["files"], [])
        self.assertFalse((self.root / "jobs" / job["id"]).exists())

    def test_voice_progress_and_cancel_are_real_stage_specific_and_atomic(self):
        if not self.workspace.capabilities()["render_available"]:
            self.skipTest("Requires local Pillow runtime")
        project = self.registered_project()
        manager = self.manager()
        voice_command = [sys.executable, "-c", "import json,time; print(json.dumps({'event':'voice_progress','completed':1,'total':4}),flush=True); time.sleep(60)"]
        with mock.patch.object(self.workspace, "capabilities", return_value={"render_available": True, "tts_available": True}), mock.patch.object(manager, "_voice_command", return_value=voice_command):
            job = manager.enqueue(project["id"], 2, voice=True)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                current = manager.get_job(job["id"])
                if "1/4" in current["progress_label"]:
                    break
                time.sleep(0.03)
            self.assertIn("正在本地中文配音", current["progress_label"])
            self.assertIn("1/4", current["progress_label"])
            self.assertAlmostEqual(current["progress"], 0.845)
            self.assertEqual(current["files"], [])
            cleanup_entered, release_cleanup = threading.Event(), threading.Event()
            original_cleanup = manager._clean
            def blocked_cleanup(job_id):
                cleanup_entered.set()
                if not release_cleanup.wait(8):
                    raise AssertionError("voice cleanup barrier was not released")
                original_cleanup(job_id)
            with mock.patch.object(manager, "_clean", side_effect=blocked_cleanup):
                try:
                    accepted = manager.cancel(job["id"])
                    self.assertTrue(cleanup_entered.wait(8))
                    self.assertEqual(accepted["status"], "running")
                    self.assertIn("取消处理中", accepted["progress_label"])
                    self.assertEqual(manager.get_job(job["id"])["status"], "running")
                    self.assertTrue((self.root / "jobs" / job["id"]).exists())
                    self.assert_workspace_error(409, lambda: manager.file(job["id"], "replay.mp4"))
                finally:
                    release_cleanup.set()
                final = wait_terminal(manager, job["id"])
        self.assertEqual(final["status"], "cancelled")
        self.assertEqual(final["files"], [])
        self.assertFalse((self.root / "jobs" / job["id"]).exists())

    def test_voice_success_without_audio_is_rejected(self):
        if not self.workspace.capabilities()["render_available"]:
            self.skipTest("Requires local Pillow runtime")
        project = self.registered_project()
        manager = self.manager()
        def voice_command(job, directory):
            return [sys.executable, "-c", "import shutil,sys; shutil.copyfile(sys.argv[1],sys.argv[2])", str(directory / "replay.mp4"), str(directory / "voice.mp4")]
        with mock.patch.object(self.workspace, "capabilities", return_value={"render_available": True, "tts_available": True}), mock.patch.object(manager, "_voice_command", side_effect=voice_command):
            job = wait_terminal(manager, manager.enqueue(project["id"], 2, voice=True)["id"])
        self.assertEqual(job["status"], "failed")
        self.assertIn("没有音轨", job["error"])
        self.assertEqual(job["files"], [])

    def test_existing_job_database_migrates_voice_to_false(self):
        project = self.registered_project()
        old_id = "a" * 32
        columns = "id TEXT PRIMARY KEY,project_id TEXT,revision INTEGER,audience TEXT,status TEXT,progress REAL,error TEXT,created_at TEXT,updated_at TEXT,files_json TEXT,snapshot_json TEXT,media_sha256 TEXT,cancel_requested INTEGER,quality_json TEXT"
        with self.workspace.transaction() as db:
            db.execute("CREATE TABLE jobs (" + columns + ")")
            db.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (old_id, project["id"], 2, "fan", "failed", 0, "old failure", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "[]", json.dumps(project["dataset"]), project["media"]["sha256"], 0, "[]"))
        manager = self.manager(autostart=False)
        migrated = manager.get_job(old_id)
        self.assertFalse(migrated["voice"])
        self.assertEqual(migrated["error"], "old failure")

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("say"), "Real offline TTS requires macOS say")
    def test_real_offline_voice_export_has_audio_and_matching_evidence_log(self):
        if not self.workspace.capabilities()["render_available"]:
            self.skipTest("Requires local Pillow runtime")
        video = Path(self.temp.name) / "voice-source.mp4"
        subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=64x48:r=10:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(video)], check=True, capture_output=True, timeout=20)
        self.dataset["video"]["duration"] = 6
        self.dataset["possessions"][0].update(end=6, shot_time=4, result="unknown", result_time=None)
        self.dataset["possessions"][0]["camera_segments"] = [{"start": 0, "end": 6, "calibrated": False}]
        project = self.workspace.create_project("真实本地配音", self.dataset)
        payload = video.read_bytes()
        project = self.workspace.import_media(project["id"], io.BytesIO(payload), len(payload), "voice-source.mp4", 1)
        manager = self.manager()
        job = wait_terminal(manager, manager.enqueue(project["id"], 2, voice=True)["id"], timeout=45)
        self.assertEqual(job["status"], "complete", job["error"])
        self.assertTrue(job["voice"])
        output = manager.file(job["id"], "replay.mp4")[0]
        self.assertTrue(self.workspace.probe_media(output)["has_audio"])
        voice_report = json.loads(manager.file(job["id"], "replay.voice.json")[0].read_text())
        self.assertEqual(voice_report["provider"], "macOS offline say")
        self.assertEqual(len(voice_report["cues"]), 3)
        self.assertTrue(all(cue["evidence_ids"] for cue in voice_report["cues"]))
        self.assertEqual(len(job["files"]), 4)

    def test_tampered_source_rejected_before_queue_and_no_partial_job(self):
        project = self.registered_project()
        manager = self.manager(autostart=False, command_builder=lambda job, directory: [sys.executable, "-c", "pass"])
        self.workspace.media_file(project["id"])[0].write_bytes(b"changed")
        self.assert_workspace_error(409, lambda: manager.enqueue(project["id"], 2), "media_fingerprint_mismatch")
        self.assertEqual(manager.list_jobs(project["id"]), [])
        self.assertEqual(list((self.root / "jobs").iterdir()), [])

    def test_real_export_completes_and_whitelist_prevents_snapshot_download(self):
        if not self.workspace.capabilities()["render_available"]:
            self.skipTest("Set COURTLENS_RENDER_PYTHON to a local Python with Pillow for real export test")
        project = self.registered_project()
        manager = self.manager()
        job = wait_terminal(manager, manager.enqueue(project["id"], 2, "analyst")["id"], timeout=30)
        self.assertEqual(job["status"], "complete", job["error"])
        self.assertEqual(job["progress"], 1)
        self.assertEqual({f["name"] for f in job["files"]}, {"replay.mp4", "replay.vtt", "replay.analysis.json"})
        video, mime = manager.file(job["id"], "replay.mp4")
        self.assertEqual(mime, "video/mp4")
        self.assertAlmostEqual(self.workspace.probe_media(video)["duration"], 1, places=1)
        for name in ("snapshot.json", "input.media", "render.log", "../workspace.sqlite3", "%2e%2e%2fworkspace.sqlite3"):
            self.assert_workspace_error(404, lambda name=name: manager.file(job["id"], name))
        self.assertEqual(manager.cancel(job["id"])["status"], "complete")
        analysis = json.loads(manager.file(job["id"], "replay.analysis.json")[0].read_text())
        self.assertEqual(analysis["media_binding"]["sha256"], project["media"]["sha256"])
        self.assertFalse((self.root / "jobs" / job["id"] / "input.media").exists())


if __name__ == "__main__":
    unittest.main()
