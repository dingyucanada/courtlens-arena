"""Bounded local upload, ffprobe PTS inspection and immutable frame extraction."""
import hashlib
import json
import math
import os
import re
import subprocess
import shutil
from fractions import Fraction
from pathlib import Path

from .common import BroadcastError, uid, finite, require

MAX_UPLOAD = 256 * 1024 * 1024
MAX_DURATION = 180
FFMPEG = os.environ.get("COURTLENS_FFMPEG") or shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FFPROBE = os.environ.get("COURTLENS_FFPROBE") or shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"


def run(argv, timeout=90):
    try:
        return subprocess.run(argv, capture_output=True, timeout=timeout, check=True)
    except subprocess.TimeoutExpired:
        raise BroadcastError("media_unreadable", "媒体处理超时。", 422)
    except (subprocess.CalledProcessError, OSError) as exc:
        detail = getattr(exc, "stderr", b"")[-500:].decode("utf-8", "replace") if getattr(exc, "stderr", None) else "程序不可用"
        raise BroadcastError("media_unreadable", "媒体处理失败：" + detail, 422)


def probe(path):
    data = json.loads(run([FFPROBE, "-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", str(path)]).stdout)
    require(data.get("format", {}).get("format_name", "").split(",")[0] in {"mov", "matroska", "avi", "mpegts"}, "media_unreadable", "仅允许真实视频容器，不接受播放列表或外部引用。", 422)
    videos = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    require(len(videos) <= 1, "unsupported_video_tracks", "暂不支持多个视频轨；请先导出单视频轨文件再上传。", 422)
    stream = videos[0] if videos else None
    require(stream is not None, "media_unreadable", "没有视频轨。", 422)
    sar = stream.get("sample_aspect_ratio")
    require(sar in (None, "N/A", "0:1", "1:1"), "unsupported_transform", "暂不支持非方形像素视频；请先转为方形像素并重新上传。", 422)
    transforms = [item for item in stream.get("side_data_list", []) if item.get("side_data_type") == "Display Matrix"]
    require(not transforms and str(stream.get("tags", {}).get("rotate", "0")) in ("0", "0.0"), "unsupported_transform", "暂不支持带显示旋转或矩阵变换的视频；请先烘焙旋转后重新上传。", 422)
    try:
        fps = Fraction(stream.get("avg_frame_rate", "0/1"))
        time_base = Fraction(stream["time_base"])
        start_pts = int(stream.get("start_pts", 0))
        duration = float(stream.get("duration") or data["format"]["duration"])
        width, height = int(stream["width"]), int(stream["height"])
    except (KeyError, ValueError, ZeroDivisionError, OverflowError):
        raise BroadcastError("media_unreadable", "无法读取视频时基或时长。", 422)
    require(fps > 0 and time_base > 0 and 0 < duration <= MAX_DURATION and 16 <= width <= 8192 and 16 <= height <= 8192, "media_unreadable", "视频时长或尺寸超出限制。", 422)
    frame_data = run([FFPROBE, "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp", "-of", "csv=p=0", str(path)], timeout=120).stdout.decode()
    raw_pts = []
    for line in frame_data.splitlines():
        try:
            raw_pts.append(int(line.strip().split(",")[0]))
        except ValueError:
            pass
    require(bool(raw_pts), "media_unreadable", "没有可解码的视频帧。", 422)
    try:
        stream_start = float(stream.get("start_time", 0))
        container_start = float(data.get("format", {}).get("start_time", 0))
    except (TypeError, ValueError):
        raise BroadcastError("unsupported_timebase", "源片显示时间轴无法归零。", 422)
    require(raw_pts[0] == 0 and start_pts == 0 and abs(stream_start) < .001 and abs(container_start) < .001, "unsupported_timebase", "源片显示时间轴不是从零开始；请转码归零后重新上传。", 422)
    times = [(p - raw_pts[0]) * float(time_base) for p in raw_pts]
    deltas = [b - a for a, b in zip(times, times[1:]) if b > a]
    nominal = float(1 / fps)
    vfr = any(abs(delta - nominal) > max(0.002, nominal * .08) for delta in deltas)
    return {"duration": duration, "width": width, "height": height, "timeBase": str(time_base.numerator) + "/" + str(time_base.denominator), "startPts": start_pts, "firstFramePts": raw_pts[0], "fpsNumerator": fps.numerator, "fpsDenominator": fps.denominator, "variableFrameRate": vfr, "hasAudio": any(s.get("codec_type") == "audio" for s in data.get("streams", [])), "framePts": raw_pts, "frameTimes": times}


def stream_upload(input_stream, declared, destination):
    require(type(declared) is int and 0 < declared <= MAX_UPLOAD, "upload_too_large", "上传需声明不超过 256 MiB 的准确字节数。", 413)
    digest = hashlib.sha256()
    remaining = declared
    with Path(destination).open("xb") as target:
        while remaining:
            part = input_stream.read(min(1024 * 1024, remaining))
            require(bool(part), "media_unreadable", "上传在声明字节数前结束。", 400)
            target.write(part)
            digest.update(part)
            remaining -= len(part)
        target.flush()
        os.fsync(target.fileno())
    return digest.hexdigest()


def safe_filename(value):
    text = re.sub(r"[^\w. -]", "_", str(value or "video.mp4"))[:120].strip(" .")
    return text or "video.mp4"


def frame_at(media_path, meta, requested, output):
    require(finite(requested) and 0 <= requested < meta["duration"], "invalid_request", "抽帧时间超出源片。")
    times = meta["frameTimes"]
    index = min(range(len(times)), key=lambda i: abs(times[i] - requested))
    actual = times[index]
    run([FFMPEG, "-v", "error", "-nostdin", "-protocol_whitelist", "file", "-i", str(media_path), "-map", "0:v:0", "-vf", f"select=eq(n\\,{index})", "-vsync", "0", "-frames:v", "1", "-y", str(output)], timeout=60)
    require(Path(output).is_file() and Path(output).stat().st_size > 0, "media_unreadable", "抽帧失败。", 422)
    return actual, meta["framePts"][index]
