#!/usr/bin/env python3
"""Offline raw CSV/JSON metric mapper. No network, project edits or imports."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from core.broadcast.common import BroadcastError
from core.broadcast.metric_intake import inspect_source, preview


def main():
    parser = argparse.ArgumentParser(description="Dry-run generic raw metric field mapping; not official Portal acceptance")
    parser.add_argument("source", type=Path, help="Raw CSV or JSON rows")
    parser.add_argument("--format", required=True, choices=("csv", "json"))
    parser.add_argument("--project", type=Path, help="Existing project snapshot; only read")
    parser.add_argument("--request", type=Path, help="Mapping, dictionary, granularity and timeBase JSON; source text comes from source file")
    parser.add_argument("--frames", type=Path, help="Saved source frame metadata JSON array for game-clock anchors")
    parser.add_argument("--output", type=Path, help="New preview report file; defaults to stdout")
    args = parser.parse_args()
    try:
        # Bytes -> text without universal-newline rewriting preserves source hash.
        text = args.source.read_bytes().decode("utf-8")
        if bool(args.project) != bool(args.request):
            parser.error("--project and --request must be supplied together; omit both to inspect columns")
        if args.project:
            project = json.loads(args.project.read_text(encoding="utf-8"))
            request = json.loads(args.request.read_text(encoding="utf-8"))
            if not isinstance(request, dict) or {"format", "text"} & set(request):
                raise ValueError("Request file must be an object without format/text; these come from explicit CLI input")
            request.update({"format": args.format, "text": text, "sourceName": args.source.name})
            frames = json.loads(args.frames.read_text(encoding="utf-8")) if args.frames else []
            report = preview(project, request, frames)
        else:
            report = inspect_source(args.format, text)
        result = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as output:
                output.write(result)
        else:
            sys.stdout.write(result)
        return 1 if report.get("status") == "blocked" else 0
    except (OSError, ValueError, BroadcastError) as error:
        parser.exit(2, f"Metric preparation failed: {error}\n")


if __name__ == "__main__":
    sys.exit(main())
