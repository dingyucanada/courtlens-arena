"""Local cut candidates and bounded source-PTS sampling, without semantic inference.

Candidate boundaries conservatively reset sampling identity scopes. They never
create reviewed shots, observations, or confirmed camera continuity. A missed
cut remains possible even when no candidate is reported.
"""
import bisect
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import tempfile
import time

from .media import FFMPEG, probe, run

SCHEMA = "courtlens-scene-sampling/1"
MAX_WINDOWS = 2
MAX_WINDOW_SECONDS = 4
MAX_FRAMES = 240


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def scan(video, *, threshold=.25):
    """Decode every source frame at 320px width; report FFmpeg scene candidates."""
    if not _finite(threshold) or not .01 <= threshold <= 1:
        raise ValueError("scene threshold must be .01..1; it is not a confidence probability")
    video = Path(video).resolve()
    if not video.is_file() or not 0 < video.stat().st_size <= 256 * 1024 ** 2:
        raise ValueError("a nonempty local video up to 256 MiB is required")
    started = time.monotonic()
    sha = file_hash(video)
    meta = probe(video)
    times = meta["frameTimes"]
    if meta["width"] * meta["height"] > 3840 * 2160:
        raise ValueError("local scene scan is bounded to 4K pixels")
    if not times or any(not _finite(t) for t in times) or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("strictly increasing decoded source PTS are required")
    if times[-1] >= meta["duration"]:
        raise ValueError("decoded frame PTS extend beyond the declared media duration")
    command = [FFMPEG, "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", str(video),
               "-map", "0:v:0",
               "-vf", f"scale=320:-2,select='gt(scene,{threshold})',metadata=print:file=-",
               "-an", "-f", "null", "-"]
    data = run(command, timeout=120).stdout.decode("utf-8", "replace")
    version = run([FFMPEG, "-version"], timeout=10).stdout.decode("utf-8", "replace").splitlines()[0]
    candidates = []
    for match in re.finditer(r"frame:\d+\s+pts:[-\d]+\s+pts_time:([-\d.eE+]+)\s+lavfi.scene_score=([-\d.eE+]+)", data):
        reported, score = map(float, match.groups())
        index = min(range(len(times)), key=lambda i: abs(times[i] - reported))
        if abs(times[index] - reported) > .0001 or not 0 < index < len(times) or not _finite(score):
            raise ValueError("scene metadata does not map to a decoded source frame")
        candidates.append({"id": f"cut-candidate-{index}", "frameIndex": index,
                           "sourceTime": times[index], "sourcePts": meta["framePts"][index],
                           "sceneScore": score, "reviewStatus": "unreviewed",
                           "beforeFrameIndex": index - 1, "afterFrameIndex": index})
    if file_hash(video) != sha:
        raise ValueError("source video changed during scan")
    return {"schema": SCHEMA, "mediaSha256": sha, "media": meta,
            "candidates": candidates, "scan": {"method": "ffmpeg-scene-score", "threshold": threshold,
                "scaledWidth": 320, "ffmpegVersion": version, "framesDecoded": len(times), "elapsedSeconds": round(time.monotonic() - started, 4)},
            "automaticAcceptance": False, "semanticRecognition": False,
            "limitations": ["Scene scores are visual change heuristics, not calibrated confidence.",
                "Flash, replay graphics and camera movement can produce false candidates.",
                "Similar-looking cuts and gradual transitions may be missed.",
                "No candidate does not prove camera continuity; identity still needs shot review."]}


