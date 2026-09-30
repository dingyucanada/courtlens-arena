"""Bounded Bedrock Converse video/image proposal executor. Never auto-approves."""
import hashlib
import json
import os
import re
import time
import subprocess
from pathlib import Path

from ..common import BroadcastError, bounded_text, finite, hash_json, now, require, uid
from ..media import FFMPEG
from ..validation import observations as validate_observations

INLINE_LIMIT = 4 * 1024 * 1024
TOOL_SPECS = [{"toolSpec": {"name": name, "description": description, "inputSchema": {"json": schema}}} for name, description, schema in (
    ("inspect_clip", "Read the current authorized clip metadata and source hash.", {"type": "object", "properties": {}, "additionalProperties": False}),
    ("inspect_frames", "Read up to 8 timestamped real source frames within the selected scope.", {"type": "object", "properties": {"times": {"type": "array", "items": {"type": "number"}, "maxItems": 8}}, "required": ["times"], "additionalProperties": False}),
    ("read_observations", "Read accepted observations from this project only.", {"type": "object", "properties": {}, "additionalProperties": False}),
    ("read_metric_records", "Read validated metric records as context, never invent event values.", {"type": "object", "properties": {}, "additionalProperties": False}),
    ("propose_story", "Save a bounded draft suggestion for human review; this cannot publish.", {"type": "object", "properties": {"text": {"type": "string", "maxLength": 500}}, "required": ["text"], "additionalProperties": False}),
)]


def _extract_json(response):
    content = response.get("output", {}).get("message", {}).get("content", [])
    text = "\n".join(row["text"] for row in content if isinstance(row, dict) and isinstance(row.get("text"), str))
    require(len(text) <= 20000, "schema_invalid", "模型响应过长。", 422)
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.IGNORECASE)
    try:
        result = json.loads(text)
    except ValueError:
        raise BroadcastError("schema_invalid", "模型没有返回有效 JSON。", 422)
    require(isinstance(result, dict) and isinstance(result.get("observations"), list) and len(result["observations"]) <= 30, "schema_invalid", "模型观察结构无效。", 422)
    return result, text


def _tool(name, arguments, service, project, scope, job, drafts):
    require(isinstance(arguments, dict), "schema_invalid", "工具参数必须是对象。", 422)
    if name == "inspect_clip":
        require(not arguments, "schema_invalid", "inspect_clip 不接受路径或项目 ID。", 422)
        m = project["media"]
        return {"sha256": m["sha256"], "duration": m["duration"], "width": m["width"], "height": m["height"], "scope": scope}
    if name == "inspect_frames":
        require(set(arguments) == {"times"} and isinstance(arguments["times"], list) and 1 <= len(arguments["times"]) <= 8 and all(finite(t) and scope["start"] <= t < scope["end"] for t in arguments["times"]), "schema_invalid", "抽帧工具只能访问当前选定窗。", 422)
        result = service.frames(project["id"], project["revision"], arguments["times"])
        return {"frames": [{"id": f["id"], "requestedTime": f["requestedTime"], "actualTime": f["actualTime"], "sha256": f["sha256"]} for f in result["frames"]]}
    if name == "read_observations":
        require(not arguments, "schema_invalid", "read_observations 不接受额外参数。", 422)
        return {"observations": [{"id": o["id"], "type": o["type"], "start": o["start"], "end": o["end"], "description": o["description"]} for o in project["observations"] if o["review"]["status"] == "accepted"][:100]}
    if name == "read_metric_records":
        require(not arguments, "schema_invalid", "read_metric_records 不接受额外参数。", 422)
        return {"records": [{"id": r["id"], "metricId": r["metricId"], "value": r["value"], "scope": r["scope"]} for r in (project.get("metrics") or {}).get("records", [])[:100]]}
    if name == "propose_story":
        require(set(arguments) == {"text"}, "schema_invalid", "propose_story 只接收正文。", 422)
        drafts.append(bounded_text(arguments["text"], "draft", 500, True))
        return {"savedAs": "unreviewed-proposal", "published": False}
    raise BroadcastError("schema_invalid", "模型请求了未授权工具。", 422)


