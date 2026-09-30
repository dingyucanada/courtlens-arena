"""Bounded, local RF-DETR Nano COCO detection and ByteTrack evidence.

The default model recognizes COCO people and sports balls; the optional
community checkpoint recognizes basketball players, referees and balls.
Neither recognizes exact teams, jersey numbers, player identity, or actions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent.parent
BACKEND = os.getenv("COURTLENS_CV_BACKEND", "rfdetr")
if BACKEND not in ("rfdetr", "ssdlite", "basketball"):
    raise ValueError("COURTLENS_CV_BACKEND must be rfdetr, ssdlite, or basketball")
HF_DIR = ROOT / "workspace" / "cv-models" / "hf-basketball"
WEIGHTS = (HF_DIR / "model.safetensors") if BACKEND == "basketball" else (
    ROOT / "workspace" / "cv-models" / "models" /
    ("rf-detr-nano.pth" if BACKEND == "rfdetr" else "ssdlite320_mobilenet_v3_large_coco-a79551df.pth"))
PROVIDER = {"rfdetr": "rfdetr-nano-coco-bytetrack",
            "ssdlite": "torchvision-ssdlite-coco-bytetrack",
            "basketball": "hf-rfdetr-basketball-bytetrack"}[BACKEND]
VERSION = "1+46c3308" if BACKEND == "basketball" else "1"


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def capabilities() -> dict:
    """Offline check: never imports the model or fetches a checkpoint."""
    try:
        from importlib.metadata import version
        packages = (("rfdetr", "supervision", "opencv-python-headless") if BACKEND == "rfdetr"
                    else ("torch", "torchvision", "supervision", "opencv-python-headless") if BACKEND == "ssdlite"
                    else ("torch", "transformers", "supervision", "opencv-python-headless"))
        installed = all(version(name) for name in packages)
    except Exception:
        installed = False
    present = WEIGHTS.is_file() and WEIGHTS.stat().st_size > (10_000_000 if BACKEND == "ssdlite" else 100_000_000)
    if BACKEND == "basketball":
        present = present and (HF_DIR / "config.json").is_file() and (HF_DIR / "preprocessor_config.json").is_file()
    digest = file_hash(WEIGHTS) if present else None
    return {
        "schema": "courtlens-cv-capabilities/1",
        "providerId": PROVIDER,
        "version": VERSION,
        "available": bool(installed and present),
        "model": {"name": {"rfdetr": "RF-DETR Nano COCO (general detector)",
                           "ssdlite": "Torchvision SSDLite COCO (general detector)",
                           "basketball": "Community RF-DETR Nano basketball player/ball/referee"}[BACKEND],
                  "weightsSha256": digest, "weightsPresent": bool(present)},
        "tasks": ["detect", "track"],
        "reasonCode": None if installed and present else "weights_missing" if installed else "dependencies_missing",
    }


def _frame_times(video: Path) -> list[float]:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames",
         "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(video)],
        check=True, capture_output=True, timeout=45,
    )
    rows = json.loads(proc.stdout).get("frames", [])
    times = [float(row["best_effort_timestamp_time"]) for row in rows if "best_effort_timestamp_time" in row]
    if not times or any(not math.isfinite(x) for x in times) or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("video frame PTS unavailable or non-monotonic")
    if len(times) != len(rows):
        raise ValueError("video has frames without PTS")
    return times


def _selected(times: list[float], start: float, end: float, max_frames: int, rate: float) -> list[tuple[int, float]]:
    selected = []
    next_at = start
    for index, pts in enumerate(times):
        if pts < start - 0.000001:
            continue
        if pts > end + 0.000001:
            break
        if pts + 0.000001 >= next_at:
            selected.append((index, pts))
            next_at = pts + 1 / rate
        if len(selected) >= max_frames:
            break
    return selected


def _color_feature(frame, xyxy):
    import cv2
    import numpy as np
    x1, y1, x2, y2 = (int(v) for v in xyxy)
    width, height = x2 - x1, y2 - y1
    crop = frame[max(0, y1 + int(.22 * height)):min(frame.shape[0], y1 + int(.55 * height)),
                 max(0, x1 + int(.25 * width)):min(frame.shape[1], x2 - int(.25 * width))]
    if crop.size < 100:
        return None
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB).reshape(-1, 3)
    return np.median(lab, axis=0).astype(float)


def _color_groups(samples: list[dict], track_colors: dict[str, list]) -> dict[str, str | None]:
    import cv2
    import numpy as np
    median = {track: np.median(values, axis=0).astype(np.float32) for track, values in track_colors.items() if values}
    if len(median) < 2:
        return {track: None for track in median}
    keys = list(median)
    data = np.stack([median[key] for key in keys])
    _, labels, centers = cv2.kmeans(data, 2, None,
        (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, .2), 10, cv2.KMEANS_PP_CENTERS)
    # Lab colors too close are not evidence of distinct uniforms.
    if float(np.linalg.norm(centers[0] - centers[1])) < 24:
        return {track: None for track in median}
    order = sorted(range(2), key=lambda idx: tuple(float(v) for v in centers[idx]))
    mapping = {order[0]: "visual-color-a", order[1]: "visual-color-b"}
    groups = {track: mapping[int(label[0])] for track, label in zip(keys, labels)}
    for sample in samples:
        for obj in sample["objects"]:
            if obj["classId"] in ("person", "player"):
                obj["teamColorGroup"] = groups.get(obj["trackId"])
    return groups


def _detector():
    if BACKEND == "rfdetr":
        from rfdetr import RFDETRNano
        model = RFDETRNano(pretrain_weights=str(WEIGHTS), device="cpu")
        return lambda frame: model.predict(frame, threshold=.28)

    if BACKEND == "basketball":
        import torch
        import numpy as np
        import supervision as sv
        from transformers import AutoImageProcessor, AutoModelForObjectDetection
        processor = AutoImageProcessor.from_pretrained(str(HF_DIR), local_files_only=True, trust_remote_code=False)
        model = AutoModelForObjectDetection.from_pretrained(str(HF_DIR), local_files_only=True,
                                                            trust_remote_code=False).eval()

        def predict(frame):
            inputs = processor(images=frame, return_tensors="pt")
            with torch.inference_mode():
                output = model(**inputs)
            found = processor.post_process_object_detection(
                output, target_sizes=torch.tensor([(frame.height, frame.width)]), threshold=.28)[0]
            return sv.Detections(xyxy=found["boxes"].cpu().numpy().astype(np.float32),
                                 confidence=found["scores"].cpu().numpy().astype(np.float32),
                                 class_id=found["labels"].cpu().numpy().astype(int))

        return predict

    import torch
    import numpy as np
    import supervision as sv
    from torchvision.models.detection import ssdlite320_mobilenet_v3_large
    model = ssdlite320_mobilenet_v3_large(weights=None, weights_backbone=None)
    model.load_state_dict(torch.load(WEIGHTS, map_location="cpu", weights_only=True))
    model.eval()

    def predict(frame):
        tensor = torch.from_numpy(np.asarray(frame).copy()).permute(2, 0, 1).float().div_(255)
        with torch.inference_mode():
            output = model([tensor])[0]
        keep = output["scores"] >= .28
        return sv.Detections(xyxy=output["boxes"][keep].cpu().numpy(),
                             confidence=output["scores"][keep].cpu().numpy(),
                             class_id=output["labels"][keep].cpu().numpy())

    return predict


def run(request: dict) -> dict:
    import cv2
    import numpy as np
    import supervision as sv
    from PIL import Image

    started = time.monotonic()
    if request.get("schema") != "courtlens-cv-request/1" or request.get("outputTimeBase") != "video-pts-seconds":
        raise ValueError("unsupported CV request schema or timebase")
    source = request.get("media", {})
    video = Path(source.get("localPath", ""))
    if not video.is_file() or file_hash(video) != source.get("sha256"):
        raise ValueError("video missing or SHA-256 mismatch")
    start, end = float(request["scope"]["start"]), float(request["scope"]["end"])
    if not (0 <= start < end <= start + 90):
        raise ValueError("invalid scope")
    limits = request.get("limits", {})
    max_frames = min(int(limits.get("maxFrames", 300)),
                     max(1, int(os.getenv("COURTLENS_CV_MAX_FRAMES", "30"))), 300)
    if max_frames < 1 or float(limits.get("maxSeconds", 90)) < end - start:
        raise ValueError("request limits exceeded")
    sample_rate = min(5.0, max(0.2, float(os.getenv("COURTLENS_CV_SAMPLE_FPS", "1"))),
                      max_frames / (end - start))
    selected = _selected(_frame_times(video), start, end, max_frames, sample_rate)
    if not selected:
        raise ValueError("no decoded frames in scope")
    predict = _detector()
    tracker = sv.ByteTrack(frame_rate=sample_rate, track_activation_threshold=.3,
                           minimum_matching_threshold=.7, lost_track_buffer=3)
    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise ValueError("unable to decode video")
    samples, track_colors = [], {}
    last_hist, segment_number = None, 1
    try:
        for index, pts in selected:
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = capture.read()
            if not ok:
                raise ValueError(f"unable to decode frame {index}")
            width, height = frame.shape[1], frame.shape[0]
            thumb = cv2.resize(frame, (64, 36))
            hist = cv2.calcHist([cv2.cvtColor(thumb, cv2.COLOR_BGR2HSV)], [0, 1], None, [24, 16], [0, 180, 0, 256])
            cv2.normalize(hist, hist)
            # Reset IDs on a substantial frame-color change; false boundaries
            # shorten tracks but never carry an ID across a likely edit.
            if last_hist is not None and cv2.compareHist(last_hist, hist, cv2.HISTCMP_BHATTACHARYYA) > .27:
                segment_number += 1
                tracker = sv.ByteTrack(frame_rate=sample_rate, track_activation_threshold=.3,
                                       minimum_matching_threshold=.7, lost_track_buffer=3)
            last_hist = hist
            detections = predict(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)))
            class_ids = np.asarray(detections.class_id if detections.class_id is not None else [], dtype=int)
            # COCO uses person=1 / sports ball=37; the community basketball model
            # uses ball=0 / player=1 / referee=2.
            people = detections[class_ids == 1]
            balls = detections[class_ids == (0 if BACKEND == "basketball" else 37)]
            referees = detections[class_ids == 2] if BACKEND == "basketball" else None
            tracked = tracker.update_with_detections(people)
            objects = []
            for det_index, box in enumerate(tracked.xyxy):
                x1, y1, x2, y2 = [float(v) for v in box]
                tid = f"s{segment_number}-t{int(tracked.tracker_id[det_index])}"
                score = float(tracked.confidence[det_index])
                obj = _object(tid, "player" if BACKEND == "basketball" else "person", score, (x1, y1, x2, y2), width, height)
                if obj:
                    feature = _color_feature(frame, box)
                    if feature is not None:
                        track_colors.setdefault(tid, []).append(feature)
                    objects.append(obj)
            for ball_index, box in enumerate(balls.xyxy):
                obj = _object(f"s{segment_number}-ball-{ball_index}", "ball" if BACKEND == "basketball" else "sports-ball", float(balls.confidence[ball_index]), box, width, height)
                if obj:
                    objects.append(obj)
            if referees is not None:
                for referee_index, box in enumerate(referees.xyxy):
                    obj = _object(f"s{segment_number}-referee-{referee_index}", "referee", float(referees.confidence[referee_index]), box, width, height)
                    if obj:
                        objects.append(obj)
            samples.append({"frameTime": round(pts, 6), "segmentId": f"s{segment_number}", "objects": objects[:50]})
    finally:
        capture.release()
    groups = _color_groups(samples, track_colors)
    tracks = {}
    for sample in samples:
        for obj in sample["objects"]:
            if obj["classId"] in ("person", "player"):
                tracks.setdefault(obj["trackId"], []).append((sample["frameTime"], obj["score"]))
    events = []
    for tid, rows in sorted(tracks.items(), key=lambda item: -len(item[1]))[:30]:
        if len(rows) < 2:
            continue
        event_end = min(end, rows[-1][0] + .001)
        if event_end <= rows[0][0]:
            continue
        group = groups.get(tid)
        description = "检测到球员候选轨迹；姓名和动作待人工确认" if BACKEND == "basketball" else "检测到人物轨迹；动作和身份待人工确认"
        if group:
            description += "；视觉颜色组" + group[-1:].upper() + "（非球队身份）"
        events.append({"type": "other", "start": rows[0][0], "end": event_end,
                       "confidence": round(float(np.mean([score for _, score in rows])), 4), "trackIds": [tid],
                       "description": description})
    return {
        "schema": "courtlens-cv-result/1", "mediaSha256": source["sha256"],
        "provider": {"id": PROVIDER, "version": VERSION, "weightsSha256": file_hash(WEIGHTS)},
        "samples": samples, "events": events,
        "diagnostics": {"framesProcessed": len(samples), "elapsedMs": round((time.monotonic() - started) * 1000),
                        "modelScope": "basketball player/ball/referee community fine-tune; no player/team identity" if BACKEND == "basketball" else "COCO person and sports-ball; no basketball fine-tuning",
                        "checkpointLicenseClaim": "Apache-2.0 (community model card)" if BACKEND == "basketball" else "Apache-2.0 (Roboflow)" if BACKEND == "rfdetr" else "Torchvision BSD-3-Clause code; checkpoint terms not separately stated",
                        "trainingDataLicenseClaim": "CC BY 4.0 (Roboflow dataset v18 page)" if BACKEND == "basketball" else None,
                        "checkpointSource": "https://huggingface.co/koppolusameer/rfdetr-basketball-player-ball-referee-detection/tree/46c33088c790670a7e81e21e753fa368b2d77a70" if BACKEND == "basketball" else "https://github.com/roboflow/rf-detr" if BACKEND == "rfdetr" else "https://download.pytorch.org/models/ssdlite320_mobilenet_v3_large_coco-a79551df.pth",
                        "mediaRightsStatus": "not-evaluated-by-cv",
                        "visualColorGroups": sorted(set(group for group in groups.values() if group)),
                        "unsupportedTasks": ["jersey", "court-keypoints", "player-identity", "team-identity", "action-recognition"]},
    }


def _object(tid, class_id, score, xyxy, width, height):
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    x1, x2 = max(0, min(width, x1)), max(0, min(width, x2))
    y1, y2 = max(0, min(height, y1)), max(0, min(height, y2))
    if x2 <= x1 or y2 <= y1 or not (0 <= score <= 1):
        return None
    return {"trackId": tid, "classId": class_id, "score": round(score, 4),
            "bbox": [round(x1 / width, 6), round(y1 / height, 6), round((x2 - x1) / width, 6), round((y2 - y1) / height, 6)],
            "jerseyText": None, "jerseyScore": None, "keypoints": []}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--capabilities", action="store_true")
    parser.add_argument("--request", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.capabilities:
        print(json.dumps(capabilities()))
        return 0
    if not args.request or not args.output:
        parser.error("--request and --output are required")
    if not capabilities()["available"]:
        raise RuntimeError("RF-DETR dependencies or weights missing")
    result = run(json.loads(args.request.read_text()))
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    temporary.replace(args.output)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"RF-DETR CV failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
