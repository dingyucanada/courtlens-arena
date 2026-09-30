"""Local evidence diagnostics, not a video detector or an accuracy certificate.

``assess(project, frame_times, provider_runs=...)`` reads existing evidence only.
Persisted runs live outside project.json; callers must pass their sidecar contents.
No observation is accepted, no missing official metric is estimated, and no tool or
provider is invoked. Identity candidates require dated roster evidence, an explicit
confirmed color-group mapping, and independent readable jersey source frames.
"""
import argparse
from collections import Counter, defaultdict
import json
import math
from pathlib import Path
import re


SCHEMA = "courtlens-vision-readiness/1"
MAX_REINSPECTION_WINDOWS = 2
MAX_REINSPECTION_SECONDS = 4.0
MIN_JERSEY_SCORE = .85  # Evidence admission policy, not measured identity accuracy.


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _jersey(value):
    # 0 and 00 are different basketball jersey numbers. Never normalize to int.
    return value.strip() if isinstance(value, str) and re.fullmatch(r"[0-9]{1,2}", value.strip()) else None


def _ref(row):
    return {key: row[key] for key in ("runId", "sampleIndex", "frameId", "frameTime", "segmentId", "trackId")
            if row.get(key) is not None and (key != "frameTime" or _finite(row[key]))}


def resolve_identity(roster, readings, confirmed_team_mapping, *, game_date=None,
                     segment_id=None, track_id=None):
    """Return a review-only candidate or unknown; never mutate observations.

    Mapping: ``{colorGroup: {teamId, confirmed: True, source, validOn?}}``.
    Readings: ``{segmentId, trackId, frameId, frameTime, teamColorGroup,
    quality: 'high', jerseyText, jerseyScore}``, or replace jerseyText/jerseyScore
    with ``candidates: [{text, score}]``. Two distinct frame IDs AND PTS values
    are required. Merely repeated OCR, track IDs, and color are not identities.
    Source frames must be verified by the caller; assess does that cross-check.
    """
    result = {"status": "unknown", "reviewRequired": True, "playerId": None,
              "playerName": None, "teamId": None, "jersey": None,
              "segmentId": segment_id, "trackId": track_id,
              "reasons": [], "evidenceRefs": [], "ignoredReadingCount": 0}
    reasons = result["reasons"]
    if not segment_id or not track_id:
        reasons.append("track_and_segment_required")
        return result
    relevant = [r for r in readings if isinstance(r, dict) and r.get("trackId") == track_id]
    # Reject mixed segment input instead of accidentally pooling evidence over edits.
    if any(r.get("segmentId") != segment_id for r in relevant):
        reasons.append("cross_segment_identity_evidence")
        return result
    relevant = [r for r in relevant if r.get("segmentId") == segment_id]
    result["evidenceRefs"] = [_ref(r) for r in relevant]
    groups = {r.get("teamColorGroup") for r in relevant if r.get("teamColorGroup")}
    if len(groups) != 1:
        reasons.append("contradictory_team_evidence" if len(groups) > 1 else "team_evidence_missing")
        return result
    group = next(iter(groups))
    mapping = (confirmed_team_mapping or {}).get(group)
    if not isinstance(mapping, dict) or mapping.get("confirmed") is not True or not mapping.get("source") or not mapping.get("teamId"):
        reasons.append("team_mapping_unconfirmed")
        return result
    if mapping.get("validOn") and mapping["validOn"] != game_date:
        reasons.append("team_mapping_date_mismatch")
        return result
    if mapping.get("segmentId") and mapping["segmentId"] != segment_id:
        reasons.append("team_mapping_segment_mismatch")
        return result
    result["teamId"] = mapping["teamId"]
    eligible = []
    for row in relevant:
        if row.get("quality") != "high" or not row.get("frameId") or not _finite(row.get("frameTime")):
            result["ignoredReadingCount"] += 1
            continue
        candidates = row.get("candidates")
        if candidates is None:
            candidates = [{"text": row.get("jerseyText"), "score": row.get("jerseyScore")}]
        if not isinstance(candidates, list):
            reasons.append("ambiguous_jersey_reading")
            continue
        numbers = {_jersey(c.get("text")) for c in candidates if isinstance(c, dict)
                   and _finite(c.get("score")) and MIN_JERSEY_SCORE <= c["score"] <= 1
                   and _jersey(c.get("text")) is not None}
        if len(numbers) > 1:
            reasons.append("ambiguous_jersey_reading")
        elif len(numbers) == 1:
            eligible.append((row, next(iter(numbers))))
        else:
            result["ignoredReadingCount"] += 1
    jerseys = {number for _, number in eligible}
    if len(jerseys) > 1:
        reasons.append("contradictory_jersey_evidence")
    # One image copied with another ID, or one ID given another PTS, cannot vote twice.
    if len({r["frameId"] for r, _ in eligible}) < 2 or len({r["frameTime"] for r, _ in eligible}) < 2:
        reasons.append("insufficient_distinct_readable_frames")
    if reasons or len(jerseys) != 1:
        result["reasons"] = list(dict.fromkeys(reasons or ["jersey_evidence_missing"]))
        return result
    number = next(iter(jerseys))
    matches = [p for p in roster if isinstance(p, dict) and p.get("teamId") == result["teamId"]
               and _jersey(p.get("jersey")) == number]
    if not game_date:
        reasons.append("game_date_missing")
    elif any(p.get("validOn") != game_date or not p.get("source") for p in matches):
        reasons.append("roster_date_or_source_unverified")
    if len(matches) != 1:
        reasons.append("roster_identity_ambiguous" if len(matches) > 1 else "jersey_not_in_roster")
    elif not matches[0].get("id") or not matches[0].get("name"):
        reasons.append("roster_identity_incomplete")
    if reasons:
        return result
    player = matches[0]
    result.update(status="candidate", playerId=player["id"], playerName=player["name"], jersey=number,
                  reasons=["stable_roster_constrained_candidate_requires_review"],
                  rosterEvidence={"source": player["source"], "validOn": player["validOn"]},
                  teamMappingEvidence={"colorGroup": group, "source": mapping["source"]})
    return result