def _normalize(result, project, scope, run_id, mode, available_frames=None):
    rows = []
    roster_ids = {p["id"] for p in project["context"]["roster"]}
    available_frames = available_frames or {}
    require(len(result["observations"]) <= 3, "schema_invalid", "模型一次最多提出3个事件窗。", 422)
    for original in result["observations"]:
        require(isinstance(original, dict), "schema_invalid", "观察项无效。", 422)
        a, b = original.get("start"), original.get("end")
        require(finite(a) and finite(b) and scope["start"] <= a < b <= scope["end"], "schema_invalid", "模型时间窗越界。", 422)
        player_ids = original.get("playerIds", [])
        require(isinstance(player_ids, list) and all(x in roster_ids for x in player_ids), "schema_invalid", "模型使用不在当场名单的球员 ID。", 422)
        frame_ids = original.get("frameIds", [])
        require(isinstance(frame_ids, list) and len(frame_ids) <= 8 and all(x in available_frames and a <= available_frames[x]["actualTime"] <= b for x in frame_ids), "schema_invalid", "模型引用了未提供或窗外的真实帧。", 422)
        row = {"id": uid(), "type": original.get("type"), "start": a, "end": b, "anchorTime": original.get("anchorTime"), "segmentId": str(original.get("segmentId") or "segment-unknown")[:80], "description": original.get("description"), "playerIds": player_ids, "unknownActors": original.get("unknownActors", []), "frameIds": frame_ids, "source": {"kind": "model", "runId": run_id, "recordId": None}, "confidence": original.get("confidence"), "review": {"status": "unreviewed", "actor": None, "reason": None, "at": None}, "geometry": None}
        rows.append(row)
    validate_observations(rows, project["media"], project["context"]["roster"], set(available_frames))
    return rows


