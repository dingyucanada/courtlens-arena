"""Bounded, local-only delivery of browser-created Arena videos.

Request data never selects a filesystem path. A random artifact directory is
published only after strict byte, report, and actual media validation succeeds.
Reports remain client declarations; storing an export authenticates no source.
"""

import base64
import binascii
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import uuid

from .workspace import WorkspaceError, executable_available, sync_directory


MAX_VIDEO_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 96 * 1024 * 1024
MAX_REPORT_BYTES = 64 * 1024
MAX_DURATION_SECONDS = 185.0
MAX_STORAGE_BYTES = 256 * 1024 * 1024
MAX_ARTIFACTS = 20
MAX_PROBE_BYTES = 4 * 1024 * 1024
ID_RE = re.compile(r"[0-9a-f]{32}")
_LOCKS = {}
_LOCKS_GUARD = threading.Lock()
_CLAIMS = {"sourceauthenticated", "sourceverified", "evidenceverified",
           "cueframealignmentverified", "serververified", "authenticated", "verified"}
_PRIVATE_FIELDS = {"videobase64", "videopath", "outputpath", "inputpath",
                   "apikey", "authorization", "password", "secret", "accesstoken"}


def _fail(message, code="invalid_arena_export", status=400):
    raise WorkspaceError(status, message, code)


def _filename(value):
    if not isinstance(value, str) or not value or len(value) > 120 or value != value.strip():
        _fail("成片文件名须为 1–120 个字符。", "invalid_filename")
    if value in (".", "..") or any(char in value for char in '/\\:') or any(ord(char) < 32 or ord(char) == 127 for char in value):
        _fail("成片文件名不能包含路径或控制字符。", "invalid_filename")
    try:
        value.encode("utf-8")
    except UnicodeError:
        _fail("成片文件名编码无效。", "invalid_filename")
    if Path(value).suffix.lower() not in {".webm", ".mp4"}:
        _fail("成片文件名必须使用 .webm 或 .mp4。", "invalid_filename")
    return value


def _report(value):
    if not isinstance(value, dict):
        _fail("成片报告须为 JSON 对象。", "invalid_report")
    nodes = 0

    def visit(item, depth=0):
        nonlocal nodes
        nodes += 1
        if nodes > 4000 or depth > 16:
            _fail("成片报告结构超出限制。", "invalid_report", 413)
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str) or len(key) > 160:
                    _fail("成片报告字段无效。", "invalid_report")
                normalized = re.sub(r"[^a-z]", "", key.lower())
                if normalized in _PRIVATE_FIELDS:
                    _fail("成片报告不能包含凭据或本机输入输出路径。", "invalid_report")
                if normalized in _CLAIMS and child is not False and child is not None:
                    _fail("本机保存不能声明视频来源或证据已经验证。", "unverified_report_claim")
                visit(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                visit(child, depth + 1)
        elif item is None or isinstance(item, (str, bool)):
            return
        elif isinstance(item, (int, float)):
            try:
                if not math.isfinite(item):
                    raise ValueError()
            except (OverflowError, ValueError):
                _fail("成片报告数字必须有限。", "invalid_report")
        else:
            _fail("成片报告只能包含简单 JSON 值。", "invalid_report")

    visit(value)
    try:
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, UnicodeError, RecursionError):
        _fail("成片报告编码无效。", "invalid_report")
    if len(raw) > MAX_REPORT_BYTES:
        _fail("成片报告超过 64 KiB 限制。", "report_too_large", 413)
    return json.loads(raw)