def assess(project, frame_times, *, provider_runs=(), confirmed_team_mapping=None, ocr_readings=()):
    """Produce JSON-serializable review items and at most two <=4s reinspection windows.

    frame_times accepts the service's {frameId: actualTime}, or complete frame.json
    records (preferred: verifies media hash too). Runs accept a list or ID->sidecar
    map. Reading admission requires an existing source frame within 1ms of PTS.
    No network, video upload, frame extraction, write, or review mutation occurs.
    """
    media = project.get("media") or {}
    duration = media.get("duration") if _finite(media.get("duration")) else 0
    sha = media.get("sha256")
    context = project.get("context") or {}
    roster = context.get("roster") or []
    queue, window_requests = [], []
    frames = {}
    for fid, value in (frame_times or {}).items():
        if isinstance(value, dict):
            if value.get("mediaSha256") != sha:
                continue
            value = value.get("actualTime")
        if _finite(value) and 0 <= value <= duration:
            frames[fid] = value

    def issue(code, message, action, *, observation=None, refs=(), severity="needs_review", start=None, end=None, segment=None):
        row = {"id": f"vision-{len(queue) + 1}", "code": code, "severity": severity,
               "message": message, "action": action, "observationId": (observation or {}).get("id"),
               "segmentId": segment or (observation or {}).get("segmentId"), "evidenceRefs": list(refs)}
        queue.append(row)
        if start is None and observation:
            start, end = observation.get("start"), observation.get("end")
        if _finite(start) and duration > 0:
            anchor = (observation or {}).get("anchorTime")
            center = anchor if _finite(anchor) else (start + end) / 2 if _finite(end) else start
            left, right = max(0, center - 1.0), min(duration, center + 1.0)
            if right > left:
                window_requests.append({"start": round(left, 6), "end": round(right, 6),
                                        "segmentId": row["segmentId"], "reasonCodes": [code],
                                        "reviewItemIds": [row["id"]]})

    if not sha or duration <= 0:
        issue("media_missing", "没有可校验的源视频。", "导入并校验比赛视频。", severity="blocking")
    run_list = list(provider_runs.values()) if isinstance(provider_runs, dict) else list(provider_runs)
    runs, run_summary, tracks, track_segments = {}, [], defaultdict(list), defaultdict(set)
    for run in run_list:
        if not isinstance(run, dict) or not isinstance(run.get("providerRun"), dict):
            continue  # Story/editor sidecars are not vision provider runs.
        if "mediaSha256" not in run and "observations" not in run:
            continue  # Supplemental scoreboard audit, not an observation bundle.
        provider = run["providerRun"]
        rid, mode = provider.get("id"), provider.get("mode")
        if not rid:
            continue
        valid_media = bool(sha and run.get("mediaSha256") == sha)
        audit = valid_media and mode in ("cv-executed", "image-model", "video-model") and run.get("trustedExecution") is True and all(provider.get(k) for k in ("requestHash", "responseHash"))
        runs[rid] = {"run": run, "mediaMatches": valid_media, "executionAudited": audit}
        samples = (run.get("cvEvidence") or {}).get("samples") or []
        run_summary.append({"runId": rid, "provider": provider.get("provider"), "mode": mode,
                            "mediaMatches": valid_media, "executionAudited": audit,
                            "cvSampleCount": len(samples) if valid_media else 0,
                            "unsupportedTasks": (run.get("cvEvidence") or {}).get("diagnostics", {}).get("unsupportedTasks", [])})
        if not valid_media:
            issue("provider_media_mismatch", "提供者记录属于另一源片。", "重新载入当前源片的执行记录。", refs=[{"runId": rid}], severity="blocking")
            continue
        for rejection in run.get("candidateRevisions", []):
            if not isinstance(rejection, dict):
                continue
            window = rejection.get("sourceWindow") or {}
            issue("semantic_candidate_rejected", "一条模型候选未通过身份、源帧或时间校验：" + {"illegal_player_identity":"人物不在当场名单", "invalid_frame_reference":"引用画面不匹配", "invalid_final_time":"时间不匹配", "invalid_candidate_schema":"候选内容不完整", "invalid_evidence_schema":"取证内容不完整", "evidence_clip_failed":"局部取证失败"}.get(rejection.get("reason"), str(rejection.get("reason", "内容尚未核实"))[:200]),
                  "回看引用画面后重新确认人物与动作；其他合法候选仍须逐条复核。",
                  refs=[{"runId": rid, "frameIds": rejection.get("frameIds", []), "candidateIndex": rejection.get("candidateIndex")}],
                  start=window.get("start") if isinstance(window, dict) else None,
                  end=window.get("end") if isinstance(window, dict) else None)
        if not audit:
            issue("provider_execution_unverified", "记录没有当前源片的可信执行与请求响应依据。", "核对来源；导入结果只能作为待审证据。", refs=[{"runId": rid}])
        for index, sample in enumerate(samples):
            if not isinstance(sample, dict):
                issue("cv_sample_invalid", "CV 样本不是有效记录。", "核对保存的视觉执行结果。", refs=[{"runId": rid, "sampleIndex": index}], severity="blocking")
                continue
            t, segment = sample.get("frameTime"), sample.get("segmentId")
            if not _finite(t) or not 0 <= t <= duration or not segment:
                issue("cv_sample_timing_invalid", "CV 样本时间或镜头段无效。", "核对源 PTS 和镜头分段。", refs=[{"runId": rid, "sampleIndex": index}], severity="blocking")
                continue
            for obj in sample.get("objects", []):
                if not isinstance(obj, dict):
                    continue
                if obj.get("classId") not in ("player", "person") or not obj.get("trackId"):
                    continue
                tid = obj["trackId"]
                row = dict(obj, runId=rid, sampleIndex=index, frameTime=t, segmentId=segment)
                tracks[(rid, segment, tid)].append(row)
                track_segments[(rid, tid)].add(segment)
    for (rid, tid), segments in sorted(track_segments.items()):
        if len(segments) > 1:
            issue("track_reused_across_segments", "相同轨迹编号出现在不同镜头；不能视作连续身份。", "各镜头重新检测和确认身份。", severity="blocking", refs=[{"runId": rid, "trackId": tid, "segmentIds": sorted(segments)}])
    if not any(r["executionAudited"] and r["mode"] in ("cv-executed", "image-model", "video-model") for r in run_summary):
        issue("visual_execution_missing", "没有当前源片的真实视觉执行证据。", "可先逐帧人工校订；获准后执行视觉分析。")
    identities = []
    for (rid, segment, tid), samples in sorted(tracks.items()):
        supplied = [r for r in ocr_readings if isinstance(r, dict) and r.get("trackId") == tid
                    and r.get("segmentId") == segment and r.get("runId") == rid]
        verified = [r for r in supplied if r.get("frameId") in frames and _finite(r.get("frameTime"))
                    and abs(frames[r["frameId"]] - r["frameTime"]) <= .001
                    and any(abs(s["frameTime"] - r["frameTime"]) <= .001
                            and s.get("teamColorGroup") == r.get("teamColorGroup") for s in samples)]
        # Existing RF-DETR has no OCR quality/crop evidence; it must remain unknown.
        readings = verified if supplied else samples
        candidate = resolve_identity(roster, readings, confirmed_team_mapping, game_date=context.get("gameDate"), segment_id=segment, track_id=tid)
        candidate["runId"] = rid
        if supplied and len(verified) != len(supplied):
            candidate.update(status="unknown", playerId=None, playerName=None, jersey=None)
            candidate["reasons"] = ["ocr_source_frame_missing_or_mismatched"]
        identities.append(candidate)
        if candidate["status"] == "unknown":
            issue("identity_unresolved", "球员轨迹的球队或号码证据不足。", "核对同镜头清晰号码、球队映射和当日名单。", refs=[_ref(s) for s in samples[:3]], start=samples[0]["frameTime"], end=samples[-1]["frameTime"], segment=segment)
            queue[-1]["reasonCodes"] = candidate["reasons"]
        else:
            issue("identity_candidate_review_required", "多帧号码与名单支持身份候选，仍须复核。", "对照源帧确认该轨迹；身份候选不会自动写入事件。", refs=candidate["evidenceRefs"], start=samples[0]["frameTime"], end=samples[-1]["frameTime"], segment=segment)
        if len({s["frameTime"] for s in samples}) < 2:
            issue("single_frame_track", "轨迹只有一帧；不能证明持续动作。", "短窗补取动作前后帧，遮挡后重新确认。", refs=[_ref(samples[0])], start=samples[0]["frameTime"], segment=segment)
    roster_by_id = {p.get("id"): p for p in roster if isinstance(p, dict)}
    active = [o for o in project.get("observations", []) if (o.get("review") or {}).get("status") != "rejected"]
    for obs in active:
        start, end, anchor = obs.get("start"), obs.get("end"), obs.get("anchorTime")
        refs = [{"frameId": fid, "frameTime": frames[fid]} for fid in obs.get("frameIds", []) if fid in frames]
        if not (_finite(start) and _finite(end) and 0 <= start < end <= duration):
            issue("event_timing_invalid", "事件窗口超出源视频或时间无效。", "在源视频时间线上重新定位事件。", observation=obs, severity="blocking")
            continue
        missing = [fid for fid in obs.get("frameIds", []) if fid not in frames]
        if not refs or missing:
            issue("source_frames_missing", "事件缺少当前源片的可读取帧证据。", "定位事件窗口并保存源帧，再复核动作。", observation=obs, refs=refs, severity="blocking")
        if refs and any(not start - .001 <= r["frameTime"] <= end + .001 for r in refs):
            issue("frame_outside_event", "所引用帧不在事件发生窗口。", "修正事件窗或选择对应源帧。", observation=obs, refs=refs, severity="blocking")
        if anchor is not None and (not _finite(anchor) or not start <= anchor <= end):
            issue("event_anchor_invalid", "事件锚点不在发生窗口。", "逐帧确认出手、接球或结果锚点。", observation=obs, severity="blocking")
        elif obs.get("type") in ("shot", "pass", "catch", "result"):
            if anchor is None or not refs or min(abs(r["frameTime"] - anchor) for r in refs) > .2:
                issue("event_anchor_needs_frame_review", "关键事件锚点没有近邻源帧支持。", "补取锚点前后帧；低频语义采样不证明帧准确。", observation=obs, refs=refs)
            if len({r["frameTime"] for r in refs}) < 2:
                issue("event_context_insufficient", "单帧不足以确认传接、出手或进球结果。", "复核动作前后序列；篮筐附近的球不能单独证明得分。", observation=obs, refs=refs)
        players = [roster_by_id.get(pid) for pid in obs.get("playerIds", [])]
        if obs.get("unknownActors") or (not players and obs.get("type") not in ("result", "other")):
            issue("observation_identity_unresolved", "事件参与者仍未知。", "保留持球人等中性描述，具名前核对号码与名单。", observation=obs, refs=refs)
        if any(p is None or not context.get("gameDate") or p.get("validOn") != context["gameDate"] or not p.get("source") for p in players):
            issue("observation_roster_unverified", "具名球员缺少当日名单来源。", "修正名单日期和来源；不从轨迹编号生成姓名。", observation=obs, severity="blocking", refs=refs)
        source = obs.get("source") or {}
        if source.get("kind") in ("model", "cv"):
            run = runs.get(source.get("runId"))
            if not run or not run["executionAudited"]:
                issue("observation_run_unverified", "自动观察没有对应的当前源片执行记录。", "核对源片与提供者运行记录。", observation=obs, refs=refs)
            elif source.get("kind") == "cv":
                relevant_tracks = [samples for (rid, segment, tid), samples in tracks.items()
                                   if rid == source.get("runId") and tid in obs.get("unknownActors", [])]
                segments = {s["segmentId"] for samples in relevant_tracks for s in samples
                            if start <= s["frameTime"] <= end}
                if len(segments) > 1 or (segments and obs.get("segmentId") not in segments):
                    issue("event_track_segment_conflict", "事件与轨迹的镜头段不一致。", "拆分事件，切镜后重新确认参与者。", observation=obs, refs=refs, severity="blocking")
        for identity in identities:
            if identity["status"] != "candidate" or identity["segmentId"] != obs.get("segmentId"):
                continue
            if identity["trackId"] in obs.get("unknownActors", []) and obs.get("playerIds") and identity["playerId"] not in obs["playerIds"]:
                issue("observation_identity_conflict", "事件中的具名球员与该轨迹的号码名单候选冲突。", "复核参与者分配；保留未知状态直到冲突解决。", observation=obs, refs=identity["evidenceRefs"], severity="blocking")
        if (obs.get("review") or {}).get("status") != "accepted":
            issue("observation_review_required", "候选事件尚未完成复核。", "回到源片逐项确认、修正或拒绝。", observation=obs, refs=refs)
    if not active:
        issue("events_missing", "还没有可供编排的事件观察。", "选取关键回合，先确认发生了什么。")
    # Prioritize event evidence over background track identity; merge only within
    # one segment, preserving a real bounded window rather than an entire clip.
    priority = {row["id"]: (0 if row["severity"] == "blocking" else 1 if row["observationId"] else 2) for row in queue}
    windows = []
    for requested in sorted(window_requests, key=lambda w: (priority[w["reviewItemIds"][0]], w["start"])):
        matched = next((w for w in windows if w["segmentId"] == requested["segmentId"]
                        and requested["start"] <= w["end"] and w["start"] <= requested["end"]
                        and max(w["end"], requested["end"]) - min(w["start"], requested["start"]) <= MAX_REINSPECTION_SECONDS), None)
        if matched:
            matched["start"], matched["end"] = min(matched["start"], requested["start"]), max(matched["end"], requested["end"])
            matched["reasonCodes"] = list(dict.fromkeys(matched["reasonCodes"] + requested["reasonCodes"]))
            matched["reviewItemIds"].extend(requested["reviewItemIds"])
        elif len(windows) < MAX_REINSPECTION_WINDOWS:
            windows.append(requested)
    counts = Counter(row["severity"] for row in queue)
    queue.sort(key=lambda row: (priority[row["id"]], row["id"]))
    return {"schema": SCHEMA, "projectId": project.get("id"), "revision": project.get("revision"),
            "mediaSha256": sha, "status": "blocked" if counts["blocking"] else "needs_review" if queue else "ready_for_editor_review",
            "purpose": "evidence_readiness_only", "accuracyCertified": False, "automaticAcceptance": False,
            "counts": {"sourceFrames": len(frames), "providerRuns": len(run_summary), "cvSamples": sum(r["cvSampleCount"] for r in run_summary),
                       "tracks": len(tracks), "identityCandidates": sum(i["status"] == "candidate" for i in identities),
                       "activeObservations": len(active), "blocking": counts["blocking"], "needsReview": counts["needs_review"]},
            "providerRuns": run_summary, "identityCandidates": identities, "reviewQueue": queue,
            "reinspectionWindows": windows, "reinspectionLimit": MAX_REINSPECTION_WINDOWS,
            "limits": ["Sparse CV samples do not certify continuous tracking or action accuracy.",
                       "Track association stops at cuts; color groups do not identify teams.",
                       "Review status records a review decision, not measured recognition accuracy.",
                       "Official xFG / GRAV / LVG remain absent unless separately supplied and validated."]}


def main():
    parser = argparse.ArgumentParser(description="Inspect existing local Broadcast evidence without provider calls.")
    parser.add_argument("project", type=Path, help="Persisted project.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    project = json.loads(args.project.read_text(encoding="utf-8"))
    directory = args.project.parent
    frames = {row["id"]: row for path in sorted((directory / "frames").glob("*/frame.json"))
              for row in [json.loads(path.read_text(encoding="utf-8"))]}
    runs = [json.loads(path.read_text(encoding="utf-8")) for path in sorted((directory / "runs").glob("*.json"))]
    result = assess(project, frames, provider_runs=runs)
    rendered = json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
