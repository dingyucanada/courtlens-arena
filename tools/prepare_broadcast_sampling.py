#!/usr/bin/env python3
"""Prepare local cut candidates and high-frequency evidence; no model/API calls."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.broadcast.scene_sampling import prepare


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--windows", type=Path, required=True, help="JSON array of <=2 start/end windows, or a readiness report")
    parser.add_argument("--fps", type=float, default=20)
    parser.add_argument("--scene-threshold", type=float, default=.25)
    parser.add_argument("--extract", action="store_true", help="Extract planned source frames to PNG in one local decode")
    args = parser.parse_args()
    windows = json.loads(args.windows.read_text())
    if isinstance(windows, dict):
        windows = windows.get("reinspectionWindows")
    scanned, planned = prepare(args.video, args.output, windows, fps=args.fps, threshold=args.scene_threshold, extract=args.extract)
    print(json.dumps({"candidateCount": len(scanned["candidates"]), "pieceCount": len(planned["windows"]),
                      "frameCount": planned["uniqueFrameCount"], "elapsedSeconds": planned["elapsedSeconds"],
                      "output": str(args.output.resolve()), "semanticRecognition": False}))


if __name__ == "__main__":
    main()
