"""Transactional local projects and registered, immutable media files."""

import contextlib
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import uuid

from .validation import ValidationError, validate_dataset

MAX_MEDIA_BYTES = 512 * 1024 * 1024
ID_RE = re.compile(r"^[0-9a-f]{32}$")


class WorkspaceError(Exception):
    def __init__(self, status, message, code="workspace_error"):
        self.status, self.message, self.code = status, message, code
        super().__init__(message)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def valid_id(value):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise WorkspaceError(404, "项目或任务不存在。", "not_found")
    return value


def revision_number(value, field="expected_revision"):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise WorkspaceError(400, f"{field} 必须是正整数。", "invalid_revision")
    return value


def safe_name(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 120:
        raise WorkspaceError(400, "项目名称须为 1–120 个字符。", "invalid_name")
    return value.strip()


def prepare_project_dataset(dataset):
    dataset = validate_dataset(dataset)
    # Stateless legacy analysis remains compatible. Persisting an actual
    # project always requires an explicit review declaration before export.
    dataset.setdefault("workflow", {"state": "draft"})
    return dataset


def check_video_metadata(dataset, media):
    video = dataset["video"]
    if video["width"] != media["width"] or video["height"] != media["height"]:
        raise WorkspaceError(400, "视频尺寸与数据不一致；请先校准对应视频的数据，不能沿用另一画幅的坐标。", "media_dimensions_mismatch")
    if abs(video["duration"] - media["duration"]) > 0.1:
        raise WorkspaceError(400, "视频时长与数据时间轴不一致（容差 0.1 秒）。请先校准数据。", "media_duration_mismatch")


def sync_directory(path):
    if os.name != "posix":
        return
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def executable_available(command):
    if not command:
        return False
    path = shutil.which(command)
    return bool(path and Path(path).is_file() and os.access(path, os.X_OK))


class Workspace:
    def __init__(self, root, app_root=None, render_python=None, ffprobe=None, ffmpeg=None):
        self.root = Path(root).expanduser().resolve()
        self.app_root = Path(app_root or Path(__file__).resolve().parents[1]).resolve()
        self.render_python = str(render_python or sys.executable)
        self.ffprobe = str(ffprobe or shutil.which("ffprobe") or "")
        self.ffmpeg = str(ffmpeg or shutil.which("ffmpeg") or "")
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ("media", "incoming", "jobs"):
            directory = self.root / name
            directory.mkdir(exist_ok=True)
            if directory.is_symlink() or directory.resolve().parent != self.root:
                raise WorkspaceError(500, "工作区子目录不能是外部链接。", "unsafe_workspace")
        self.database = self.root / "workspace.sqlite3"
        if self.database.is_symlink():
            raise WorkspaceError(500, "数据库不能使用符号链接。", "unsafe_workspace")
        with contextlib.closing(self.connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    dataset_json TEXT NOT NULL, media_json TEXT
                );
                CREATE TABLE IF NOT EXISTS revisions (
                    project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL, name TEXT NOT NULL,
                    dataset_json TEXT NOT NULL, media_json TEXT,
                    PRIMARY KEY (project_id, revision)
                );
            """)
    def recover_uploads(self):
        """Call only after the service lock is held, before serving requests."""
        for partial in (self.root / "incoming").glob("*.part"):
            if partial.is_file() and not partial.is_symlink():
                partial.unlink()
        with self.transaction() as db:
            referenced = {json.loads(row[0])["_storage"] for row in db.execute("SELECT media_json FROM revisions WHERE media_json IS NOT NULL")}
            for candidate in (self.root / "media").iterdir():
                if re.fullmatch(r"[0-9a-f]{64}\.(mp4|webm)", candidate.name) and not candidate.is_symlink() and candidate.is_file() and f"media/{candidate.name}" not in referenced:
                    candidate.unlink()

    def connect(self):
        db = sqlite3.connect(str(self.database), timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        return db

    @contextlib.contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def controlled_path(self, relative, must_exist=True):
        """Internal DB paths only; route arguments must never reach this API."""
        if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
            raise WorkspaceError(404, "文件未注册。", "file_not_found")
        candidate = self.root / relative
        if any(part in ("..", ".") for part in Path(relative).parts):
            raise WorkspaceError(404, "无效文件路径。", "file_not_found")
        try:
            candidate.resolve().relative_to(self.root)
        except (OSError, ValueError):
            raise WorkspaceError(404, "文件路径超出工作区。", "file_not_found")
        cursor = candidate
        while cursor != self.root:
            if cursor.is_symlink():
                raise WorkspaceError(404, "注册文件不能是符号链接。", "file_not_found")
            cursor = cursor.parent
        if must_exist and not candidate.is_file():
            raise WorkspaceError(404, "注册文件不存在。", "file_not_found")
        return candidate

    def _row(self, db, project_id):
        valid_id(project_id)
        row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            raise WorkspaceError(404, "项目不存在。", "not_found")
        return row

    def _check_revision(self, row, expected):
        revision_number(expected)
        if row["revision"] != expected:
            raise WorkspaceError(409, f"版本冲突：当前为 {row['revision']}，请求基于 {expected}。请重新打开项目后合并修改。", "revision_conflict")

    def _public(self, row, summary=False):
        dataset = json.loads(row["dataset_json"])
        media = json.loads(row["media_json"]) if row["media_json"] else None
        if media:
            media = {key: value for key, value in media.items() if not key.startswith("_")}
        result = {key: row[key] for key in ("id", "name", "revision", "created_at", "updated_at")}
        result.update(media=media, possession_count=len(dataset["possessions"]))
        if not summary:
            result["dataset"] = dataset
        return result

    def _write_revision(self, db, project_id, name, dataset, media, revision, now):
        dataset_json, media_json = encode(dataset), encode(media) if media else None
        db.execute("UPDATE projects SET name=?,revision=?,updated_at=?,dataset_json=?,media_json=? WHERE id=?", (name, revision, now, dataset_json, media_json, project_id))
        db.execute("INSERT INTO revisions VALUES (?,?,?,?,?,?)", (project_id, revision, now, name, dataset_json, media_json))
        return self._public(self._row(db, project_id))

    def create_project(self, name, dataset):
        name, dataset = safe_name(name), prepare_project_dataset(dataset)
        project_id, now = uuid.uuid4().hex, utc_now()
        media = None
        try:
            with self.transaction() as db:
                # Register shared content under the same writer lock as its
                # first reference; another failed request cannot delete a blob
                # between our existence check and project commit.
                media = self._register_demo(dataset, project_id)
                media_json = encode(media) if media else None
                db.execute("INSERT INTO projects VALUES (?,?,?,?,?,?,?)", (project_id, name, 1, now, now, encode(dataset), media_json))
                db.execute("INSERT INTO revisions VALUES (?,?,?,?,?,?)", (project_id, 1, now, name, encode(dataset), media_json))
                return self._public(self._row(db, project_id))
        except BaseException:
            if media:
                self._discard_unregistered_media(media["_storage"])
            raise

    def _discard_unregistered_media(self, relative):
        # Check references while holding the same writer lock used by imports;
        # a failing request must not remove another project's identical media.
        with self.transaction() as db:
            referenced = any(json.loads(row[0]).get("_storage") == relative for row in db.execute("SELECT media_json FROM revisions WHERE media_json IS NOT NULL"))
            if not referenced:
                self.controlled_path(relative, must_exist=False).unlink(missing_ok=True)

    def _register_demo(self, dataset, project_id):
        if dataset["video"]["url"] != "/media/demo.mp4" or not dataset["video"].get("sha256"):
            return None
        source = self.app_root / "media" / "demo.mp4"
        expected = dataset["video"]["sha256"]
        if not source.is_file() or sha256_file(source) != expected:
            raise WorkspaceError(400, "内置演练视频指纹不匹配，未自动注册媒体。", "demo_fingerprint_mismatch")
        probed = self.probe_media(source)
        check_video_metadata(dataset, probed)
        relative = f"media/{expected}.{probed.pop('_extension')}"
        destination = self.controlled_path(relative, must_exist=False)
        if destination.exists():
            if sha256_file(destination) != expected:
                raise WorkspaceError(409, "工作区中的演练媒体指纹异常。", "stored_media_corrupt")
        else:
            partial = self.root / "incoming" / (uuid.uuid4().hex + ".part")
            try:
                with source.open("rb") as src, partial.open("xb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                    dst.flush()
                    os.fsync(dst.fileno())
                os.replace(partial, destination)
                sync_directory(destination.parent)
            finally:
                partial.unlink(missing_ok=True)
        url = f"/api/projects/{project_id}/media"
        dataset["video"]["url"] = url
        return {**probed, "sha256": expected, "bytes": destination.stat().st_size, "original_name": "demo.mp4", "uploaded_at": utc_now(), "url": url, "_storage": relative}

    def get_project(self, project_id):
        with contextlib.closing(self.connect()) as db:
            return self._public(self._row(db, project_id))

    def list_projects(self):
        with contextlib.closing(self.connect()) as db:
            return [self._public(row, summary=True) for row in db.execute("SELECT * FROM projects ORDER BY updated_at DESC,id")]

    def save_project(self, project_id, name, dataset, expected_revision):
        name, dataset = safe_name(name), prepare_project_dataset(dataset)
        with self.transaction() as db:
            row = self._row(db, project_id)
            self._check_revision(row, expected_revision)
            media = json.loads(row["media_json"]) if row["media_json"] else None
            if media:
                check_video_metadata(dataset, media)
                if dataset["video"].get("sha256") not in (None, "", media["sha256"]):
                    raise WorkspaceError(400, "视频指纹不能通过编辑 JSON 改写；请使用本地视频导入换源。", "media_fingerprint_mismatch")
                dataset["video"].update(url=f"/api/projects/{project_id}/media", sha256=media["sha256"])
            return self._write_revision(db, project_id, name, dataset, media, row["revision"] + 1, utc_now())

    def history(self, project_id):
        with contextlib.closing(self.connect()) as db:
            self._row(db, project_id)
            return [dict(row) for row in db.execute("SELECT revision,created_at,name FROM revisions WHERE project_id=? ORDER BY revision DESC", (project_id,))]

    def restore_project(self, project_id, revision, expected_revision):
        revision_number(revision, "revision")
        with self.transaction() as db:
            row = self._row(db, project_id)
            self._check_revision(row, expected_revision)
            old = db.execute("SELECT * FROM revisions WHERE project_id=? AND revision=?", (project_id, revision)).fetchone()
            if old is None:
                raise WorkspaceError(404, "历史版本不存在。", "revision_not_found")
            dataset = prepare_project_dataset(json.loads(old["dataset_json"]))
            media = json.loads(old["media_json"]) if old["media_json"] else None
            if media:
                source = self.controlled_path(media["_storage"])
                check_video_metadata(dataset, media)
                if dataset["video"].get("sha256") != media["sha256"] or sha256_file(source) != media["sha256"]:
                    raise WorkspaceError(409, "历史版本的视频指纹已变化，不能恢复错误文件绑定。", "historical_media_corrupt")
            return self._write_revision(db, project_id, old["name"], dataset, media, row["revision"] + 1, utc_now())

    def probe_media(self, path):
        if not executable_available(self.ffprobe):
            raise WorkspaceError(503, "未检测到 FFprobe，不能验证并导入视频。", "ffprobe_unavailable")
        try:
            proc = subprocess.run([self.ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", str(path)], capture_output=True, timeout=30, check=False)
            if proc.returncode:
                raise ValueError("无法解析有效视频")
            info = json.loads(proc.stdout)
            video = next(s for s in info.get("streams", []) if s.get("codec_type") == "video")
            duration = float(info.get("format", {}).get("duration", video.get("duration", "nan")))
            width, height = int(video["width"]), int(video["height"])
            if not math.isfinite(duration) or duration <= 0 or duration > 14400 or not 1 <= width <= 32768 or not 1 <= height <= 32768:
                raise ValueError("尺寸或时长超出支持范围")
            from .media import verify_video_coverage
            verify_video_coverage(path, video, duration, self.ffprobe)
            rotations = [video.get("tags", {}).get("rotate", 0)] + [side.get("rotation", 0) for side in video.get("side_data_list", [])]
            if any(not math.isfinite(float(angle)) or float(angle) % 360 != 0 for angle in rotations):
                raise ValueError("视频带旋转元数据；请先转正为实际横竖画幅，再校准尺寸和坐标")
            formats = set(info.get("format", {}).get("format_name", "").split(","))
            if formats.intersection({"mov", "mp4", "m4a", "3gp", "3g2", "mj2"}):
                extension, content_type = "mp4", "video/mp4"
            elif formats.intersection({"matroska", "webm"}):
                extension, content_type = "webm", "video/webm"
            else:
                raise ValueError("仅支持 MP4/MOV 与 WebM/Matroska 视频")
            return {"width": width, "height": height, "duration": duration, "content_type": content_type, "codec": video.get("codec_name", "unknown"), "has_audio": any(s.get("codec_type") == "audio" for s in info.get("streams", [])), "_extension": extension}
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, StopIteration) as exc:
            raise WorkspaceError(400, "视频验证失败：" + str(exc), "invalid_media") from exc

    def import_media(self, project_id, stream, length, filename, expected_revision, content_type=None):
        valid_id(project_id)
        revision_number(expected_revision)
        if isinstance(length, bool) or not isinstance(length, int) or length <= 0:
            raise WorkspaceError(400, "上传必须提供正整数 Content-Length。", "invalid_content_length")
        if length > MAX_MEDIA_BYTES:
            raise WorkspaceError(413, "视频超过 512 MiB 限制。", "media_too_large")
        original_name = str(filename or "video").replace("\\", "/").split("/")[-1][:255]
        if not original_name or any(ord(ch) < 32 for ch in original_name):
            original_name = "video"
        # Fail conflicts before accepting a large upload; recheck under the
        # commit transaction because another tab may save while bytes arrive.
        with contextlib.closing(self.connect()) as db:
            self._check_revision(self._row(db, project_id), expected_revision)
        partial = self.root / "incoming" / (uuid.uuid4().hex + ".part")
        digest, written, created_storage = hashlib.sha256(), 0, None
        try:
            with partial.open("xb") as sink:
                while written < length:
                    chunk = stream.read(min(1024 * 1024, length - written))
                    if not chunk:
                        raise WorkspaceError(400, "视频上传中断；未替换原视频。", "upload_interrupted")
                    if not isinstance(chunk, bytes) or written + len(chunk) > length:
                        raise WorkspaceError(400, "上传长度与声明不一致。", "upload_length_mismatch")
                    sink.write(chunk)
                    digest.update(chunk)
                    written += len(chunk)
                sink.flush()
                os.fsync(sink.fileno())
            probed = self.probe_media(partial)
            sha = digest.hexdigest()
            relative = f"media/{sha}.{probed.pop('_extension')}"
            destination = self.controlled_path(relative, must_exist=False)
            with self.transaction() as db:
                row = self._row(db, project_id)
                self._check_revision(row, expected_revision)
                dataset = prepare_project_dataset(json.loads(row["dataset_json"]))
                check_video_metadata(dataset, probed)
                # Existing content-addressed files are never overwritten; old
                # revisions and queued exports retain the same immutable bytes.
                if destination.exists():
                    if sha256_file(destination) != sha:
                        raise WorkspaceError(409, "已注册媒体的指纹异常；拒绝覆盖，请检查工作区文件。", "stored_media_corrupt")
                else:
                    os.replace(partial, destination)
                    created_storage = relative
                    sync_directory(destination.parent)
                media = {**probed, "sha256": sha, "bytes": written, "original_name": original_name, "uploaded_at": utc_now(), "url": f"/api/projects/{project_id}/media", "_storage": relative}
                dataset["video"].update(url=media["url"], sha256=sha)
                return self._write_revision(db, project_id, row["name"], dataset, media, row["revision"] + 1, utc_now())
        except BaseException as exc:
            if created_storage:
                self._discard_unregistered_media(created_storage)
            if isinstance(exc, OSError):
                raise WorkspaceError(400, "视频上传失败或中断；原项目未修改。", "upload_interrupted") from exc
            raise
        finally:
            partial.unlink(missing_ok=True)

    def media_file(self, project_id):
        with contextlib.closing(self.connect()) as db:
            row = self._row(db, project_id)
            if not row["media_json"]:
                raise WorkspaceError(404, "项目尚未导入本地视频。", "media_not_found")
            media = json.loads(row["media_json"])
            return self.controlled_path(media["_storage"]), media["content_type"]

    def capabilities(self):
        pillow = False
        try:
            pillow = subprocess.run([self.render_python, "-c", "from PIL import Image, ImageDraw, ImageFont"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode == 0
        except (OSError, subprocess.SubprocessError):
            pass
        ffmpeg, ffprobe = executable_available(self.ffmpeg), executable_available(self.ffprobe)
        available = bool(pillow and ffmpeg and ffprobe and (self.app_root / "tools" / "export_video.py").is_file())
        tts_available = sys.platform == "darwin" and executable_available(shutil.which("say"))
        return {"ffmpeg": ffmpeg, "ffprobe": ffprobe, "render_available": available, "render_python": self.render_python, "tts_available": bool(tts_available), "cloud_configured": False, "mode": "local", "max_media_bytes": MAX_MEDIA_BYTES, "pillow": pillow}


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
