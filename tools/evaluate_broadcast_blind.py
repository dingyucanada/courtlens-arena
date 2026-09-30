#!/usr/bin/env python3
"""Score source-timed Broadcast proposals against independently reviewed events.

This deliberately scores structured claims only. It does not infer outcome or
tactical correctness from free-form commentary, nor score CV tracks as events.
"""
import argparse
import json
import math
import statistics
from pathlib import Path

TYPES = {"pass", "shot", "catch", "movement", "screen", "result", "other"}


def _number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _sha(value):
    return isinstance(value, str) and len(value) == 64 and all(ch in "0123456789abcdef" for ch in value.lower())


def load_inputs(gold_path, project_path):
    if Path(gold_path).stat().st_size > 2 * 1024 * 1024 or Path(project_path).stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Blind evaluation input exceeds its size limit")
    gold = json.loads(Path(gold_path).read_text(encoding="utf-8"))
    project = json.loads(Path(project_path).read_text(encoding="utf-8"))
    if gold.get("schema") != "courtlens-blind-gold/1" or project.get("schema") != "courtlens-broadcast/1":
        raise ValueError("Expected a blind-gold/1 file and a Broadcast project snapshot")
    media = project.get("media") or {}
    if not _sha(gold.get("mediaSha256")) or gold["mediaSha256"] != media.get("sha256"):
        raise ValueError("Gold labels do not belong to this exact video SHA-256")
    duration = media.get("duration")
    if not _number(duration) or duration <= 0:
        raise ValueError("Project video duration is invalid")
    events = gold.get("events")
    if not isinstance(events, list) or len(events) > 200:
        raise ValueError("Gold events must be a bounded list")
    ids = set()
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get("id"), str) or event["id"] in ids:
            raise ValueError("Gold event IDs must be unique strings")
        ids.add(event["id"])
        if event.get("type") not in TYPES or not _number(event.get("anchorTime")) or event["anchorTime"] > duration:
            raise ValueError("Gold event type or source PTS is invalid")
        if event.get("playerId") is not None and not isinstance(event["playerId"], str):
            raise ValueError("Gold primary player ID must be a string or null")
        if not isinstance(event.get("evidence"), str) or not event["evidence"].strip():
            raise ValueError("Every gold event needs an independent evidence note")
    cuts = gold.get("sceneCuts", [])
    if not isinstance(cuts, list) or any(not _number(cut) or cut >= duration for cut in cuts) or cuts != sorted(set(cuts)):
        raise ValueError("Scene cuts must be sorted, unique source PTS values")
    observations = project.get("observations")
    if not isinstance(observations, list):
        raise ValueError("Project observations are missing")
    return gold, project


def _best_pairs(gold, predictions, tolerance):
    """Chronological one-to-one matching: maximize count, then minimize error."""
    n, m = len(gold), len(predictions)
    dp = [[(0, 0.0, ()) for _ in range(m + 1)] for _ in range(n + 1)]

    def better(a, b):
        return a if (a[0], -a[1]) >= (b[0], -b[1]) else b

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best = better(dp[i - 1][j], dp[i][j - 1])
            error = abs(gold[i - 1]["anchorTime"] - predictions[j - 1]["matchTime"])
            if error <= tolerance:
                count, total, pairs = dp[i - 1][j - 1]
                best = better(best, (count + 1, total + error, pairs + ((i - 1, j - 1),)))
            dp[i][j] = best
    return dp[n][m][2]


