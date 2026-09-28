"""Optional local narration for browser-recorded Arena WebM.

Only validated bytes and fixed local tool names cross the subprocess boundary.
Duration agreement permits a small, *approximate* uniform cue-clock adjustment;
it does not authenticate evidence or verify each cue against video frames.
Speech is measured after tempo adjustment and inserted into a PCM timeline in
full. The original video's sound is deliberately omitted from the MP4.
"""

import base64
import binascii
from dataclasses import dataclass
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import wave


MAX_VIDEO_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 96 * 1024 * 1024
MAX_CUES = 256
MAX_TEXT_CHARACTERS = 20_000
MAX_DURATION_SECONDS = 180.0
DEADLINE_SECONDS = 120.0
VOICE = "Tingting"
SAMPLE_RATE = 48_000
PROVIDER = "macos-say-local"
_SLOTS = threading.BoundedSemaphore(2)


class ArenaVoiceError(ValueError):
    def __init__(self, message, code="invalid_request", status=400):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status

    def as_dict(self):
        return {"error": self.message, "code": self.code}


@dataclass(frozen=True)
class NarrationResult:
    video_bytes: bytes
    report: dict

    def response_headers(self):
        summary = {key: self.report[key] for key in (
            "provider", "voice", "cueCount", "durationSeconds", "plannedDurationSeconds",
            "inputDurationSeconds", "timingDriftSeconds", "timingScale", "alignment",
            "originalAudio", "sourceAuthenticated", "cueFrameAlignmentVerified")}
        return {
            "X-CourtLens-Voice-Provider": PROVIDER,
            "X-CourtLens-Voice-Voice": VOICE,
            "X-CourtLens-Voice-Duration": str(self.report["durationSeconds"]),
            "X-CourtLens-Voice-Original-Audio": "omitted",
            "X-CourtLens-Voice-Report": json.dumps(summary, ensure_ascii=True, separators=(",", ":")),
        }


def _fail(message, code="invalid_request", status=400):
    raise ArenaVoiceError(message, code, status)


def _number(value, label, low=0, high=MAX_DURATION_SECONDS):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label} 必须是有限秒数。")
    try:
        valid = math.isfinite(value) and low <= value <= high
    except (OverflowError, ValueError):
        valid = False
    if not valid:
        _fail(f"{label} 超出允许范围（最长 180 秒）。")
    return float(value)


