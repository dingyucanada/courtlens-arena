"""Measured sentence-by-sentence local Mandarin narration for an existing film."""
import hashlib
import json
import math
import os
import shutil
import subprocess
import urllib.error
import urllib.request
import wave
from pathlib import Path

from ..common import BroadcastError, require
from ..media import FFMPEG, FFPROBE

RATE = 24000
MAX_AUDIO_BYTES = 8 * 1024 * 1024
STEPFUN_ENDPOINTS = {
    "openapi": "https://api.stepfun.com/v1/audio/speech",
    "step-plan": "https://api.stepfun.com/step_plan/v1/audio/speech",
}


def _stepfun_endpoint():
    variant = os.environ.get("COURTLENS_STEPFUN_API_VARIANT", "openapi")
    require(variant in STEPFUN_ENDPOINTS, "voice_unavailable", "StepFun API 路径配置无效。", 503)
    return STEPFUN_ENDPOINTS[variant]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def configured_voice(mode, requested=None):
    """Resolve only a deployment-approved voice, never a client supplied endpoint."""
    require(mode in ("local-tts", "minimax", "stepfun"), "invalid_request", "声音提供者无效。")
    if mode == "local-tts":
        require(requested in (None, "Tingting"), "invalid_request", "本地语音仅支持已安装的 Tingting。")
        return "Tingting"
    prefix = "MINIMAX" if mode == "minimax" else "STEPFUN"
    key = os.environ.get("COURTLENS_" + prefix + "_API_KEY")
    model = os.environ.get("COURTLENS_" + prefix + "_MODEL")
    voice = os.environ.get("COURTLENS_" + prefix + "_VOICE_ID")
    require(bool(key and model and voice), "voice_unavailable", mode + " 语音密钥、模型或音色未配置。", 503)
    if mode == "stepfun":
        _stepfun_endpoint()
    require(requested in (None, voice), "invalid_request", "所选音色与部署配置不一致。")
    return voice


def _post_audio(url, token, payload, limit):
    request = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json" if "minimax" in url else "audio/mpeg"}, method="POST")
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=20) as response:
            length = response.headers.get("Content-Length")
            require(length is None or int(length) <= limit, "voice_unavailable", "语音响应超出大小限制。", 503)
            content_type = response.headers.get("Content-Type", "").lower()
            raw = response.read(limit + 1)
            require(len(raw) <= limit, "voice_unavailable", "语音响应超出大小限制。", 503)
            return content_type, raw
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise BroadcastError("voice_unavailable", "语音供应商请求失败；请检查配置和服务状态。", 503)