def plan_samples(scan_result, windows, *, fps=20, max_frames=MAX_FRAMES):
    """Split <=2 event windows at candidate PTS and sample real decoded frames.

    Windows use [start,end). Missing native frames are never interpolated; rate
    is a requested rate only. No identities or geometries are carried forward.
    """
    if scan_result.get("schema") != SCHEMA:
        raise ValueError("scene sampling schema mismatch")
    if not _finite(fps) or not 1 <= fps <= 30:
        raise ValueError("requested sampling fps must be 1..30")
    if type(max_frames) is not int or not 1 <= max_frames <= MAX_FRAMES:
        raise ValueError("max_frames must be 1..240")
    if not isinstance(windows, list) or not 1 <= len(windows) <= MAX_WINDOWS:
        raise ValueError("provide one or two explicit event windows")
    meta = scan_result["media"]
    times, pts, duration = meta["frameTimes"], meta["framePts"], meta["duration"]
    if not times or len(times) != len(pts) or any(not _finite(t) for t in times) or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("sampling requires valid strictly increasing decoded PTS")
    if not _finite(duration) or duration <= times[-1] or times[0] < 0:
        raise ValueError("sampling requires bounded zero-based video time")
    cuts = sorted({c["sourceTime"] for c in scan_result["candidates"]})
    if any(not _finite(c) or c not in times or not 0 < c < duration for c in cuts):
        raise ValueError("candidate cut must be an actual source PTS within the media")
    output, unique_frames = [], set()
    for wi, window in enumerate(windows):
        if not isinstance(window, dict) or not all(_finite(window.get(k)) for k in ("start", "end")):
            raise ValueError("window start and end must be finite numbers")
        start, end = window["start"], window["end"]
        if not 0 <= start < end <= duration or end - start > MAX_WINDOW_SECONDS:
            raise ValueError("event windows must be within video and at most four seconds")
        edges = [start] + [c for c in cuts if start < c < end] + [end]
        for pi, (a, b) in enumerate(zip(edges, edges[1:])):
            lo, hi = bisect.bisect_left(times, a), bisect.bisect_left(times, b)
            rows = {}
            for step in range(math.ceil((b - a) * fps)):
                requested = a + step / fps
                if requested >= b or lo >= hi:
                    continue
                nearest = bisect.bisect_left(times, requested, lo, hi)
                choices = [i for i in (nearest - 1, nearest) if lo <= i < hi]
                index = min(choices, key=lambda i: (abs(times[i] - requested), i))
                if index not in rows:
                    rows[index] = {"frameIndex": index, "requestedTime": requested,
                                   "sourceTime": times[index], "sourcePts": pts[index],
                                   "timingErrorSeconds": abs(times[index] - requested)}
                    unique_frames.add(index)
                if len(unique_frames) > max_frames:
                    raise ValueError("sampling exceeds frame budget; reduce fps or windows")
            selected = sorted(rows.values(), key=lambda row: row["frameIndex"])
            output.append({"windowIndex": wi, "pieceIndex": pi, "start": a, "end": b,
                           "candidateSpanIndex": bisect.bisect_right(cuts, a),
                           "identityScope": f"sampling-window-{wi}-piece-{pi}",
                           "resetTrackingBefore": True, "reviewStatus": "unreviewed",
                           "continuityConfirmed": False, "frames": selected,
                           "status": "ready_for_frame_review" if selected else "no_decoded_frame_in_window",
                           "maximumSampleGapSeconds": max((v["sourceTime"] - u["sourceTime"] for u, v in zip(selected, selected[1:])), default=None)})
    return {"schema": SCHEMA, "mediaSha256": scan_result["mediaSha256"],
            "requestedFps": fps, "maxFrames": max_frames, "uniqueFrameCount": len(unique_frames),
            "windows": output, "automaticAcceptance": False, "semanticRecognition": False,
            "trackingPolicy": "new identity scope for every piece; cut candidates require review; no automatic continuity"}


def prepare(video, output, windows, *, fps=20, threshold=.25, extract=False):
    """Create an immutable local evidence folder, optionally extracting planned PNGs."""
    video, output = Path(video).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError("output must be a new directory; existing evidence is immutable")
    started = time.monotonic()
    scanned = scan(video, threshold=threshold)
    planned = plan_samples(scanned, windows, fps=fps)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".scene-sampling-", dir=output.parent))
    try:
        if extract:
            indices = sorted({row["frameIndex"] for piece in planned["windows"] for row in piece["frames"]})
            if indices:
                expr = "+".join(f"eq(n\\,{i})" for i in indices)
                run([FFMPEG, "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", str(video),
                     "-map", "0:v:0",
                     "-vf", f"select={expr},scale=1280:-2", "-vsync", "0", "-an", "-threads", "1",
                     "-start_number", "0", str(staging / "frame-%03d.png")], timeout=120)
                files = sorted(staging.glob("frame-*.png"))
                if len(files) != len(indices) or any(not p.stat().st_size for p in files):
                    raise ValueError("decoded PNG count differs from sampling plan")
                images = {index: {"image": file.name, "sha256": file_hash(file)} for index, file in zip(indices, files)}
                for piece in planned["windows"]:
                    for row in piece["frames"]:
                        row.update(images[row["frameIndex"]])
        if file_hash(video) != scanned["mediaSha256"]:
            raise ValueError("source video changed during preparation")
        (staging / "scan.json").write_text(json.dumps(scanned, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        planned["elapsedSeconds"] = round(time.monotonic() - started, 4)
        planned["framesExtracted"] = bool(extract)
        (staging / "sampling-plan.json").write_text(json.dumps(planned, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        os.rename(staging, output)
        return scanned, planned
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
