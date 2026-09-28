"""Check actual video coverage independently of a potentially longer audio track."""
import json
import math
import subprocess


def video_duration(path, stream, ffprobe="ffprobe"):
    declared = stream.get("duration")
    if declared not in (None, "N/A"):
        duration = float(declared)
    else:
        # WebM commonly omits stream.duration. Packet timestamps avoid decoding
        # every pixel and do not trust the longer container/audio duration.
        result = subprocess.run(
            [ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe",
             "-select_streams", "v:0", "-show_packets", "-show_entries",
             "packet=pts_time,duration_time", "-of", "json", str(path)],
            capture_output=True, timeout=30, check=True)
        packets = json.loads(result.stdout).get("packets", [])
        starts, ends = [], []
        for packet in packets:
            start = float(packet["pts_time"])
            span = float(packet["duration_time"])
            if not math.isfinite(start) or not math.isfinite(span) or span <= 0:
                raise ValueError("无法核对视频画面时间；请先转换为标准 MP4 再导入")
            starts.append(start)
            ends.append(start + span)
        if not starts:
            raise ValueError("视频没有可验证的画面时间戳")
        duration = max(ends) - min(starts)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("视频画面时长无效")
    return duration


def verify_video_coverage(path, stream, timeline_duration, ffprobe="ffprobe", fps=25):
    actual = video_duration(path, stream, ffprobe)
    # Match the exporter's frame count. Container padding that would require
    # even one nonexistent frame is rejected before a project binds the file.
    if round(actual * fps) < round(timeline_duration * fps):
        raise ValueError("视频画面轨短于容器时间轴；请先裁齐音视频尾部并重新导出，再校准时间")
    return actual
