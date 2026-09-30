"""Execute only a server-approved CV binary, or validate a same-schema import."""
import json
import os
import subprocess
from pathlib import Path

from ..common import BroadcastError, finite, hash_json, now, require, uid
from ..validation import observations as validate_observations


def validate_result(result, project, scope):
    require(isinstance(result, dict) and result.get("schema") == "courtlens-cv-result/1" and result.get("mediaSha256") == project["media"]["sha256"], "media_mismatch", "CV 结果不属于当前视频。", 422)
    provider = result.get("provider")
    require(isinstance(provider, dict) and all(isinstance(provider.get(k), str) and provider[k] for k in ("id", "version", "weightsSha256")), "schema_invalid", "CV 提供者元数据缺失。", 422)
    samples = result.get("samples")
    events = result.get("events")
    require(isinstance(samples, list) and len(samples) <= 300 and isinstance(events, list) and len(events) <= 100, "schema_invalid", "CV 帧或事件数量超限。", 422)
    for sample in samples:
        require(isinstance(sample, dict), "schema_invalid", "CV 样本须为对象。", 422)
        t = sample.get("frameTime")
        require(finite(t) and scope["start"] <= t <= scope["end"] and isinstance(sample.get("segmentId"), str) and isinstance(sample.get("objects"), list) and len(sample["objects"]) <= 50, "schema_invalid", "CV 样本时间或物体列表无效。", 422)
        for obj in sample["objects"]:
            require(isinstance(obj, dict), "schema_invalid", "CV 物体须为对象。", 422)
            box = obj.get("bbox")
            require(isinstance(box, list) and len(box) == 4 and all(finite(v) and 0 <= v <= 1 for v in box) and box[0] + box[2] <= 1.000001 and box[1] + box[3] <= 1.000001 and finite(obj.get("score")) and 0 <= obj["score"] <= 1, "schema_invalid", "CV box 或分数无效。", 422)
            require(isinstance(obj.get("trackId"), str) and isinstance(obj.get("classId"), str), "schema_invalid", "CV trackId/classId 无效。", 422)
            if obj.get("jerseyScore") is not None:
                require(finite(obj["jerseyScore"]) and 0 <= obj["jerseyScore"] <= 1, "schema_invalid", "号码分数无效。", 422)
            require(isinstance(obj.get("keypoints"), list) and len(obj["keypoints"]) <= 100, "schema_invalid", "关键点列表无效。", 422)
    for event in events:
        require(isinstance(event, dict), "schema_invalid", "CV 事件须为对象。", 422)
        require(event.get("type") in ("pass", "shot", "catch", "movement", "screen", "result", "other") and finite(event.get("start")) and finite(event.get("end")) and scope["start"] <= event["start"] < event["end"] <= scope["end"] and finite(event.get("confidence")) and 0 <= event["confidence"] <= 1 and isinstance(event.get("trackIds"), list), "schema_invalid", "CV 事件无效。", 422)
    return True


def normalize(result, project, run_id, mode):
    rows = []
    for event in result["events"]:
        nearest = next((s for s in result["samples"] if event["start"] <= s["frameTime"] <= event["end"]), None)
        description = event.get("description")
        if not isinstance(description, str) or not description or len(description) > 160:
            description = "CV 候选" + event["type"]
        row = {"id": uid(), "type": event["type"], "start": event["start"], "end": event["end"], "anchorTime": None, "segmentId": nearest["segmentId"] if nearest else "segment-unknown", "description": description, "playerIds": [], "unknownActors": [str(x)[:80] for x in event["trackIds"][:20]], "frameIds": [], "source": {"kind": "cv", "runId": run_id, "recordId": None}, "confidence": event["confidence"], "review": {"status": "unreviewed", "actor": None, "reason": None, "at": None}, "geometry": None}
        rows.append(row)
    validate_observations(rows, project["media"], project["context"]["roster"], set())
    return rows


def execute_cv(service, project, job, options):
    command = os.environ.get("COURTLENS_CV_COMMAND")
    require(command and Path(command).is_absolute() and Path(command).is_file() and os.access(command, os.X_OK), "cv_not_installed", "已批准 CV 可执行文件不存在。", 503)
    scope = options.get("scope")
    require(isinstance(scope, dict) and finite(scope.get("start")) and finite(scope.get("end")) and 0 <= scope["start"] < scope["end"] <= project["media"]["duration"] and scope["end"] - scope["start"] <= 90, "invalid_request", "CV 范围无效。")
    directory = service.store.project_dir(project["id"]) / "jobs" / job["id"]
    request = {"schema": "courtlens-cv-request/1", "jobId": job["id"], "media": {"localPath": str(service.media_path(project)), "sha256": project["media"]["sha256"]}, "scope": scope, "outputTimeBase": "video-pts-seconds", "limits": {"maxFrames": 300, "maxSeconds": 90}, "tasks": ["detect", "track", "jersey", "court-keypoints"]}
    req_path, out_path = directory / "cv-request.json", directory / "cv-result.json"
    service.store.atomic(req_path, request)
    started_at = now()
    try:
        proc = subprocess.run([command, "--request", str(req_path), "--output", str(out_path)], capture_output=True, timeout=180)
    except (OSError, subprocess.TimeoutExpired):
        raise BroadcastError("provider_failed", "CV 执行超时或无法启动。", 502, True)
    if proc.returncode:
        raise BroadcastError("provider_failed", "CV 执行失败：" + proc.stderr.decode("utf-8", "replace")[-400:], 502, True)
    require(out_path.is_file() and out_path.stat().st_size <= 8 * 1024 * 1024, "schema_invalid", "CV 没有产出有限大小的结果。", 422)
    try:
        result = json.loads(out_path.read_text())
    except (OSError, ValueError):
        raise BroadcastError("schema_invalid", "CV 输出不是 JSON。", 422)
    validate_result(result, project, scope)
    run_id = uid()
    return {"schema": "courtlens-observations/1", "mediaSha256": project["media"]["sha256"], "providerRun": {"id": run_id, "provider": result["provider"]["id"], "modelId": result["provider"]["id"], "mode": "cv-executed", "requestHash": hash_json(request), "responseHash": hash_json(result), "startedAt": started_at, "completedAt": now()}, "observations": normalize(result, project, run_id, "cv-executed"), "cvResultHash": hash_json(result), "cvEvidence": {"provider": result["provider"], "samples": result["samples"], "diagnostics": result.get("diagnostics")}}