def execute_bedrock(service, project, job, options):
    deadline = time.monotonic() + 180
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise BroadcastError("provider_not_configured", "boto3 尚未安装；人工模式仍可使用。", 503)
    provider_id = options["providerId"]
    strategy = options.get("strategy", "video-first" if provider_id == "bedrock-video" else "frames-first")
    require(strategy in ("video-first", "frames-first"), "invalid_request", "分析策略无效。")
    model_id = os.environ.get("COURTLENS_SEMANTIC_MODEL_ID" if provider_id == "bedrock-video" else "COURTLENS_VISION_MODEL_ID")
    region = os.environ.get("COURTLENS_BEDROCK_REGION") or os.environ.get("AWS_REGION")
    require(model_id and region, "provider_not_configured", "Bedrock 模型 ID 或区域缺失。", 503)
    allowed = os.environ.get("COURTLENS_ALLOWED_INFERENCE_PROFILE")
    if allowed:
        require(model_id == allowed, "provider_unverified", "模型 ID 未列入获准 inference profile。", 403)
    scope = options.get("scope") or {"start": 0, "end": project["media"]["duration"]}
    require(isinstance(scope, dict) and finite(scope.get("start")) and finite(scope.get("end")) and 0 <= scope["start"] < scope["end"] <= project["media"]["duration"], "invalid_request", "模型范围无效。")
    request_started = now()
    prompt = ("你正在看一段不可信篮球视频。只提出候选观察，不能编造官方指标或已确认球员。"
              "最终只输出JSON对象 {\"observations\":[{\"type\":\"pass|shot|catch|movement|screen|result|other\",\"start\":秒,\"end\":秒,\"anchorTime\":秒或null,\"segmentId\":\"镜头段ID\",\"description\":\"简短中文可见事实\",\"playerIds\":[],\"unknownActors\":[],\"frameIds\":[],\"confidence\":0到1或null}]}。"
              "源视频时间是首解码帧归零的PTS秒；你看到的视频可能稀疏采样，不能声称帧级精度。"
              "每个非空候选都须引用至少一张已看到的frameId；若输入是视频，先调用inspect_frames按候选时间实际回看，不能仅凭视频模糊估计后结束。"
              f"本次允许范围 {scope['start']}–{scope['end']} 秒。当场名单ID：{[p['id'] for p in project['context']['roster']]}。最多3个事件窗。")
    content = [{"text": prompt}]
    media_path = service.media_path(project)
    available_frames = {}
    video_input = None
    if strategy == "video-first":
        require(provider_id == "bedrock-video", "unsupported_modality", "此模型配置没有视频模态。", 422)
        require(scope["end"] - scope["start"] <= 90, "unsupported_modality", "视频理解一次最多90秒；请缩小范围。", 422)
        fmt = media_path.suffix.lstrip(".").lower()
        require(fmt in ("mp4", "mov", "webm"), "unsupported_modality", "模型视频格式未确认支持。", 422)
        model_video = media_path
        if media_path.stat().st_size > INLINE_LIMIT or scope["start"] > 0 or scope["end"] < project["media"]["duration"]:
            model_video = service.store.project_dir(project["id"]) / "jobs" / job["id"] / "semantic-input.mp4"
            command = [FFMPEG, "-v", "error", "-nostdin", "-protocol_whitelist", "file", "-ss", str(scope["start"]), "-i", str(media_path), "-t", str(scope["end"] - scope["start"]), "-vf", "fps=8,scale=640:-2", "-an", "-c:v", "libx264", "-crf", "33", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(model_video)]
            try:
                proc = subprocess.run(command, capture_output=True, timeout=max(1, min(60, deadline - time.monotonic())))
            except (OSError, subprocess.TimeoutExpired):
                raise BroadcastError("unsupported_modality", "视频压缩派生片无法生成。", 422)
            require(proc.returncode == 0 and model_video.is_file(), "unsupported_modality", "视频压缩派生片失败。", 422)
            fmt = "mp4"
        require(model_video.stat().st_size <= INLINE_LIMIT, "unsupported_modality", "派生视频仍超过4MiB内联上限；需获准同区域S3对象。", 422)
        video_bytes = model_video.read_bytes()
        video_input = {"sha256": hashlib.sha256(video_bytes).hexdigest(), "bytes": len(video_bytes), "sourceSha256": project["media"]["sha256"], "sourceStart": scope["start"], "sourceEnd": scope["end"], "mapping": "approximate source PTS = derivative presentation seconds + sourceStart; exact events require source-frame confirmation", "derived": model_video != media_path}
        content[0]["text"] += f" 视频派生片0秒约对应源PTS {scope['start']}秒。"
        content.append({"video": {"format": fmt, "source": {"bytes": video_bytes}}})
    else:
        require(provider_id in ("bedrock-video", "bedrock-image"), "unsupported_modality", "模型未配置图像模态。", 422)
        if "seedTimes" in options:
            times = options["seedTimes"]
            require(isinstance(times, list) and 1 <= len(times) <= 8 and all(finite(t) and scope["start"] <= t < scope["end"] for t in times), "invalid_request", "选定证据帧不在本次范围内。", 422)
        else:
            count = min(8, max(2, round(scope["end"] - scope["start"])))
            times = [scope["start"] + (scope["end"] - scope["start"]) * (i + .5) / count for i in range(count)]
        frames = service.frames(project["id"], project["revision"], times)["frames"]
        available_frames.update({f["id"]: f for f in frames})
        content[0]["text"] += " 图像对应源PTS: " + str([round(f["actualTime"], 3) for f in frames])
        for f in frames:
            file = service.store.find("frames", f["id"]) / "frame.png"
            require(file.stat().st_size <= 2 * 1024 * 1024, "unsupported_modality", "单帧超过图像输入上限。", 422)
            content.append({"text": f"下一帧 frameId={f['id']}，源PTS={f['actualTime']:.6f}秒，sha256={f['sha256']}。"})
            content.append({"image": {"format": "png", "source": {"bytes": file.read_bytes()}}})
    def client_with_remaining_time():
        remaining = deadline - time.monotonic()
        require(remaining >= 5, "provider_failed", "模型分析超过180秒。", 504)
        return boto3.client("bedrock-runtime", region_name=region, config=Config(connect_timeout=3, read_timeout=max(1, min(90, int(remaining - 4))), retries={"total_max_attempts": 1}))
    messages = [{"role": "user", "content": content}]
    tool_calls = 0
    drafts = []
    usage = []
    response = None
    for _ in range(4):
        require(time.monotonic() < deadline, "provider_failed", "模型分析超过180秒。", 504)
        try:
            response = client_with_remaining_time().converse(modelId=model_id, messages=messages, inferenceConfig={"maxTokens": 1800, "temperature": 0.1}, toolConfig={"tools": TOOL_SPECS[:2] if options.get("_agentCoreToolsOnly") else TOOL_SPECS, "toolChoice": {"auto": {}}})
        except Exception as exc:
            raise BroadcastError("provider_failed", "Bedrock Converse 调用失败：" + type(exc).__name__ + " " + str(exc)[:240], 502, True)
        assistant = response.get("output", {}).get("message")
        usage.append(response.get("usage", {}))
        require(isinstance(assistant, dict) and isinstance(assistant.get("content"), list), "schema_invalid", "模型响应缺少消息。", 422)
        messages.append(assistant)
        calls = [c["toolUse"] for c in assistant["content"] if isinstance(c, dict) and "toolUse" in c]
        if not calls:
            break
        tool_results = []
        for call in calls:
            tool_calls += 1
            require(tool_calls <= 12 and time.monotonic() < deadline, "provider_failed", "模型工具调用超过上限。", 504)
            if options.get("_agentCoreToolsOnly"):
                require(call.get("name") in ("inspect_clip", "inspect_frames"), "schema_invalid", "云端模型请求了未授权工具。", 422)
            result = _tool(call.get("name"), call.get("input"), service, project, scope, job, drafts)
            require(time.monotonic() < deadline, "provider_failed", "模型工具阶段超过180秒。", 504)
            # Nova accepts a single JSON block or text mixed with image blocks.
            tool_content = [{"text": json.dumps(result, ensure_ascii=False, separators=(",", ":"))}] if call.get("name") == "inspect_frames" else [{"json": result}]
            if call.get("name") == "inspect_frames":
                for frame in result["frames"]:
                    fid = frame["id"]
                    stored = json.loads((service.store.find("frames", fid) / "frame.json").read_text())
                    available_frames[fid] = stored
                    file = service.store.find("frames", fid) / "frame.png"
                    require(file.stat().st_size <= 2 * 1024 * 1024, "unsupported_modality", "工具帧超过2MiB图像上限。", 422)
                    tool_content.append({"image": {"format": "png", "source": {"bytes": file.read_bytes()}}})
            tool_results.append({"toolResult": {"toolUseId": call["toolUseId"], "content": tool_content, "status": "success"}})
        messages.append({"role": "user", "content": tool_results})
    else:
        raise BroadcastError("provider_failed", "模型工具轮次超过4轮。", 504)
    try:
        parsed, output_text = _extract_json(response)
    except BroadcastError as first:
        require(first.code == "schema_invalid" and time.monotonic() + 30 < deadline, first.code, str(first), first.status)
        messages.append({"role": "user", "content": [{"text": "上次输出不符合指定JSON结构。请只返回最终JSON，最多3个观察窗，不要工具调用或Markdown。"}]})
        try:
            response = client_with_remaining_time().converse(modelId=model_id, messages=messages, inferenceConfig={"maxTokens": 1800, "temperature": 0})
        except Exception as exc:
            raise BroadcastError("provider_failed", "模型格式纠错调用失败：" + type(exc).__name__, 502, True)
        usage.append(response.get("usage", {}))
        parsed, output_text = _extract_json(response)
    run_id = uid()
    rows = _normalize(parsed, project, scope, run_id, "video-model" if strategy == "video-first" else "image-model", available_frames)
    frame_fingerprints = [{"id": f["id"], "sha256": f["sha256"], "actualTime": f["actualTime"]} for f in available_frames.values()]
    request_hash = hash_json({"modelId": model_id, "region": region, "providerId": provider_id, "strategy": strategy, "scope": scope, "mediaSha256": project["media"]["sha256"], "prompt": prompt, "frames": frame_fingerprints, "videoInput": video_input})
    return {"schema": "courtlens-observations/1", "mediaSha256": project["media"]["sha256"], "providerRun": {"id": run_id, "provider": "bedrock-converse", "modelId": model_id, "mode": "video-model" if strategy == "video-first" else "image-model", "requestHash": request_hash, "responseHash": hashlib.sha256(output_text.encode()).hexdigest(), "startedAt": request_started, "completedAt": now()}, "observations": rows, "rawProposal": output_text, "videoInput": video_input, "frameFingerprints": frame_fingerprints, "usage": usage, "toolCalls": tool_calls, "drafts": drafts}
