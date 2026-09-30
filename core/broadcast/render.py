"""Real source-video overlay, subtitle and immutable manifest producer."""
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
import math

from .common import BroadcastError, hash_json, now, require, uid
from .media import FFMPEG, FFPROBE
from .validation import story

FONT = os.environ.get("COURTLENS_BROADCAST_FONT") or next((path for path in (
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf",
) if Path(path).is_file()), "")


def font_available(path=FONT):
    if not path or not Path(path).is_file():
        return False
    try:
        from PIL import ImageFont
        font = ImageFont.truetype(path, 32)
        return bytes(font.getmask("中")) != bytes(font.getmask("文"))
    except (ImportError, OSError, ValueError):
        return False


def renderer_fingerprint(font):
    """Capture actual renderer inputs rather than relying on a Git label."""
    from PIL import __version__ as pillow_version
    import platform
    root = Path(__file__).resolve().parents[2]
    files = ["core/broadcast/render.py", "core/broadcast/validation.py", "core/broadcast/providers/voice.py", "core/broadcast/common.py", "core/broadcast/media.py"]
    sources = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
    versions = {}
    for name, binary in (("ffmpeg", FFMPEG), ("ffprobe", FFPROBE)):
        try:
            proc = subprocess.run([binary, "-version"], capture_output=True, timeout=10, check=True)
            versions[name] = proc.stdout.decode("utf-8", "replace").splitlines()[0]
        except (OSError, subprocess.SubprocessError, IndexError):
            versions[name] = "unavailable"
    return {"sources": sources, "fontSha256": hashlib.sha256(Path(font).read_bytes()).hexdigest(), "fontName": Path(font).name, "python": platform.python_version(), "pillow": pillow_version, "tools": versions, "sourceFingerprint": hash_json(sources)}


def background_evidence(project, used_observations):
    """Retain the actual supporting context without treating all imported PBP as seen."""
    context = project["context"]
    rows = [o for o in project["observations"] if o["id"] in used_observations]
    players = {pid for o in rows for pid in o.get("playerIds", [])}
    record_ids = {o.get("source", {}).get("recordId") for o in rows}
    result = {key: context.get(key) for key in ("gameId", "gameDate", "seasonId", "offenseTeamId", "defenseTeamId")}
    result["roster"] = [p for p in context.get("roster", []) if p["id"] in players]
    pbp = context.get("playByPlay")
    if pbp:
        result["playByPlay"] = {"source": pbp["source"], "importSha256": hash_json(pbp),
            "entries": [e for e in pbp["entries"] if e["id"] in record_ids],
            "timeBase": "game-clock; video alignment is recorded in observations",
            "role": "Background corroboration, not official deep metrics or independent visual proof."}
    else:
        result["playByPlay"] = None
    return result