def _text(value, label, maximum, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        _fail(f"{label} 文本无效或超出长度上限。")
    if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
        _fail(f"{label} 含有无效控制字符。")
    try:
        value.encode("utf-8")
    except UnicodeError:
        _fail(f"{label} 编码无效。")
    return value


def validate_request(body):
    """Return a new normalized request; never accept input/output file paths."""
    if not isinstance(body, dict):
        _fail("配音请求必须是 JSON 对象。")
    if set(body) - {"videoBase64", "cues", "duration", "provenance", "voice"}:
        _fail("配音请求包含不支持的字段；只接受视频字节与解说时间表。")
    if body.get("voice", VOICE) != VOICE:
        _fail("本地配音目前只支持 Tingting（婷婷）语音。", "unsupported_voice")
    duration = _number(body.get("duration"), "成片计划时长", 0.001)
    cues = body.get("cues")
    if not isinstance(cues, list) or not 1 <= len(cues) <= MAX_CUES:
        _fail("配音需要 1–256 条解说。", "invalid_cues")
    normalized, characters = [], 0
    for index, cue in enumerate(cues):
        if not isinstance(cue, dict):
            _fail(f"第 {index + 1} 条解说必须是对象。", "invalid_cues")
        start = _number(cue.get("start"), "解说开始时间")
        end = _number(cue.get("end"), "解说结束时间")
        if start >= end or end > duration:
            _fail(f"第 {index + 1} 条解说超出成片计划或没有可用时段。", "invalid_cues")
        text = _text(cue.get("text"), "解说", MAX_TEXT_CHARACTERS)
        characters += len(text)
        if characters > MAX_TEXT_CHARACTERS:
            _fail("解说总文字超过 20,000 字符。", "text_too_large", 413)
        evidence = cue.get("evidenceIds", [])
        if not isinstance(evidence, list) or len(evidence) > 128:
            _fail("解说证据引用须为最多 128 个标识组成的数组。", "invalid_cues")
        evidence = [_text(item, "证据标识", 320) for item in evidence]
        origin = _text(cue.get("origin", "unmarked"), "解说来源", 80)
        normalized.append({"start": start, "end": end, "text": text,
                           "evidenceIds": evidence, "origin": origin})
    normalized.sort(key=lambda cue: cue["start"])
    if any(left["end"] > right["start"] for left, right in zip(normalized, normalized[1:])):
        _fail("解说时间段重叠；请先调整字幕时间，避免同时播放两句声音。", "overlapping_cues")
    provenance = body.get("provenance")
    if not isinstance(provenance, dict):
        _fail("需要 provenance 来源声明对象。")
    kind = _text(provenance.get("kind"), "来源类型", 80)
    try:
        provenance_raw = json.dumps(provenance, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError, UnicodeError):
        _fail("来源声明必须是有效 JSON。")
    if len(provenance_raw) > 16_384:
        _fail("来源声明超过 16 KiB。", "metadata_too_large", 413)
    encoded = body.get("videoBase64")
    if not isinstance(encoded, str) or not encoded:
        _fail("需要非空 videoBase64 视频字节。", "invalid_video")
    if len(encoded) > 4 * ((MAX_VIDEO_BYTES + 2) // 3):
        _fail("录制视频超过 64 MiB；请缩短片单或降低分辨率。", "video_too_large", 413)
    try:
        video = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError, UnicodeError):
        _fail("videoBase64 不是有效的标准 Base64。", "invalid_video")
    if len(video) > MAX_VIDEO_BYTES:
        _fail("录制视频超过 64 MiB。", "video_too_large", 413)
    if not video.startswith(b"\x1a\x45\xdf\xa3"):
        _fail("本接口只接受浏览器录制的 WebM 视频。", "invalid_video")
    return {"video": video, "cues": normalized, "duration": duration, "provenanceKind": kind}


def _execute(command, *, timeout):
    """No shell, inherited input, network protocols, or user-selected executables."""
    try:
        result = subprocess.run(command, shell=False, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        _fail("本地配音或编码超时；请减少片段与解说数量后重试。", "voice_timeout", 504)
    except (OSError, UnicodeError):
        _fail("本地配音工具无法启动或读取；请检查 say、ffmpeg 与 ffprobe。", "tool_failed", 503)
    if result.returncode:
        _fail("本地配音或编码工具执行失败；请检查录制文件和本机语音组件。", "render_failed", 422)
    if len(result.stdout) > 8 * 1024 * 1024:
        _fail("视频探测结果超出安全限制；请缩短视频。", "probe_too_large", 413)
    return result.stdout


def capabilities():
    say, ffmpeg, ffprobe = (shutil.which(name) for name in ("say", "ffmpeg", "ffprobe"))
    installed = False
    if say:
        try:
            voices = _execute([say, "-v", "?"], timeout=3)
            installed = any(line.split()[:1] == [VOICE] for line in voices.splitlines())
        except ArenaVoiceError:
            pass
    return {
        "available": bool(say and ffmpeg and ffprobe and installed),
        "provider": PROVIDER, "voice": VOICE, "local": True,
        "tts": {"available": bool(say and installed), "sayAvailable": bool(say), "voiceAvailable": installed},
        "renderer": {"available": bool(ffmpeg and ffprobe), "ffmpegAvailable": bool(ffmpeg),
                     "ffprobeAvailable": bool(ffprobe), "container": "mp4", "videoCodec": "h264", "audioCodec": "aac"},
        "realTestPassed": False,
        "availabilityBasis": "local-tool-and-installed-voice-discovery-only",
        "originalAudio": "omitted", "alignment": "small-uniform-duration-adjustment-approximate",
        "limits": {"videoBytes": MAX_VIDEO_BYTES, "jsonBytes": MAX_JSON_BYTES, "cues": MAX_CUES,
                   "textCharacters": MAX_TEXT_CHARACTERS, "durationSeconds": MAX_DURATION_SECONDS,
                   "concurrentRequests": 2, "timeoutSeconds": DEADLINE_SECONDS, "maxSpeechTempo": 2},
    }


def _packet_clock_duration(raw):
    """Read named ffprobe JSON fields; packet side data is unrelated to time.

MediaRecorder packets can omit duration even when later packets contain it.
Unknown durations contribute zero instead of an invented frame interval. The
clock remains an approximate endpoint measurement, subject to the existing
duration/drift checks, rather than a claim of cue-by-frame alignment.
"""
    try:
        document = json.loads(raw)
        if not isinstance(document, dict):
            raise ValueError()
        packets = document.get("packets")
        if not isinstance(packets, list) or not packets:
            raise ValueError()
        starts, ends = [], []
        for packet in packets:
            if not isinstance(packet, dict):
                raise ValueError()
            start_value = packet.get("pts_time")
            duration_value = packet.get("duration_time", "N/A")
            if isinstance(start_value, bool) or not isinstance(start_value, (str, int, float)):
                raise ValueError()
            if isinstance(duration_value, bool) or not isinstance(duration_value, (str, int, float)):
                raise ValueError()
            start = float(start_value)
            length = 0.0 if duration_value == "N/A" else float(duration_value)
            if not math.isfinite(start) or not math.isfinite(length) or length < 0:
                raise ValueError()
            starts.append(start)
            ends.append(start + length)
        if min(starts) < -0.05 or min(starts) > 0.5:
            raise ValueError()
        duration = max(ends) - min(starts)
        if not 0 < duration <= MAX_DURATION_SECONDS:
            raise ValueError()
        return duration
    except (ValueError, TypeError, OverflowError, RecursionError):
        _fail("无法可靠读取录制视频的实际时间轴，或视频超过 180 秒。", "invalid_video_clock", 422)


def narrate(body, *, executor=None):
    """Produce real MP4 bytes and a full local report, or a descriptive error."""
    if not _SLOTS.acquire(blocking=False):
        _fail("已有两个本地配音任务正在处理，请稍后重试。", "voice_busy", 429)
    try:
        try:
            return _narrate(body, executor or _execute)
        except OSError:
            _fail("本地配音文件读写失败，请检查临时目录权限与可用磁盘空间。", "local_io_failed", 500)
    finally:
        _SLOTS.release()


def _narrate(body, execute):
    request = validate_request(body)
    say, ffmpeg, ffprobe = (shutil.which(name) for name in ("say", "ffmpeg", "ffprobe"))
    if not all((say, ffmpeg, ffprobe)):
        _fail("本地配音需要 macOS say、ffmpeg 和 ffprobe；当前工具不可用。", "voice_unavailable", 503)
    deadline = time.monotonic() + DEADLINE_SECONDS

    def run(command, seconds=30):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _fail("本地配音超过 120 秒处理上限。", "voice_timeout", 504)
        result = execute(command, timeout=min(seconds, remaining))
        if time.monotonic() > deadline:
            _fail("本地配音超过 120 秒处理上限。", "voice_timeout", 504)
        return result

    if not any(line.split()[:1] == [VOICE] for line in run([say, "-v", "?"], 3).splitlines()):
        _fail("本机尚未安装 Tingting（婷婷）语音，请在 macOS 语音设置中安装。", "voice_unavailable", 503)

    with tempfile.TemporaryDirectory(prefix="courtlens-arena-voice-") as temporary:
        directory = Path(temporary)
        video_path, audio_path, output_path = directory / "recording.webm", directory / "narration.wav", directory / "narrated.mp4"
        video_path.write_bytes(request["video"])
        probe_options = [ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe"]
        try:
            info = json.loads(run(probe_options + ["-f", "matroska", "-select_streams", "v:0",
                "-show_entries", "stream=codec_type,codec_name,width,height:format=format_name", "-of", "json", str(video_path)]))
            stream = info["streams"][0]
            width, height = int(stream["width"]), int(stream["height"])
            if stream["codec_type"] != "video" or stream["codec_name"] not in {"vp8", "vp9", "av1"}:
                raise ValueError()
            if not (0 < width <= 3840 and 0 < height <= 2160 and width * height <= 3840 * 2160):
                raise ValueError()
        except (ValueError, TypeError, KeyError, IndexError):
            _fail("WebM 视频轨道无效或超过 3840×2160 分辨率限制。", "invalid_video", 422)
        # MediaRecorder commonly omits WebM's container duration. Measure the
        # video packet clock instead of trusting the browser's planned duration.
        packets = run(probe_options + ["-f", "matroska", "-select_streams", "v:0", "-show_packets",
            "-show_entries", "packet=pts_time,duration_time", "-of", "json", str(video_path)])
        actual_duration = _packet_clock_duration(packets)
        planned = request["duration"]
        drift = actual_duration - planned
        tolerance = max(0.5, planned * 0.02)
        if abs(drift) > tolerance + 1e-9:
            _fail(f"录制时长 {actual_duration:.3f} 秒与计划 {planned:.3f} 秒相差 {abs(drift):.3f} 秒，超过 {tolerance:.3f} 秒容差；请重新录制。", "timing_drift", 422)
        scale = actual_duration / planned
        pcm = bytearray(math.ceil(actual_duration * SAMPLE_RATE) * 2)
        logs = []
        for index, cue in enumerate(request["cues"]):
            start, end = cue["start"] * scale, cue["end"] * scale
            # Reserve space for atempo's windowing and millisecond frame clocks.
            available = end - start - 0.08
            if available <= 0:
                _fail(f"第 {index + 1} 条解说时间过短，请延长片段或精简文字。", "speech_too_dense", 422)
            speech_path, fitted_path, text_path = directory / f"speech-{index}.aiff", directory / f"fitted-{index}.wav", directory / f"text-{index}.txt"
            # Disable say's embedded [[...]] control syntax; text cannot supply
            # voice options, local paths, or commands.
            spoken_text = cue["text"].replace("[[", "（").replace("]]", "）")
            text_path.write_text(spoken_text, encoding="utf-8")
            run([say, "-v", VOICE, "-r", "250", "-o", str(speech_path), "-f", str(text_path)], 20)
            try:
                original_duration = float(run(probe_options + ["-show_entries", "format=duration",
                    "-of", "default=nw=1:nk=1", str(speech_path)], 5).strip())
                if not math.isfinite(original_duration) or original_duration <= 0:
                    raise ValueError()
            except ValueError:
                _fail("本地语音没有生成有效声音；请检查 macOS 婷婷语音组件与运行权限。", "invalid_speech", 422)
            tempo = max(1.0, original_duration / available)
            if tempo > 2:
                _fail(f"第 {index + 1} 条解说需要 {tempo:.2f} 倍语速，超过 2 倍上限；请精简文字或延长字幕。", "speech_too_dense", 422)
            audio_filter = f"atempo={tempo:.9f}" if tempo > 1 else "anull"
            run([ffmpeg, "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-i", str(speech_path),
                 "-af", audio_filter, "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", "-threads", "2", str(fitted_path)], 20)
            try:
                with wave.open(str(fitted_path), "rb") as speech:
                    if (speech.getnchannels(), speech.getsampwidth(), speech.getframerate()) != (1, 2, SAMPLE_RATE):
                        raise ValueError()
                    fitted_duration = speech.getnframes() / SAMPLE_RATE
                    samples = speech.readframes(speech.getnframes())
            except (OSError, wave.Error, ValueError):
                _fail("语音编码结果无效。", "invalid_speech", 422)
            offset = round(start * SAMPLE_RATE) * 2
            if fitted_duration <= 0 or fitted_duration > end - start - 0.01 or offset + len(samples) > len(pcm):
                _fail(f"第 {index + 1} 条解说实际声音超过字幕时间；已停止导出，未截断句尾。", "speech_too_dense", 422)
            pcm[offset:offset + len(samples)] = samples
            logs.append({**cue, "outputStart": round(start, 6), "outputEnd": round(end, 6),
                         "speechOriginalSeconds": round(original_duration, 6), "speechSeconds": round(fitted_duration, 6),
                         "speechEndSeconds": round(start + fitted_duration, 6), "tempo": round(tempo, 6), "tailTruncated": False})
        with wave.open(str(audio_path), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(SAMPLE_RATE)
            audio.writeframes(pcm)
        run([ffmpeg, "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-f", "matroska", "-i", str(video_path),
             "-protocol_whitelist", "file,pipe", "-i", str(audio_path), "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1",
             "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
             "-threads", "2", "-fps_mode", "vfr", "-c:a", "aac", "-b:a", "128k", "-t", f"{actual_duration:.9f}",
             "-movflags", "+faststart", str(output_path)], 90)
        try:
            final = json.loads(run(probe_options + ["-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", str(output_path)], 5))
            duration = float(final["format"]["duration"])
            streams = final["streams"]
            video = next(stream for stream in streams if stream["codec_type"] == "video")
            audio = next(stream for stream in streams if stream["codec_type"] == "audio")
            if video["codec_name"] != "h264" or audio["codec_name"] != "aac" or not math.isfinite(duration) or abs(duration - actual_duration) > 0.15:
                raise ValueError()
            output = output_path.read_bytes()
            if not output or len(output) > 128 * 1024 * 1024:
                raise ValueError()
        except (OSError, ValueError, TypeError, KeyError, StopIteration):
            _fail("成片音视频验证失败，未提供不完整文件。", "output_verification_failed", 422)
        report = {
            "provider": PROVIDER, "voice": VOICE, "local": True, "cueCount": len(logs),
            "durationSeconds": round(duration, 6), "plannedDurationSeconds": planned,
            "inputDurationSeconds": round(actual_duration, 6), "timingDriftSeconds": round(drift, 6),
            "timingScale": round(scale, 9), "timingToleranceSeconds": round(tolerance, 6),
            "alignment": "small-uniform-duration-adjustment-approximate",
            "cueFrameAlignmentVerified": False, "sourceAuthenticated": False,
            "originalAudio": "omitted", "provenanceKind": request["provenanceKind"],
            "videoCodec": "h264", "audioCodec": "aac", "bytes": len(output),
            "resolution": {"width": video["width"], "height": video["height"]}, "cues": logs,
        }
        return NarrationResult(output, report)
