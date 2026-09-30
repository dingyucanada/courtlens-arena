#!/usr/bin/env python3
"""Offline commentary report. Never synthesize or transmit audio/text.

python tools/rehearse_broadcast.py project.json --manifest release/manifest.json
python tools/rehearse_broadcast.py project.json --output workspace/rehearsal.json
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from core.broadcast.commentary_rehearsal import analyze


def main():
    parser = argparse.ArgumentParser(description="Read-only offline commentary rehearsal")
    parser.add_argument("project", type=Path, help="Project or story JSON")
    parser.add_argument("--manifest", type=Path, help="Existing release Manifest with measured voiceReport")
    parser.add_argument("--output", type=Path, help="New report file; default prints JSON")
    args = parser.parse_args()
    try:
        project = json.loads(args.project.read_text(encoding="utf-8"))
        manifest = json.loads(args.manifest.read_text(encoding="utf-8")) if args.manifest else None
        report = analyze(project, manifest=manifest)
        result = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            # Exclusive create also prevents overwriting a reviewed project,
            # existing report, or symlink target by accident.
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as output:
                output.write(result)
        else:
            sys.stdout.write(result)
    except (OSError, ValueError) as error:
        parser.exit(2, f"Offline rehearsal failed: {error}\n")


if __name__ == "__main__":
    main()