def _external_audio(mode, text, voice):
    prefix = "MINIMAX" if mode == "minimax" else "STEPFUN"
    key = os.environ["COURTLENS_" + prefix + "_API_KEY"]
    model = os.environ["COURTLENS_" + prefix + "_MODEL"]
    if mode == "minimax":
        region = os.environ.get("COURTLENS_MINIMAX_REGION", "global")
        require(region in ("global", "china"), "voice_unavailable", "MiniMax 区域配置无效。", 503)
        host = "api.minimax.io" if region == "global" else "api.minimaxi.com"
        payload = {"model": model, "text": text, "stream": False, "output_format": "hex", "voice_setting": {"voice_id": voice, "speed": 1, "vol": 1, "pitch": 0}, "audio_setting": {"sample_rate": RATE, "bitrate": 128000, "format": "mp3", "channel": 1}}
        content_type, raw = _post_audio("https://" + host + "/v1/t2a_v2", key, payload, MAX_AUDIO_BYTES * 2 + 4096)
        require("json" in content_type, "voice_unavailable", "MiniMax 未返回协议 JSON。", 503)
        try:
            answer = json.loads(raw)
            encoded = answer["data"]["audio"]
            require(answer["base_resp"]["status_code"] == 0 and isinstance(encoded, str) and 0 < len(encoded) <= MAX_AUDIO_BYTES * 2, "voice_unavailable", "MiniMax 未返回有效语音。", 503)
            audio = bytes.fromhex(encoded)
        except (ValueError, TypeError, KeyError, AttributeError):
            raise BroadcastError("voice_unavailable", "MiniMax 语音响应无效。", 503)
    else:
        payload = {"model": model, "input": text, "voice": voice, "response_format": "mp3", "sample_rate": RATE}
        content_type, audio = _post_audio(_stepfun_endpoint(), key, payload, MAX_AUDIO_BYTES)
        require("audio" in content_type or "octet-stream" in content_type, "voice_unavailable", "StepFun 未返回音频。", 503)
    require(0 < len(audio) <= MAX_AUDIO_BYTES and (audio[:3] == b"ID3" or audio[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")), "voice_unavailable", "语音字节不是受支持的 MP3。", 503)
    return audio


def _run(args, timeout=30):
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BroadcastError("voice_unavailable", "中文配音程序不可用或超时。", 503)
    if p.returncode:
        raise BroadcastError("voice_unavailable", "中文配音程序失败：" + p.stderr.decode("utf-8", "replace")[-300:], 503)
    return p.stdout


def synthesize(film, beats, target_dir, duration, mode="local-tts", voice_id=None, has_source_audio=False):
    voice = configured_voice(mode, voice_id)
    say = shutil.which("say") if mode == "local-tts" else None
    if mode == "local-tts":
        require(say is not None, "voice_unavailable", "本地配音需要 macOS say。", 503)
        voices = _run([say, "-v", "?"], 5).decode("utf-8", "replace")
        require(any(line.split()[:1] == ["Tingting"] for line in voices.splitlines()), "voice_unavailable", "本机没有安装婷婷中文语音。", 503)
    target_dir = Path(target_dir)
    sample_count = math.ceil(duration * RATE)
    timeline = bytearray(sample_count * 2)
    report = []
    for i, beat in enumerate(beats):
        start, end = beat["outputStart"], beat["outputEnd"]
        available = end - start - .08
        require(available > .1, "voice_overflow", f"第{i+1}句配音窗口过短。", 422)
        text_file = target_dir / f"voice-{i}.txt"
        text_file.write_text(beat["compiledText"].replace("[[", "（").replace("]]", "）"), encoding="utf-8")
        source_audio = target_dir / f"voice-{i}.{('aiff' if mode == 'local-tts' else 'mp3')}"
        wav = target_dir / f"voice-{i}.wav"
        if mode == "local-tts":
            _run([say, "-v", voice, "-r", "250", "-o", str(source_audio), "-f", str(text_file)], 25)
        else:
            source_audio.write_bytes(_external_audio(mode, beat["compiledText"], voice))
        try:
            raw_duration = float(_run([FFPROBE, "-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(source_audio)], 5).strip())
        except ValueError:
            raise BroadcastError("voice_unavailable", "语音长度无法测量。", 503)
        require(math.isfinite(raw_duration) and raw_duration > 0, "voice_unavailable", "语音文件无效。", 503)
        tempo = max(1.0, raw_duration / available)
        require(tempo <= 2, "voice_overflow", f"第{i+1}句需要{tempo:.2f}倍语速；请缩短文字或延长窗口。", 422)
        _run([FFMPEG, "-v", "error", "-nostdin", "-protocol_whitelist", "file", "-i", str(source_audio), "-af", f"atempo={tempo:.8f}", "-ar", str(RATE), "-ac", "1", "-c:a", "pcm_s16le", "-y", str(wav)], 25)
        with wave.open(str(wav), "rb") as source:
            require((source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, RATE), "voice_unavailable", "语音 PCM 格式无效。", 503)
            frames = source.readframes(source.getnframes())
            speech_duration = source.getnframes() / RATE
        offset = round(start * RATE) * 2
        require(speech_duration <= end - start - .01 and offset + len(frames) <= len(timeline), "voice_overflow", f"第{i+1}句超过字幕窗口，未截断。", 422)
        timeline[offset:offset + len(frames)] = frames
        report.append({"beatId": beat["beatId"], "outputStart": start, "speechDuration": speech_duration, "tempo": tempo, "tailTruncated": False})
    output = target_dir / "narration.wav"
    with wave.open(str(output), "wb") as dest:
        dest.setnchannels(1)
        dest.setsampwidth(2)
        dest.setframerate(RATE)
        dest.writeframes(timeline)
    mixed = target_dir / "with-voice.mp4"
    command = [FFMPEG, "-v", "error", "-nostdin", "-protocol_whitelist", "file", "-i", str(film), "-protocol_whitelist", "file", "-i", str(output), "-map", "0:v:0"]
    if has_source_audio:
        command += ["-filter_complex", "[0:a:0]volume=0.18[original];[1:a:0]volume=1[narration];[original][narration]amix=inputs=2:duration=longest:dropout_transition=0[mix]", "-map", "[mix]"]
    else:
        command += ["-map", "1:a:0"]
    command += ["-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-t", str(duration), "-movflags", "+faststart", "-y", str(mixed)]
    _run(command, 60)
    mixed.replace(film)
    return {"mode": mode, "provider": {"local-tts": "macos-say", "minimax": "minimax", "stepfun": "stepfun"}[mode], "voiceId": voice, "audioSha256": hashlib.sha256(output.read_bytes()).hexdigest(), "cues": report}