def evaluate(gold, project, *, tolerance=1.0, source="model", min_gold=10):
    if not _number(tolerance) or tolerance == 0 or source not in ("model", "manual", "cv", "all"):
        raise ValueError("Invalid tolerance or observation source")
    events = sorted(gold["events"], key=lambda item: (item["anchorTime"], item["id"]))
    candidates = []
    for row in project["observations"]:
        if not isinstance(row, dict) or source != "all" and (row.get("source") or {}).get("kind") != source:
            continue
        start, end = row.get("start"), row.get("end")
        if not _number(start) or not _number(end) or start > end or row.get("type") not in TYPES:
            raise ValueError("Candidate has an invalid time or event type")
        anchor = row.get("anchorTime")
        if anchor is not None and (not _number(anchor) or not start <= anchor <= end):
            raise ValueError("Candidate anchor is outside its source PTS window")
        candidates.append({**row, "matchTime": anchor if anchor is not None else (start + end) / 2})
        if len(candidates) > 500:
            raise ValueError("Too many candidate observations for a blind evaluation")
    candidates.sort(key=lambda item: (item["matchTime"], item.get("id", "")))
    pairs = _best_pairs(events, candidates, tolerance)
    matched_gold = {i for i, _ in pairs}
    matched_predictions = {j for _, j in pairs}
    details = []
    errors = []
    for i, j in pairs:
        truth, candidate = events[i], candidates[j]
        error = abs(truth["anchorTime"] - candidate["matchTime"])
        errors.append(error)
        expected_player = truth.get("playerId")
        predicted_players = candidate.get("playerIds") or []
        details.append({"goldId": truth["id"], "observationId": candidate.get("id"),
                        "timeErrorSeconds": round(error, 3), "anchorMeasured": candidate.get("anchorTime") is not None,
                        "typeCorrect": truth["type"] == candidate["type"],
                        "primaryPlayer": "not_scorable" if expected_player is None else
                        "correct" if predicted_players and expected_player == predicted_players[0] else
                        "abstained" if not predicted_players else "incorrect"})
    cuts = gold.get("sceneCuts", [])
    crossed = [row.get("id") for row in candidates if any(row["start"] + .04 < cut < row["end"] - .04 for cut in cuts)]
    scorable = [row["primaryPlayer"] for row in details if row["primaryPlayer"] != "not_scorable"]
    return {"schema": "courtlens-blind-evaluation/1", "mediaSha256": gold["mediaSha256"],
            "source": source, "toleranceSeconds": tolerance, "minimumGoldEvents": min_gold,
            "goldComplete": len(events) >= min_gold,
            "counts": {"gold": len(events), "candidates": len(candidates), "matched": len(pairs),
                       "missed": len(events) - len(pairs), "unmatchedCandidates": len(candidates) - len(pairs),
                       "actionCorrect": sum(row["typeCorrect"] for row in details),
                       "identityScorable": len(scorable), "identityCorrect": scorable.count("correct"),
                       "identityAbstained": scorable.count("abstained"), "identityIncorrect": scorable.count("incorrect"),
                       "missingAnchors": sum(row.get("anchorTime") is None for row in candidates),
                       "crossCutCandidates": len(crossed)},
            "recall": round(len(pairs) / len(events), 4) if events else None,
            "precision": round(len(pairs) / len(candidates), 4) if candidates else None,
            "timeErrorSeconds": {"median": round(statistics.median(errors), 3) if errors else None,
                                 "max": round(max(errors), 3) if errors else None},
            "matched": details, "missedGoldIds": [row["id"] for i, row in enumerate(events) if i not in matched_gold],
            "unmatchedObservationIds": [row.get("id") for j, row in enumerate(candidates) if j not in matched_predictions],
            "crossCutObservationIds": crossed,
            "limits": ["Only source-time, event type, and explicit primary player IDs are scored.",
                       "Free-text outcome, team, tactical cause, and commentary quality require separate human review.",
                       "A missing model anchor uses the window midpoint for matching and is counted separately."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gold", type=Path, required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--source", choices=("model", "manual", "cv", "all"), default="model")
    parser.add_argument("--tolerance", type=float, default=1.0)
    parser.add_argument("--min-gold", type=int, default=10)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.min_gold < 1:
        parser.error("--min-gold must be positive")
    gold, project = load_inputs(args.gold, args.project)
    result = evaluate(gold, project, tolerance=args.tolerance, source=args.source, min_gold=args.min_gold)
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(encoded, encoding="utf-8")
    else:
        print(encoded, end="")
    if not result["goldComplete"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
