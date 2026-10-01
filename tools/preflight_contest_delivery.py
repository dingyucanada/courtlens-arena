#!/usr/bin/env python3
"""Check contest evidence offline. Never deploy, probe APIs, or read credentials."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from core.broadcast.contest_delivery import inspect_delivery


def _read(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError("Input must be a regular JSON file no larger than 1 MiB")
    raw = path.read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def run_delivery(config_path, packet_path, output, *, git_commit, build_id):
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise FileExistsError("Report already exists; select a new output path")
    config, config_hash = _read(config_path)
    packet, packet_hash = _read(packet_path)
    report = inspect_delivery(config, packet, Path(packet_path).resolve().parent,
                              expected_version={"gitCommit": git_commit, "buildId": build_id})
    report["inputSha256"] = {"config": config_hash, "packet": packet_hash}
    rendered = json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as target:
        target.write(rendered)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path, help="Existing non-secret CDK deployment config JSON")
    parser.add_argument("--packet", required=True, type=Path, help="Existing evidence packet; attachment paths relative to its directory")
    parser.add_argument("--git-commit", required=True, help="Expected full Git commit; no automatic checkout/commit")
    parser.add_argument("--build-id", required=True, help="Expected delivery build ID shared by all evidence")
    parser.add_argument("--output", required=True, type=Path, help="New JSON report; existing reports never overwritten")
    args = parser.parse_args()
    try:
        report = run_delivery(args.config, args.packet, args.output, git_commit=args.git_commit, build_id=args.build_id)
    except (OSError, ValueError) as error:
        parser.exit(2, f"Offline delivery check failed: {error}\n")
    print(json.dumps({"report": str(args.output.absolute()), "checks": [{"id": r["id"], "status": r["status"]} for r in report["checks"]],
                      "formalQualificationCertified": False, "scope": report["scope"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
