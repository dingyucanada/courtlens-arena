#!/usr/bin/env python3
"""Export an offline, read-only check of an existing Broadcast project.

python tools/preflight_broadcast.py --workspace workspace --project PROJECT_ID \
    --output workspace/preflight-report.json

Reads saved source evidence, runs and release manifests. No frame extraction,
provider commands, model requests, deployment, or project writes are performed.
Unknown AWS and official-data gates remain explicitly unknown.
"""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from core.broadcast.common import BroadcastError, valid_id
from core.broadcast.media import FFMPEG, FFPROBE
from core.broadcast.render import FONT, font_available
from core.broadcast.service import BroadcastService


class OfflinePreflightService(BroadcastService):
    """Use local file availability; do not execute configured provider commands."""
    def capabilities(self):
        ffmpeg = bool(shutil.which(FFMPEG) or Path(FFMPEG).is_file())
        ffprobe = bool(shutil.which(FFPROBE) or Path(FFPROBE).is_file())
        font = font_available(FONT)
        return {"renderer":{"available":ffmpeg and ffprobe and font,
                            "ffmpeg":ffmpeg, "ffprobe":ffprobe, "font":font},
                "providers":[], "deployment":{"verified":False, "mode":"offline-local-check"}}


def run_preflight(workspace, project_id, output):
    """Call BroadcastService.preflight and exclusively create a separate report."""
    workspace, output = Path(workspace), Path(output)
    if not valid_id(project_id):
        raise ValueError("--project must be an existing Broadcast project ID.")
    if not workspace.is_dir() or not (workspace / "broadcast").is_dir():
        raise ValueError("Workspace must already contain a broadcast directory.")
    project_dir = workspace.resolve() / "broadcast" / project_id
    project_file = project_dir / "project.json"
    if project_dir.is_symlink() or project_file.is_symlink() or not project_file.is_file():
        raise ValueError("Project must already exist as a regular persisted project.")
    if output.exists() or output.is_symlink():
        raise FileExistsError("Report already exists; choose a new --output path.")
    if output.resolve().is_relative_to((workspace.resolve() / "broadcast").resolve()):
        raise ValueError("Report must be outside the broadcast project/artifact tree.")
    before = project_file.read_bytes()
    report = OfflinePreflightService(workspace).preflight(project_id)
    if project_file.read_bytes() != before:
        raise ValueError("Project changed during preflight; report was not exported.")
    report["offline"] = {"externalTransmission":False, "modelCalls":False,
                         "projectWritten":False, "inputProjectSha256":hashlib.sha256(before).hexdigest(),
                         "capabilityScope":"local renderer files only; no provider probe or voice enumeration"}
    rendered = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as target:
        target.write(rendered)
    return report


def main():
    parser = argparse.ArgumentParser(description="Read existing Broadcast evidence and export a new offline preflight report")
    parser.add_argument("--workspace", type=Path, required=True, help="Existing workspace containing broadcast/")
    parser.add_argument("--project", required=True, help="Existing project ID")
    parser.add_argument("--output", type=Path, required=True, help="New JSON report outside broadcast/")
    args = parser.parse_args()
    try:
        report = run_preflight(args.workspace, args.project, args.output)
    except (OSError, ValueError, BroadcastError) as error:
        parser.exit(2, f"Offline preflight failed: {error}\n")
    states = [(row["label"], row["status"]) for row in report["checks"]]
    print(json.dumps({"report":str(args.output.absolute()), "checks":[{"label":label, "status":status} for label,status in states],
                      "scope":report["scope"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
