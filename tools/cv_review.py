"""Render a contact sheet from executed CV evidence for human inspection."""

import argparse
import bisect
import json
from pathlib import Path
import subprocess
import tempfile

import cv2
import numpy as np

from cv_rfdetr import _frame_times, file_hash


COLORS = {"visual-color-a": (255, 120, 20), "visual-color-b": (20, 150, 255)}
CLASS_COLORS = {"player": (20, 160, 255), "person": (20, 160, 255),
                "referee": (255, 200, 40), "ball": (70, 240, 70), "sports-ball": (70, 240, 70)}


def render(video: Path, result: Path, output: Path, count: int = 6):
    data = json.loads(result.read_text())
    if file_hash(video) != data["mediaSha256"]:
        raise ValueError("CV result belongs to another video")
    samples = data["samples"]
    if not samples:
        raise ValueError("no CV samples")
    chosen = [samples[round(i * (len(samples) - 1) / max(1, count - 1))] for i in range(min(count, len(samples)))]
    times = _frame_times(video)
    capture = cv2.VideoCapture(str(video))
    tiles = []
    try:
        for sample in chosen:
            at = sample["frameTime"]
            index = max(0, bisect.bisect_left(times, at - .00001))
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, image = capture.read()
            if not ok:
                raise ValueError(f"frame {index} could not be decoded")
            h, w = image.shape[:2]
            for obj in sample["objects"]:
                x, y, bw, bh = obj["bbox"]
                x1, y1, x2, y2 = int(x * w), int(y * h), int((x + bw) * w), int((y + bh) * h)
                color = COLORS.get(obj.get("teamColorGroup"), (80, 220, 80))
                cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
                label = f'{obj["classId"]} {obj["trackId"]} {obj["score"]:.2f}'
                if obj.get("teamColorGroup"):
                    label += " " + obj["teamColorGroup"][-1:]
                cv2.putText(image, label, (x1, max(20, y1 - 5)), cv2.FONT_HERSHEY_SIMPLEX, .55, color, 2)
            cv2.putText(image, f'NBA source PTS {at:.3f}s', (15, 30), cv2.FONT_HERSHEY_SIMPLEX, .9, (255, 255, 255), 3)
            cv2.putText(image, f'NBA source PTS {at:.3f}s', (15, 30), cv2.FONT_HERSHEY_SIMPLEX, .9, (0, 0, 0), 1)
            tiles.append(cv2.resize(image, (640, 360)))
    finally:
        capture.release()
    if len(tiles) % 2:
        tiles.append(np.zeros_like(tiles[0]))
    sheet = np.vstack([np.hstack(tiles[i:i + 2]) for i in range(0, len(tiles), 2)])
    output.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output), sheet):
        raise ValueError("contact sheet could not be written")


def render_preview(video: Path, result: Path, output: Path):
    """Encode only frames on which the model actually ran; never carry boxes forward."""
    data = json.loads(result.read_text())
    if file_hash(video) != data["mediaSha256"]:
        raise ValueError("CV result belongs to another video")
    samples = data["samples"]
    if not samples:
        raise ValueError("no CV samples")
    intervals = [b["frameTime"] - a["frameTime"] for a, b in zip(samples, samples[1:])]
    frame_rate = min(5.0, max(.2, 1 / sorted(intervals)[len(intervals)//2])) if intervals else 1.0
    times = _frame_times(video)
    capture = cv2.VideoCapture(str(video))
    try:
        with tempfile.TemporaryDirectory() as temporary:
            for number, sample in enumerate(samples):
                index = max(0, bisect.bisect_left(times, sample["frameTime"] - .00001))
                capture.set(cv2.CAP_PROP_POS_FRAMES, index)
                ok, frame = capture.read()
                if not ok:
                    raise ValueError(f"frame {index} could not be decoded")
                h, w = frame.shape[:2]
                for obj in sample["objects"]:
                    x, y, bw, bh = obj["bbox"]
                    x1, y1, x2, y2 = int(x*w), int(y*h), int((x+bw)*w), int((y+bh)*h)
                    color = CLASS_COLORS.get(obj["classId"], (255, 255, 255))
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    if obj["classId"] in ("player", "person"):
                        cv2.putText(frame, obj["trackId"], (x1, max(45, y1-5)),
                                    cv2.FONT_HERSHEY_SIMPLEX, .45, color, 1, cv2.LINE_AA)
                cv2.rectangle(frame, (0, 0), (w, 38), (10, 18, 30), -1)
                cv2.putText(frame, f'NBA frame PTS {sample["frameTime"]:.3f}s | sampled evidence, no box interpolation',
                            (12, 25), cv2.FONT_HERSHEY_SIMPLEX, .63, (255, 255, 255), 1, cv2.LINE_AA)
                cv2.putText(frame, 'player candidate', (max(12, w-500), 25), cv2.FONT_HERSHEY_SIMPLEX, .5,
                            CLASS_COLORS["player"], 1, cv2.LINE_AA)
                cv2.putText(frame, 'referee', (max(12, w-325), 25), cv2.FONT_HERSHEY_SIMPLEX, .5,
                            CLASS_COLORS["referee"], 1, cv2.LINE_AA)
                cv2.putText(frame, 'ball', (max(12, w-205), 25), cv2.FONT_HERSHEY_SIMPLEX, .5,
                            CLASS_COLORS["ball"], 1, cv2.LINE_AA)
                target = Path(temporary) / f'frame-{number:04d}.png'
                if not cv2.imwrite(str(target), frame):
                    raise ValueError("preview frame could not be written")
            output.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-framerate', f'{frame_rate:.3f}',
                            '-i', str(Path(temporary) / 'frame-%04d.png'), '-c:v', 'libx264',
                            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', str(output)],
                           check=True, timeout=90)
    finally:
        capture.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--preview", action="store_true", help="encode actual sampled frames as annotated MP4")
    args = parser.parse_args()
    if args.preview:
        render_preview(args.video, args.result, args.output)
    else:
        render(args.video, args.result, args.output, args.count)