def validate_request(body):
    if not isinstance(body, dict) or set(body) - {"videoBase64", "filename", "report"}:
        _fail("成片保存只接受 videoBase64、filename 与 report。")
    filename = _filename(body.get("filename"))
    report = _report(body.get("report", {}))
    encoded = body.get("videoBase64")
    if not isinstance(encoded, str) or not encoded:
        _fail("成片视频字节不能为空。", "invalid_video_base64")
    if len(encoded) > 4 * ((MAX_VIDEO_BYTES + 2) // 3):
        _fail("成片视频超过 64 MiB 限制。", "video_too_large", 413)
    try:
        video = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        _fail("成片视频需要完整、严格的 Base64 编码。", "invalid_video_base64")
    if not video or base64.b64encode(video).decode("ascii") != encoded:
        _fail("成片视频 Base64 编码无效。", "invalid_video_base64")
    if len(video) > MAX_VIDEO_BYTES:
        _fail("成片视频超过 64 MiB 限制。", "video_too_large", 413)
    if video.startswith(b"\x1a\x45\xdf\xa3"):
        extension, demuxer, mime = "webm", "matroska", "video/webm"
    elif len(video) >= 16 and video[4:8] == b"ftyp":
        extension, demuxer, mime = "mp4", "mov", "video/mp4"
    else:
        _fail("成片必须是实际 WebM 或 MP4 视频。", "invalid_video")
    if Path(filename).suffix.lower() != "." + extension:
        _fail("成片文件扩展名与视频格式不一致。", "filename_format_mismatch")
    return video, filename, report, extension, demuxer, mime


class ArenaArtifacts:
    def __init__(self, workspace_root, ffprobe=None, max_bytes=MAX_STORAGE_BYTES, max_artifacts=MAX_ARTIFACTS):
        self.workspace_root = Path(workspace_root).resolve()
        self.root = self.workspace_root / "arena_artifacts"
        self.ffprobe = str(ffprobe or shutil.which("ffprobe") or "")
        self.max_bytes, self.max_artifacts = max_bytes, max_artifacts
        if self.root.is_symlink():
            _fail("成片保存目录不能是符号链接。", "unsafe_artifact_storage", 500)
        self.root.mkdir(mode=0o700, parents=False, exist_ok=True)
        self._check_root()
        with _LOCKS_GUARD:
            self.lock = _LOCKS.setdefault(str(self.root), threading.RLock())

    def _check_root(self):
        if self.root.is_symlink() or not self.root.is_dir() or self.root.resolve() != self.root:
            _fail("成片保存目录不可用或存在不安全链接。", "unsafe_artifact_storage", 500)

    def _usage(self):
        self._check_root()
        size, count = 0, 0
        for directory in self.root.iterdir():
            if directory.is_symlink() or not directory.is_dir():
                _fail("成片保存目录含有不安全文件或链接。", "unsafe_artifact_storage", 500)
            count += 1  # Crash leftovers also consume storage; never evict exports.
            for file in directory.iterdir():
                if file.is_symlink() or not file.is_file():
                    _fail("成片保存目录含有不安全文件或链接。", "unsafe_artifact_storage", 500)
                size += file.stat().st_size
        return size, count

    def _probe_output(self, command):
        # Temporary output files bound memory even for a corrupt packet index.
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            try:
                result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=output,
                                        stderr=errors, timeout=30, check=False)
            except (OSError, subprocess.SubprocessError):
                _fail("成片视频探测未完成；请检查本机 FFprobe 或缩短视频。", "video_probe_failed", 422)
            if result.returncode:
                _fail("无法解析有效成片视频。", "invalid_video", 422)
            if output.tell() > MAX_PROBE_BYTES:
                _fail("成片视频索引超出限制。", "video_probe_too_large", 413)
            output.seek(0)
            try:
                return json.load(output)
            except (ValueError, UnicodeError, RecursionError):
                _fail("成片视频探测结果无效。", "invalid_video", 422)

    def probe_video(self, path, extension, demuxer):
        if not executable_available(self.ffprobe):
            _fail("本机保存视频需要 FFprobe 验证成片；当前未检测到。", "ffprobe_unavailable", 503)
        options = [self.ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-f", demuxer]
        info = self._probe_output(options + ["-show_entries",
            "format=format_name,duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate",
            "-of", "json", str(path)])
        try:
            streams = info["streams"]
            if not isinstance(streams, list) or not 1 <= len(streams) <= 4:
                raise ValueError()
            videos = [stream for stream in streams if stream.get("codec_type") == "video"]
            if len(videos) != 1:
                raise ValueError()
            video = videos[0]
            allowed = {"vp8", "vp9", "av1"} if extension == "webm" else {"h264", "hevc", "av1", "vp9", "mpeg4"}
            if video["codec_name"] not in allowed or any(stream.get("codec_type") not in {"video", "audio"} for stream in streams):
                raise ValueError()
            audio_codecs = {"opus", "vorbis"} if extension == "webm" else {"aac", "mp3", "opus"}
            if any(stream.get("codec_name") not in audio_codecs for stream in streams if stream.get("codec_type") == "audio"):
                raise ValueError()
            width, height = int(video["width"]), int(video["height"])
            if not (1 <= width <= 8192 and 1 <= height <= 8192 and width * height <= 33_554_432):
                raise ValueError()
            formats = set(info["format"]["format_name"].split(","))
            if not formats.intersection({"webm", "matroska"} if extension == "webm" else {"mp4", "mov"}):
                raise ValueError()
            container_duration = info["format"].get("duration")
            if container_duration is not None and not 0 < float(container_duration) <= MAX_DURATION_SECONDS:
                raise ValueError()
        except (KeyError, TypeError, ValueError, OverflowError):
            _fail("成片视频格式、画幅、帧数或时长无效（最长 185 秒）。", "invalid_video", 422)
        packets = self._probe_output(options + ["-select_streams", "v:0", "-show_packets", "-show_entries",
            "packet=pts_time,dts_time,duration_time", "-of", "json", str(path)])
        try:
            rows = packets["packets"]
            if not isinstance(rows, list) or not 1 <= len(rows) <= 25_000:
                raise ValueError()
            rate = video.get("avg_frame_rate", "0/1").split("/")
            fps = float(rate[0]) / float(rate[1]) if float(rate[1]) else 0
            fallback = 1 / fps if math.isfinite(fps) and 0 < fps <= 240 else 0
            starts, ends = [], []
            for row in rows:
                start = float(row.get("pts_time", row.get("dts_time", "nan")))
                duration = float(row.get("duration_time", fallback))
                if not math.isfinite(start) or not math.isfinite(duration) or duration < 0:
                    raise ValueError()
                starts.append(start)
                ends.append(start + duration)
            actual_duration = max(ends) - min(starts)
            if not 0 < actual_duration <= MAX_DURATION_SECONDS or (container_duration is not None and abs(float(container_duration) - actual_duration) > 2):
                raise ValueError()
        except (KeyError, TypeError, ValueError, OverflowError, ZeroDivisionError):
            _fail("成片实际画面时间轴无效或超出 185 秒限制。", "invalid_video_timeline", 422)
        decoded = self._probe_output(options + ["-select_streams", "v:0", "-count_frames", "-show_entries",
            "stream=nb_read_frames", "-of", "json", str(path)])
        try:
            if not 1 <= int(decoded["streams"][0]["nb_read_frames"]) <= 25_000:
                raise ValueError()
        except (KeyError, IndexError, TypeError, ValueError, OverflowError):
            _fail("成片没有可解码的画面或帧数超出限制。", "invalid_video_frames", 422)
        return {"durationSeconds": round(actual_duration, 6), "width": width, "height": height,
                "codec": video["codec_name"]}

    def save(self, body):
        video, filename, client_report, extension, demuxer, mime = validate_request(body)
        fingerprint = hashlib.sha256(video).hexdigest()
        with self.lock:
            used, count = self._usage()
            if count >= self.max_artifacts or used + len(video) > self.max_bytes:
                _fail("本机成片保存空间已满（最多 20 份、合计 256 MiB）。请先在工作目录中整理已有成片。", "arena_artifact_quota", 507)
            identifier = uuid.uuid4().hex
            final = self.root / identifier
            if final.exists() or final.is_symlink():
                _fail("成片保存标识冲突；请重试。", "artifact_collision", 409)
            pending = Path(tempfile.mkdtemp(prefix=".pending-", dir=self.root))
            try:
                path = pending / ("video." + extension)
                self._write(path, video)
                media = self.probe_video(path, extension, demuxer)
                record = {"filename": filename, "bytes": len(video), "sha256": fingerprint,
                          "contentType": mime, "extension": extension, **media,
                          "storage": "local-workspace", "sourceAuthenticated": False,
                          "cueFrameAlignmentVerified": False, "clientReport": client_report}
                report_bytes = json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
                if used + len(video) + len(report_bytes) > self.max_bytes:
                    _fail("本机成片保存空间不足；请先在工作目录中整理已有成片。", "arena_artifact_quota", 507)
                self._write(pending / "report.json", report_bytes)
                sync_directory(pending)
                self._check_root()
                os.rename(pending, final)
                sync_directory(self.root)
            except BaseException:
                if pending.exists() and not pending.is_symlink():
                    shutil.rmtree(pending)
                raise
        return {"url": f"/api/arena/artifacts/{identifier}/video", "bytes": len(video),
                "sha256": fingerprint, "filename": filename}

    @staticmethod
    def _write(path, raw):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())

    def file(self, identifier, kind="video"):
        if not isinstance(identifier, str) or not ID_RE.fullmatch(identifier) or kind not in {"video", "report"}:
            _fail("成片不存在。", "artifact_not_found", 404)
        self._check_root()
        directory = self.root / identifier
        report_path = directory / "report.json"
        if directory.is_symlink() or not directory.is_dir() or directory.resolve().parent != self.root or report_path.is_symlink() or not report_path.is_file():
            _fail("成片不存在。", "artifact_not_found", 404)
        try:
            if report_path.stat().st_size > MAX_REPORT_BYTES + 4096:
                raise ValueError()
            record = json.loads(report_path.read_bytes())
            extension = record["extension"]
            if extension not in {"mp4", "webm"}:
                raise ValueError()
            filename = _filename(record["filename"])
            video = directory / ("video." + extension)
            if video.is_symlink() or not video.is_file() or video.stat().st_size != record["bytes"]:
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            _fail("成片文件缺失或已变化。", "artifact_not_found", 404)
        if kind == "report":
            return report_path, "application/json", Path(filename).stem + ".report.json"
        return video, "video/" + extension, filename