def _stamp(seconds):
    ms = round(seconds * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def _metric_display(project, beat):
    mid = beat.get("metricRecordId")
    if not mid:
        return None
    record = next(x for x in project["metrics"]["records"] if x["id"] == mid)
    entry = project["metrics"]["dictionary"]["metrics"][record["metricId"]]
    value = record["value"]
    require(value is not None, "unresolved_binding", "主指标没有可用值。", 422)
    if entry["unit"] == "probability":
        display = f"{value * 100:.1f}%"
    elif entry["unit"] == "percent":
        display = f"{value:.1f}%"
    else:
        display = f"{value:g} {entry['unit']}"
    provenance = record.get("provenance") or entry.get("provenance") or project["metrics"].get("provenance") or project["metrics"]["dictionary"].get("provenance", {})
    return {"recordId": mid, "label": entry["label"], "value": display, "source": provenance.get("source", "来源未核验"), "granularity": record["scope"]["granularity"]}


def _metric_text(project, beat):
    metric = _metric_display(project, beat)
    return beat["text"].replace("{{metric:" + beat["metricRecordId"] + "}}", metric["value"]) if metric else beat["text"]


def _overlay_text(path, phrase, font_path, label=False):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        raise BroadcastError("render_failed", "缺少 Pillow 图像叠加依赖。", 503)
    image = Image.new("RGBA", (1280, 720), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(font_path, 22 if label else 38)
    if label:
        draw.rounded_rectangle((26, 21, 230, 65), radius=10, fill=(7, 21, 41, 220))
        draw.text((38, 27), phrase, font=font, fill="white")
    else:
        lines, current = [], ""
        for char in phrase:
            if char == "\n":
                lines.append(current)
                current = ""
            elif draw.textbbox((0, 0), current + char, font=font)[2] > 1160 and current:
                lines.append(current)
                current = char
            else:
                current += char
        if current:
            lines.append(current)
        require(1 <= len(lines) <= 3, "render_failed", "解说字幕超过三行，请缩短文字。", 422)
        top = 720 - (len(lines) * 49 + 58)
        draw.rectangle((0, top, 1280, 720), fill=(7, 21, 41, 227))
        for i, line in enumerate(lines):
            draw.text((48, top + 21 + i * 49), line, font=font, fill="white")
    image.save(path)


def _overlay_arrow(path, pts, media):
    from PIL import Image, ImageDraw
    image = Image.new("RGBA", (1280, 720), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    scale = min(1280 / media["width"], 720 / media["height"])
    content_width, content_height = media["width"] * scale, media["height"] * scale
    left, top = (1280 - content_width) / 2, (720 - content_height) / 2
    xy = [(round(left + p["x"] * content_width), round(top + p["y"] * content_height)) for p in pts]
    draw.line(xy, fill=(96, 165, 250, 245), width=7, joint="curve")
    p, q = xy[-2], xy[-1]
    angle = math.atan2(q[1] - p[1], q[0] - p[0])
    left = (q[0] - 23 * math.cos(angle - .5), q[1] - 23 * math.sin(angle - .5))
    right = (q[0] - 23 * math.cos(angle + .5), q[1] - 23 * math.sin(angle + .5))
    draw.polygon([q, left, right], fill=(96, 165, 250, 245))
    image.save(path)


def _overlay_metric(path, metric, font_path):
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGBA", (1280, 720), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((805, 24, 1250, 166), radius=16, fill=(7, 21, 41, 225), outline=(73, 155, 255, 220), width=2)
    small = ImageFont.truetype(font_path, 20)
    large = ImageFont.truetype(font_path, 38)
    draw.text((830, 39), metric["label"][:18], font=small, fill=(192, 220, 255))
    draw.text((830, 68), metric["value"], font=large, fill="white")
    draw.text((830, 122), (metric["granularity"] + " · " + metric["source"])[:28], font=small, fill=(185, 202, 223))
    image.save(path)


def render(project, source_path, destination, font=FONT, voice_mode="silent", voice_id=None, cancel_check=None, understanding=None, first_frame_pts=None, frame_times=None):
    story(project, frame_times)
    require(voice_mode in ("silent", "local-tts", "minimax", "stepfun", "polly"), "voice_unavailable", "所选语音提供者尚未可用。", 503)
    require(not project["media"]["variableFrameRate"], "unsupported_timebase", "变帧率视频需先建立源 PTS 映射，当前只能预览。", 422)
    s = project["story"]
    a, b = s["sourceRange"]["start"], s["sourceRange"]["end"]
    fps = 25
    for value in (a, b):
        target = round(value * fps) / fps
        require(abs(target - value) < 1e-6, "unsupported_timebase", f"剪辑边界 {value:.4f}s 不在 25fps 网格；请明确改为 {target:.2f}s 并重新审核。", 422)
    require(font_available(font), "render_failed", "中文字体文件不可用或缺少中文字形。", 503)
    Path(destination).mkdir(parents=True, exist_ok=False)
    overlay_dir = Path(destination) / "overlays"
    overlay_dir.mkdir()
    overlays = []
    captions = ["WEBVTT", ""]
    timing = []
    for i, beat in enumerate(s["beats"]):
        start = beat["sourceStart"] - a
        end = beat["sourceEnd"] - a
        phrase = _metric_text(project, beat)
        metric = _metric_display(project, beat)
        file = overlay_dir / f"beat-{i}.png"
        _overlay_text(file, phrase, font)
        overlays.append((file, start, end))
        captions += [f"{_stamp(start)} --> {_stamp(end)}", phrase, ""]
        timing.append({"beatId": beat["id"], "compiledText": phrase, "metric": metric, "sourceStart": beat["sourceStart"], "sourceEnd": beat["sourceEnd"], "outputStart": start, "outputEnd": end, "observationIds": beat["observationIds"], "bindingIds": beat["bindingIds"]})
        if metric:
            card = overlay_dir / f"metric-{i}.png"
            _overlay_metric(card, metric, font)
            overlays.append((card, start, end))
        annotation = beat.get("annotation")
        if annotation:
            observation = next(o for o in project["observations"] if o["id"] == annotation["sourceObservationId"])
            geometry = observation["geometry"]
            # Geometry is visible only in its original, human checked source interval.
            visible_start = max(geometry["validFrom"], beat["sourceStart"])
            visible_end = min(geometry["validTo"], beat["sourceEnd"])
            if visible_end > visible_start:
                arrow = overlay_dir / f"arrow-{i}.png"
                _overlay_arrow(arrow, annotation["points"], project["media"])
                overlays.append((arrow, visible_start - a, visible_end - a))
    ai_review = (project.get("review") or {}).get("reviewerType") == "ai"
    title = "AI复核验证片" if ai_review else "人工辅助制作" if project["mode"] == "manual" else "人工复核故事"
    title_file = overlay_dir / "provenance.png"
    _overlay_text(title_file, title, font, label=True)
    overlays.append((title_file, 0, b - a))
    filter_parts = ["[0:v]fps=25,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p,setpts=PTS-STARTPTS[v0]"]
    for i, (_, start, end) in enumerate(overlays, 1):
        filter_parts.append(f"[v{i-1}][{i}:v]overlay=0:0:enable='gte(t,{start:.6f})*lt(t,{end:.6f})':eof_action=repeat[v{i}]")
    film = Path(destination) / "film.mp4"
    command = [FFMPEG, "-v", "error", "-nostdin", "-protocol_whitelist", "file", "-ss", str(a), "-i", str(source_path)]
    for file, _, _ in overlays:
        command += ["-loop", "1", "-i", str(file)]
    command += ["-t", str(b - a), "-filter_complex", ";".join(filter_parts), "-map", f"[v{len(overlays)}]"]
    if voice_mode != "silent" and project["media"]["hasAudio"]:
        command += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k"]
    else:
        command += ["-an"]
    command += ["-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(film)]
    try:
        proc = subprocess.run(command, capture_output=True, timeout=180, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise BroadcastError("render_failed", "视频编码失败或超时。", 500)
    if proc.returncode:
        raise BroadcastError("render_failed", "视频编码失败：" + proc.stderr.decode("utf-8", "replace")[-700:], 500)
    if cancel_check and cancel_check():
        raise BroadcastError("cancelled", "任务已取消。", 409)
    voice = {"mode": "silent", "provider": None, "voiceId": None, "audioSha256": None}
    voice_report = None
    if voice_mode in ("local-tts", "minimax", "stepfun", "polly"):
        from .providers.voice import synthesize
        voice_report = synthesize(film, timing, overlay_dir, b - a, mode=voice_mode, voice_id=voice_id, has_source_audio=project["media"]["hasAudio"])
        voice = {key: voice_report[key] for key in ("mode", "provider", "voiceId", "audioSha256")}
        (overlay_dir / "narration.wav").replace(Path(destination) / "narration.wav")
    if cancel_check and cancel_check():
        raise BroadcastError("cancelled", "任务已取消。", 409)
    probe = subprocess.run([FFPROBE, "-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", str(film)], capture_output=True, timeout=30)
    require(probe.returncode == 0, "render_failed", "成片无法解码探测。", 500)
    info = json.loads(probe.stdout)
    video = next((x for x in info["streams"] if x.get("codec_type") == "video"), None)
    duration = float(info["format"]["duration"])
    audio = next((x for x in info["streams"] if x.get("codec_type") == "audio"), None)
    require(video and video.get("codec_name") == "h264" and video.get("pix_fmt") == "yuv420p" and abs(duration - (b - a)) <= 1 / fps + .001 and (audio is None if voice_mode == "silent" else audio is not None and audio.get("codec_name") == "aac"), "render_failed", "成片编码、音轨或时长验证失败。", 500)
    vtt = Path(destination) / "captions.vtt"
    vtt.write_text("\n".join(captions), encoding="utf-8")
    video_hash = hashlib.sha256(film.read_bytes()).hexdigest()
    names = ("film.mp4", "captions.vtt", "narration.wav") if voice_mode != "silent" else ("film.mp4", "captions.vtt")
    outputs = [{"name": name, "bytes": (Path(destination) / name).stat().st_size, "sha256": hashlib.sha256((Path(destination) / name).read_bytes()).hexdigest()} for name in names]
    used_obs = {oid for beat in s["beats"] for oid in beat["observationIds"]}
    used_bind = {bid for beat in s["beats"] for bid in beat["bindingIds"]}
    understanding = understanding or {"mode": "manual", "providerRunIds": [], "humanReviewed": not ai_review}
    manifest = {"schema": "courtlens-broadcast-release/1", "createdAt": now(), "source": {"mediaSha256": project["media"]["sha256"], "mediaId": project["media"]["id"], "mediaUrl": project["media"]["mediaUrl"], "startPts": project["media"]["startPts"], "firstFramePts": first_frame_pts, "timeBase": project["media"]["timeBase"], **project["media"]["source"]}, "story": s, "compiledBeats": timing, "evidence": {"observations": [o for o in project["observations"] if o["id"] in used_obs], "bindings": [x for x in project["bindings"] if x["id"] in used_bind], "metrics": project["metrics"], "background": background_evidence(project, used_obs)}, "review": project["review"], "timing": {"sourceRange": s["sourceRange"], "outputDuration": duration, "fps": fps, "beats": timing, "mapping": "outputTime=sourceTime-sourceRange.start; decoded source PTS normalized from first frame"}, "outputs": outputs, "understanding": understanding, "voice": voice, "voiceReport": voice_report, "validation": {"videoCodec": "h264", "pixelFormat": "yuv420p", "durationVerified": True, "sourceHashVerified": True, "contentHash": project["review"]["contentHash"]}, "limitations": ["Review actor and reviewerType are declared in review; AI review is not human verification. Provider observations remain proposals until accepted."]}
    manifest["renderer"] = renderer_fingerprint(font)
    manifest["manifestHash"] = hash_json(manifest)
    (Path(destination) / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    shutil.rmtree(overlay_dir)
    return manifest, duration, video_hash
