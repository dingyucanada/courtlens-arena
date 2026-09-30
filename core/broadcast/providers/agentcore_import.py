"""Normalize one real AgentCore invocation from the fixed cloud-runner handoff."""
import hashlib
import json
import os
import re
from datetime import datetime, timezone

from ..common import BroadcastError, finite, now, require, uid
from ..validation import observations as validate_observations


def execute_agentcore_proposal(service, project, job, options):
    require(options.get("_trustedAgentCore") is True and os.environ.get("AGENT_RUNTIME_ARN"), "provider_unverified", "AgentCore 导入只能由云worker触发。", 403)
    fixed = service.store.project_dir(project["id"]) / "agentcore-proposal.json"
    require(fixed.is_file() and not fixed.is_symlink() and fixed.stat().st_size <= 1024 * 1024, "provider_unverified", "缺少当前AgentCore调用结果。", 422)
    try:
        record = json.loads(fixed.read_text())
    except (OSError, ValueError):
        raise BroadcastError("schema_invalid", "AgentCore 响应文件无效。", 422)
    require(isinstance(record, dict) and record.get("mediaSha256") == project["media"]["sha256"] and record.get("inputRevision") == job["inputRevision"] and record.get("runtimeArn") == os.environ["AGENT_RUNTIME_ARN"], "media_mismatch", "AgentCore 结果不属于当前源片、版本或运行资源。", 422)
    strategy = options.get("strategy")
    require(strategy in ("video-first", "frames-first") and record.get("strategy") == strategy and record.get("mode") == ("video-model" if strategy == "video-first" else "image-model"), "schema_invalid", "AgentCore 实际模态与请求不一致。", 422)
    raw = record.get("rawProposal")
    require(isinstance(raw, str) and 0 < len(raw) <= 20000 and re.fullmatch(r"[a-f0-9]{64}", record.get("requestHash", "")) and hashlib.sha256(raw.encode()).hexdigest() == record.get("responseHash"), "schema_invalid", "AgentCore 请求或响应指纹无效。", 422)
    try:
        invoked = datetime.fromisoformat(record["invokedAt"].replace("Z", "+00:00"))
        freshness = abs((datetime.now(timezone.utc) - invoked).total_seconds())
    except (KeyError, ValueError, TypeError):
        freshness = float("inf")
    require(freshness <= 600, "provider_unverified", "AgentCore 结果不是本次新调用。", 422)
    try:
        parsed = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.IGNORECASE))
    except ValueError:
        raise BroadcastError("schema_invalid", "AgentCore 模型只返回自由文本，未形成可校验候选。", 422)
    require(isinstance(parsed, dict) and isinstance(parsed.get("observations"), list) and len(parsed["observations"]) <= 3, "schema_invalid", "AgentCore 候选必须为最多3个观察窗。", 422)
    scope = options.get("scope") or {"start": 0, "end": project["media"]["duration"]}
    require(isinstance(scope, dict) and finite(scope.get("start")) and finite(scope.get("end")) and 0 <= scope["start"] < scope["end"] <= project["media"]["duration"], "invalid_request", "AgentCore 候选范围无效。", 422)
    require(record.get("scope") == scope, "schema_invalid", "AgentCore 实际输入范围与任务范围不一致。", 422)
    video_input = record.get("videoInput")
    if strategy == "video-first":
        require(isinstance(video_input, dict) and video_input.get("sourceSha256") == project["media"]["sha256"] and video_input.get("sourceStart") == scope["start"] and video_input.get("sourceEnd") == scope["end"] and type(video_input.get("bytes")) is int and 0 < video_input["bytes"] <= 4 * 1024 * 1024, "schema_invalid", "AgentCore 视频输入缺少有界派生片证明。", 422)
    else:
        require(video_input is None, "schema_invalid", "逐帧模式不能向模型发送整片视频。", 422)
    seen_rows = record.get("frameFingerprints")
    require(isinstance(seen_rows, list) and len(seen_rows) <= 16, "schema_invalid", "AgentCore 已见帧清单无效。", 422)
    seen = {}
    for frame in seen_rows:
        require(isinstance(frame, dict) and isinstance(frame.get("id"), str) and re.fullmatch(r"[a-f0-9]{32}", frame["id"]) and isinstance(frame.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", frame["sha256"]) and finite(frame.get("actualTime")) and scope["start"] <= frame["actualTime"] <= scope["end"] and frame["id"] not in seen, "schema_invalid", "AgentCore 帧 ID、PTS 或指纹无效。", 422)
        seen[frame["id"]] = frame
    run_id = uid()
    observations = []
    frame_refs = []
    mapped = {}
    for candidate in parsed["observations"]:
        require(isinstance(candidate, dict) and candidate.get("type") in ("pass", "shot", "catch", "movement", "screen", "result", "other") and finite(candidate.get("start")) and finite(candidate.get("end")) and scope["start"] <= candidate["start"] < candidate["end"] <= scope["end"], "schema_invalid", "AgentCore 候选事件超出范围。", 422)
        anchor = candidate.get("anchorTime")
        require(anchor is None or finite(anchor) and candidate["start"] <= anchor <= candidate["end"], "schema_invalid", "AgentCore 锚点越界。", 422)
        description = candidate.get("description")
        require(isinstance(description, str) and 1 <= len(description) <= 500, "schema_invalid", "AgentCore 候选描述无效。", 422)
        requested_ids = candidate.get("frameIds")
        require(isinstance(requested_ids, list) and 1 <= len(requested_ids) <= 8 and all(isinstance(fid, str) and fid in seen for fid in requested_ids), "schema_invalid", "每条观察必须引用模型实际看过的真实帧。", 422)
        ids = []
        for fid in requested_ids:
            evidence = seen[fid]
            require(candidate["start"] <= evidence["actualTime"] <= candidate["end"], "schema_invalid", "模型引用了观察窗外的已见帧。", 422)
            if fid not in mapped:
                frame = service.frames(project["id"], project["revision"], [evidence["actualTime"]])["frames"][0]
                require(abs(frame["actualTime"] - evidence["actualTime"]) < 1e-6 and frame["sha256"] == evidence["sha256"], "media_mismatch", "云端模型所见图像与发布源片重新取证不一致。", 422)
                mapped[fid] = frame
                frame_refs.append({"id": frame["id"], "agentFrameId": fid, "sha256": frame["sha256"], "actualTime": frame["actualTime"]})
            ids.append(mapped[fid]["id"])
        observations.append({"id": uid(), "type": candidate["type"], "start": candidate["start"], "end": candidate["end"], "anchorTime": anchor, "segmentId": "segment-unverified", "description": description, "playerIds": [], "unknownActors": [], "frameIds": ids, "source": {"kind": "model", "runId": run_id, "recordId": None}, "confidence": None, "review": {"status": "unreviewed", "actor": None, "reason": None, "at": None}, "geometry": None})
    validate_observations(observations, project["media"], project["context"]["roster"], {f["id"] for f in frame_refs})
    fixed.unlink(missing_ok=True)
    return {"schema": "courtlens-observations/1", "mediaSha256": project["media"]["sha256"], "providerRun": {"id": run_id, "provider": "agentcore-runtime", "modelId": record.get("modelId"), "mode": record["mode"], "requestHash": record["requestHash"], "responseHash": record["responseHash"], "startedAt": record["invokedAt"], "completedAt": now()}, "observations": observations, "frameFingerprints": frame_refs, "videoInput": video_input, "strategy": strategy, "toolCalls": record.get("toolCalls", 0), "runtimeArn": record["runtimeArn"], "usage": record.get("usage", []), "requestId": record.get("requestId"), "proposalOnly": True}
