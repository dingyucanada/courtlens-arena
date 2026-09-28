"""One local export worker with frozen inputs, durable states and cancellation."""

import contextlib
import json
import math
import os
from pathlib import Path
import shutil
import re
import signal
import subprocess
import threading
import uuid

from .engine import analyze, validate_audience
from .quality import quality_report
from .workspace import WorkspaceError, encode, sha256_file, utc_now, valid_id

OUTPUTS = {
    "replay.mp4": "video/mp4",
    "replay.vtt": "text/vtt; charset=utf-8",
    "replay.analysis.json": "application/json; charset=utf-8",
}
DOWNLOADS = {**OUTPUTS, "replay.voice.json": "application/json; charset=utf-8"}
TERMINAL = ("complete", "failed", "cancelled")


def acquire_service_lock(stream, platform=None):
    platform = platform or os.name
    if platform == "posix":
        import fcntl
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    elif platform == "nt":
        import msvcrt
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        raise WorkspaceError(503, "当前系统不支持工作区服务锁，不能安全启动导出。", "platform_unsupported")


def release_service_lock(stream, platform=None):
    platform = platform or os.name
    if platform == "posix":
        import fcntl
        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    elif platform == "nt":
        import msvcrt
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


class JobManager:
    def __init__(self, workspace, max_queued=4, autostart=True, command_builder=None):
        self.workspace = workspace
        self.max_queued = max_queued
        # Injected commands are for trusted embedding/tests only, never HTTP.
        self.command_builder = command_builder
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._process_lock = threading.Lock()
        self._shutdown_lock = threading.Lock()
        self._process = None
        self._active_id = None
        self._thread = None
        self._lock_file = workspace.controlled_path(".exports.lock", must_exist=False).open("a+b")
        # OS advisory locks disappear after a crash, so they distinguish a
        # real restart from a second live server opening the same workspace.
        try:
            acquire_service_lock(self._lock_file)
        except OSError as exc:
            self._lock_file.close()
            self._lock_file = None
            raise WorkspaceError(409, "此工作区已有导出服务运行；请关闭原服务或使用其他工作区。", "workspace_in_use") from exc
        workspace.recover_uploads()
        with contextlib.closing(workspace.connect()) as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    revision INTEGER NOT NULL, audience TEXT NOT NULL,
                    status TEXT NOT NULL, progress REAL NOT NULL,
                    error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    files_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
                    media_sha256 TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
                    quality_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id,created_at);
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(jobs)")}
            if "voice" not in columns:
                db.execute("ALTER TABLE jobs ADD COLUMN voice INTEGER NOT NULL DEFAULT 0")
            if "phase" not in columns:
                db.execute("ALTER TABLE jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'")
        with workspace.transaction() as db:
            interrupted = list(db.execute("SELECT id FROM jobs WHERE status IN ('queued','running')"))
            for row in interrupted:
                self._clean(row["id"])
            db.execute("UPDATE jobs SET status='failed',progress=0,error=?,updated_at=?,files_json='[]' WHERE status IN ('queued','running')", ("服务重启中断了任务；冻结任务未自动重跑，请重新导出。", utc_now()))
        if autostart:
            self.start()

    def start(self):
        if self._stop.is_set() or self._lock_file is None:
            raise WorkspaceError(503, "导出服务已关闭，不能在旧实例上重新启动。", "service_closed")
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._worker, name="courtlens-export", daemon=True)
        self._thread.start()
        self._wake.set()

    def close(self, timeout=8):
        self._stop.set()
        self._wake.set()
        with self._process_lock:
            process = self._process
        if process:
            self._terminate(process)
        if self._thread:
            self._thread.join(timeout)
        if self._thread and self._thread.is_alive():
            raise WorkspaceError(503, "导出服务仍在收尾，关闭等待超时；服务锁保持占用，未宣称关闭完成。", "shutdown_timeout")
        self._finish_shutdown()

    def _finish_shutdown(self):
        with self._shutdown_lock:
            if self._lock_file is None:
                return
            with self.workspace.transaction() as db:
                queued = [row[0] for row in db.execute("SELECT id FROM jobs WHERE status='queued'")]
                for job_id in queued:
                    self._clean(job_id)
                db.execute("UPDATE jobs SET status='failed',progress=0,error=?,files_json='[]',updated_at=? WHERE status='queued'", ("服务关闭中断了等待任务，请重新导出。", utc_now()))
            release_service_lock(self._lock_file)
            self._lock_file.close()
            self._lock_file = None

    def _row(self, db, job_id):
        valid_id(job_id)
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise WorkspaceError(404, "导出任务不存在。", "job_not_found")
        return row

    def _public(self, row):
        result = {key: row[key] for key in ("id", "project_id", "revision", "audience", "status", "progress", "error", "created_at", "updated_at", "media_sha256")}
        result["files"] = json.loads(row["files_json"])
        result["voice"] = bool(row["voice"])
        result["quality_warnings"] = json.loads(row["quality_json"])
        result["progress_label"] = {"queued": "等待本地导出", "running": "正在本地渲染；当前工具未报告逐帧进度", "complete": "完成", "failed": "失败", "cancelled": "已取消"}[row["status"]]
        if row["status"] == "running":
            if row["phase"].startswith("narrating"):
                result["progress_label"] = "正在本地中文配音；配音工具未报告逐句进度"
                detail = row["phase"].split(":")
                if len(detail) == 3:
                    result["progress_label"] = f"正在本地中文配音；已合成 {detail[1]}/{detail[2]} 条字幕"
            elif row["phase"] == "validating":
                result["progress_label"] = "正在核验成片、字幕与视频指纹"
            elif row["progress"] > 0:
                frames = row["progress"] / (0.8 if row["voice"] else 1)
                result["progress_label"] = f"已处理约 {frames * 100:.0f}% 视频帧；完成后还将核验文件"
            if row["cancel_requested"]:
                result["progress_label"] = "取消处理中；正在终止进程或清理临时文件"
        return result

    def get_job(self, job_id):
        with contextlib.closing(self.workspace.connect()) as db:
            return self._public(self._row(db, job_id))

    def list_jobs(self, project_id):
        with contextlib.closing(self.workspace.connect()) as db:
            self.workspace._row(db, project_id)
            return [self._public(row) for row in db.execute("SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC,id", (project_id,))]

    def enqueue(self, project_id, expected_revision, audience="fan", voice=False):
        if self._stop.is_set() or self._lock_file is None:
            raise WorkspaceError(503, "导出服务正在关闭，不再接受新任务。", "service_closed")
        validate_audience(audience)
        if not isinstance(voice, bool):
            raise WorkspaceError(400, "voice 必须为布尔值 true 或 false。", "invalid_voice")
        capabilities = self.workspace.capabilities() if voice or not self.command_builder else {}
        if not self.command_builder and not capabilities["render_available"]:
            raise WorkspaceError(503, "本地导出依赖尚不可用；需要 FFmpeg、FFprobe 和所选 Python 的 Pillow。", "render_unavailable")
        if voice and not capabilities.get("tts_available", False):
            raise WorkspaceError(503, "本地中文配音需要 macOS 的 say；当前环境不可用，未降级为无声导出。", "tts_unavailable")
        job_id = uuid.uuid4().hex
        directory = self.workspace.root / "jobs" / job_id
        try:
            with self.workspace.transaction() as db:
                if self._stop.is_set():
                    raise WorkspaceError(503, "导出服务正在关闭，不再接受新任务。", "service_closed")
                project = self.workspace._row(db, project_id)
                self.workspace._check_revision(project, expected_revision)
                if db.execute("SELECT COUNT(*) FROM jobs WHERE status='queued'").fetchone()[0] >= self.max_queued:
                    raise WorkspaceError(429, "导出等待队列已满（最多 4 个）；请等候或取消已有任务。", "queue_full")
                dataset = json.loads(project["dataset_json"])
                if not isinstance(dataset.get("workflow"), dict) or dataset["workflow"].get("state") != "reviewed":
                    raise WorkspaceError(400, "项目必须明确标记 workflow.state=reviewed 才能导出；旧数据也需先保存复核声明。", "draft_not_reviewed")
                report = quality_report(dataset)
                if not report["export_allowed"]:
                    code = "draft_not_reviewed" if isinstance(dataset.get("workflow"), dict) and dataset["workflow"].get("state") == "draft" else "quality_blocked"
                    raise WorkspaceError(400, "导出前检查未通过：" + "；".join(report["blocking_issues"]), code)
                if not project["media_json"]:
                    raise WorkspaceError(400, "项目还没有持久导入的视频；请先导入本地视频。", "media_not_bound")
                media = json.loads(project["media_json"])
                original = self.workspace.controlled_path(media["_storage"])
                analysis = analyze(dataset, audience)
                warnings = list(dict.fromkeys(report["warnings"] + analysis["warnings"]))
                for p in analysis["possessions"]:
                    warnings.extend(f"{p['id']}: {text}" for text in p["warnings"])
                directory.mkdir()
                snapshot = directory / "snapshot.json"
                with snapshot.open("x", encoding="utf-8") as stream:
                    stream.write(encode(dataset))
                    stream.flush()
                    os.fsync(stream.fileno())
                # A real copy, not a hard link: later filesystem edits to the
                # registered file cannot silently change an already queued job.
                frozen = directory / "input.media"
                with original.open("rb") as src, frozen.open("xb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                    dst.flush()
                    os.fsync(dst.fileno())
                if sha256_file(frozen) != media["sha256"] or dataset["video"].get("sha256") != media["sha256"]:
                    raise WorkspaceError(409, "项目视频指纹已变化，拒绝冻结错误媒体。请重新导入并复核。", "media_fingerprint_mismatch")
                if self._stop.is_set():
                    raise WorkspaceError(503, "导出服务关闭，未提交等待任务。", "service_closed")
                now = utc_now()
                db.execute("INSERT INTO jobs (id,project_id,revision,audience,status,progress,error,created_at,updated_at,files_json,snapshot_json,media_sha256,cancel_requested,quality_json,voice,phase) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (job_id, project_id, project["revision"], audience, "queued", 0, None, now, now, "[]", encode(dataset), media["sha256"], 0, encode(warnings), int(voice), "queued"))
                result = self._public(self._row(db, job_id))
            self._wake.set()
            return result
        except BaseException:
            if directory.exists():
                self._clean(job_id)
            raise

    def cancel(self, job_id):
        with self.workspace.transaction() as db:
            row = self._row(db, job_id)
            if row["status"] in TERMINAL:
                return self._public(row)
            if row["status"] == "queued":
                # Readers may still observe queued while cleanup is running;
                # no reader may observe cancelled before the directory is gone.
                # The writer transaction also prevents the worker claiming it.
                self._clean(job_id)
                db.execute("UPDATE jobs SET status='cancelled',cancel_requested=1,error=NULL,updated_at=?,files_json='[]' WHERE id=?", (utc_now(), job_id))
                immediate = True
            else:
                db.execute("UPDATE jobs SET cancel_requested=1,updated_at=? WHERE id=?", (utc_now(), job_id))
                immediate = False
        if not immediate:
            with self._process_lock:
                process = self._process if self._active_id == job_id else None
            if process:
                self._terminate(process)
        self._wake.set()
        return self.get_job(job_id)

    def file(self, job_id, name):
        if name not in DOWNLOADS:
            raise WorkspaceError(404, "下载文件不在白名单中。", "file_not_found")
        with contextlib.closing(self.workspace.connect()) as db:
            row = self._row(db, job_id)
            if row["status"] != "complete":
                raise WorkspaceError(409, "任务尚未完成，不能下载中间文件。", "job_not_complete")
            files = json.loads(row["files_json"])
            if not any(item["name"] == name for item in files):
                raise WorkspaceError(404, "结果文件未注册。", "file_not_found")
        return self.workspace.controlled_path(f"jobs/{job_id}/{name}"), DOWNLOADS[name]

    def _clean(self, job_id):
        valid_id(job_id)
        directory = self.workspace.root / "jobs" / job_id
        if directory.is_symlink():
            directory.unlink()
        elif directory.exists():
            shutil.rmtree(directory)

    def _terminate(self, process):
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGTERM)
            elif os.name == "nt":
                # Windows terminate() alone leaves FFmpeg children running.
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
            else:
                process.terminate()
        except (ProcessLookupError, OSError, subprocess.SubprocessError):
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except (ProcessLookupError, OSError):
                pass
            process.wait(timeout=2)
        finally:
            # A renderer may exit on SIGTERM before its child encoder, which
            # can even ignore SIGTERM. Kill the entire isolated group, too.
            if os.name == "posix":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass

    def _claim(self):
        with self.workspace.transaction() as db:
            # The DB check preserves one-at-a-time execution even if a second
            # worker thread is inadvertently started in the same service.
            if db.execute("SELECT 1 FROM jobs WHERE status='running' LIMIT 1").fetchone():
                return None
            row = db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").fetchone()
            if row:
                db.execute("UPDATE jobs SET status='running',phase='rendering',progress=0,updated_at=? WHERE id=? AND status='queued'", (utc_now(), row["id"]))
                return dict(row)
        return None

    def _worker(self):
        try:
            while not self._stop.is_set():
                job = self._claim()
                if job is None:
                    self._wake.wait(0.5)
                    self._wake.clear()
                    continue
                self._run(job)
        finally:
            if self._stop.is_set():
                self._finish_shutdown()

    def _cancel_requested(self, job_id):
        with contextlib.closing(self.workspace.connect()) as db:
            return bool(self._row(db, job_id)["cancel_requested"])

    def _read_progress(self, job_id, log_reader, pending, scale=1, event_name="progress", offset=0):
        pending += log_reader.read(65536)
        lines = pending.split(b"\n")
        pending = lines.pop()[-4096:]
        progress, phase = None, None
        for line in lines:
            try:
                event = json.loads(line)
                if not isinstance(event, dict) or event.get("event") != event_name:
                    continue
                completed, total = event["completed"], event["total"]
                if isinstance(completed, bool) or isinstance(total, bool) or not isinstance(completed, (int, float)) or not isinstance(total, (int, float)):
                    continue
                if not math.isfinite(completed) or not math.isfinite(total) or total <= 0 or not 0 <= completed <= total:
                    continue
                progress = max(progress or 0, min(0.99, offset + scale * completed / total))
                if event_name == "voice_progress":
                    phase = f"narrating:{completed:g}:{total:g}"
            except (ValueError, TypeError, KeyError, OverflowError):
                continue
        if progress is not None:
            with self.workspace.transaction() as db:
                db.execute("UPDATE jobs SET progress=MAX(progress,?),updated_at=? WHERE id=? AND status='running' AND cancel_requested=0", (progress, utc_now(), job_id))
                if phase:
                    db.execute("UPDATE jobs SET phase=? WHERE id=? AND status='running' AND cancel_requested=0", (phase, job_id))
        return pending

    def _safe_error(self, value):
        value = str(value).replace(str(self.workspace.root), "[workspace]").replace(str(self.workspace.app_root), "[app]")
        value = re.sub(r"\b[A-Za-z]:[\\/][^\s\"'<>]+|\\\\[^\s\"'<>]+", "[local-path]", value)
        return re.sub(r"(?<![A-Za-z0-9])/(?:[^\s\"'<>:]+/)*[^\s\"'<>:,;)]+", "[local-path]", value)[:2000]

    def _execute_command(self, job, directory, command, environment, log_name, label, progress_scale=None, voice_progress=False):
        job_id, process = job["id"], None
        log_path = directory / log_name
        try:
            with log_path.open("wb") as log:
                with self._process_lock:
                    if self._stop.is_set() or self._cancel_requested(job_id):
                        raise RuntimeError("任务在进程启动前已停止。")
                    process = subprocess.Popen(command, cwd=str(self.workspace.app_root), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=(os.name == "posix"), creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0, env=environment)
                    self._process, self._active_id = process, job_id
                with log_path.open("rb") as log_reader:
                    pending = b""
                    while process.poll() is None:
                        if progress_scale is not None:
                            pending = self._read_progress(job_id, log_reader, pending, progress_scale, "voice_progress" if voice_progress else "progress", 0.8 if voice_progress else 0)
                        if self._stop.is_set() or self._cancel_requested(job_id):
                            self._terminate(process)
                            break
                        self._wake.wait(0.2)
                        self._wake.clear()
                    if progress_scale is not None:
                        self._read_progress(job_id, log_reader, pending, progress_scale, "voice_progress" if voice_progress else "progress", 0.8 if voice_progress else 0)
            if self._cancel_requested(job_id):
                raise RuntimeError("任务已取消。")
            if self._stop.is_set():
                raise RuntimeError("服务关闭中断了任务，请重新导出。")
            if process.returncode:
                with log_path.open("rb") as log:
                    log.seek(max(0, log_path.stat().st_size - 1500))
                    detail = log.read().decode("utf-8", errors="replace").strip()
                raise RuntimeError(label + "失败：" + (detail or f"进程退出 {process.returncode}"))
        finally:
            if process:
                self._terminate(process)
            with self._process_lock:
                if self._process is process:
                    self._process, self._active_id = None, None

    def _voice_command(self, job, directory):
        return [self.workspace.render_python, str(self.workspace.app_root / "tools" / "narrate_video.py"), "--video", str(directory / "replay.mp4"), "--analysis", str(directory / "replay.analysis.json"), "--output", str(directory / "voice.mp4")]

    def _phase(self, job_id, phase, progress=None):
        with self.workspace.transaction() as db:
            if progress is None:
                db.execute("UPDATE jobs SET phase=?,updated_at=? WHERE id=? AND status='running' AND cancel_requested=0", (phase, utc_now(), job_id))
            else:
                db.execute("UPDATE jobs SET phase=?,progress=?,updated_at=? WHERE id=? AND status='running' AND cancel_requested=0", (phase, progress, utc_now(), job_id))

    def _validate_video(self, path, expected, require_audio=False):
        produced = self.workspace.probe_media(path)
        if (produced["width"], produced["height"]) != (expected["width"], expected["height"]) or abs(produced["duration"] - expected["duration"]) > 0.15:
            raise RuntimeError("导出视频尺寸或时长与冻结输入不匹配。")
        if require_audio and not produced.get("has_audio"):
            raise RuntimeError("配音成片没有音轨；任务失败，未降级为无声视频。")

    def _run(self, job):
        job_id = job["id"]
        directory = self.workspace.root / "jobs" / job_id
        status, error, files = "failed", None, []
        try:
            if self._stop.is_set():
                raise RuntimeError("服务正在关闭，任务已中断。")
            if self._cancel_requested(job_id):
                status = "cancelled"
                return
            frozen = self.workspace.controlled_path(f"jobs/{job_id}/input.media")
            snapshot = self.workspace.controlled_path(f"jobs/{job_id}/snapshot.json")
            if snapshot.read_text(encoding="utf-8") != job["snapshot_json"]:
                raise RuntimeError("冻结数据快照与任务记录不一致；没有启动渲染。")
            if sha256_file(frozen) != job["media_sha256"]:
                raise RuntimeError("冻结媒体指纹校验失败；没有启动渲染。")
            command = self.command_builder(job, directory) if self.command_builder else [self.workspace.render_python, str(self.workspace.app_root / "tools" / "export_video.py"), "--data", str(snapshot), "--video", str(frozen), "--output", str(directory / "replay.mp4"), "--audience", job["audience"]]
            environment = os.environ.copy()
            paths = [str(Path(path).parent) for path in (self.workspace.ffmpeg, self.workspace.ffprobe) if path]
            environment["PATH"] = os.pathsep.join(paths + [environment.get("PATH", "")])
            self._execute_command(job, directory, command, environment, "render.log", "本地渲染", 0.8 if job["voice"] else 1)
            expected = json.loads(job["snapshot_json"])["video"]
            output_names = dict(OUTPUTS)
            if job["voice"]:
                self._phase(job_id, "narrating", 0.8)
                self._execute_command(job, directory, self._voice_command(job, directory), environment, "voice.log", "本地中文配音", 0.18, voice_progress=True)
                voiced = self.workspace.controlled_path(f"jobs/{job_id}/voice.mp4")
                self._validate_video(voiced, expected, require_audio=True)
                voice_report = self.workspace.controlled_path(f"jobs/{job_id}/voice.voice.json")
                report = json.loads(voice_report.read_text(encoding="utf-8"))
                analysis = json.loads((directory / "replay.analysis.json").read_text(encoding="utf-8"))
                cues = sorted([cue for p in analysis["possessions"] for cue in p["cues"]], key=lambda cue: cue["start"])
                voice_cues = report.get("cues") if isinstance(report, dict) else None
                if not isinstance(voice_cues, list) or len(voice_cues) != len(cues) or any(any(spoken.get(key) != cue[key] for key in ("start", "end", "text", "evidence_ids")) for spoken, cue in zip(voice_cues, cues)):
                    raise RuntimeError("配音日志与冻结字幕证据不一致。")
                # No files become downloadable until the final DB transition;
                # both narration failure and cancellation remove the silent
                # intermediate rather than presenting it as requested output.
                os.replace(voiced, directory / "replay.mp4")
                os.replace(voice_report, directory / "replay.voice.json")
                output_names["replay.voice.json"] = DOWNLOADS["replay.voice.json"]
            self._phase(job_id, "validating")
            for name, content_type in output_names.items():
                path = self.workspace.controlled_path(f"jobs/{job_id}/{name}")
                if path.stat().st_size == 0:
                    raise RuntimeError("导出产生空文件：" + name)
                files.append({"name": name, "url": f"/api/jobs/{job_id}/files/{name}", "bytes": path.stat().st_size, "size": path.stat().st_size, "sha256": sha256_file(path), "content_type": content_type})
            # Validate the actual media and structured sidecars, not only a
            # renderer exit code or filename.
            self._validate_video(directory / "replay.mp4", expected, require_audio=bool(job["voice"]))
            sidecar = json.loads((directory / "replay.analysis.json").read_text(encoding="utf-8"))
            if sidecar.get("media_binding", {}).get("sha256") != job["media_sha256"]:
                raise RuntimeError("导出分析文件没有匹配冻结视频指纹。")
            if not (directory / "replay.vtt").read_text(encoding="utf-8").startswith("WEBVTT"):
                raise RuntimeError("导出字幕不是有效 WebVTT 文件。")
            status = "complete"
        except Exception as exc:
            status = "cancelled" if self._cancel_requested(job_id) else "failed"
            error = None if status == "cancelled" else self._safe_error(exc)
        finally:
            with self._process_lock:
                self._process, self._active_id = None, None
            with self.workspace.transaction() as db:
                # A cancel racing the final validation wins until completion
                # is committed; cancelling an already complete job is a no-op.
                latest = self._row(db, job_id)
                if latest["cancel_requested"]:
                    status, error, files = "cancelled", None, []
                if status != "complete":
                    # Publish a terminal failure/cancellation only after all
                    # private intermediates are gone. WAL readers retain the
                    # previous nonterminal state during this transaction. A
                    # cleanup error rolls back rather than falsely declaring
                    # completion, and the row remains recoverable on restart.
                    self._clean(job_id)
                db.execute("UPDATE jobs SET status=?,progress=?,error=?,files_json=?,updated_at=? WHERE id=?", (status, 1 if status == "complete" else 0, error, encode(files if status == "complete" else []), utc_now(), job_id))
            if status == "complete":
                # Retain the snapshot JSON for audit, discard the large frozen
                # source after successful output publication.
                (directory / "input.media").unlink(missing_ok=True)
            self._wake.set()
