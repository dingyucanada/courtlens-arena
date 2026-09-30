"""Optional Step Plan rehearsal: bounded real frames and evidence-only story drafts."""
import base64
import hashlib
import io
import json
import os
import re
import urllib.error
import urllib.request

from ..common import BroadcastError, finite, hash_json, now, require, uid
from .bedrock import _extract_json, _normalize
from .story_model import normalize_proposal

URL = "https://api.stepfun.com/step_plan/v1/chat/completions"
MAX_REQUEST = 6 * 1024 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_IMAGE = 512 * 1024
MAX_TOKENS = 6000
TIMEOUT_SECONDS = 90
REASONING_EFFORT = "low"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def model_for(kind):
    require(kind in ("vision", "story"), "provider_not_configured", "StepFun 模型用途无效。", 503)
    key = os.environ.get("COURTLENS_STEPFUN_API_KEY")
    model = os.environ.get("COURTLENS_STEPFUN_" + kind.upper() + "_MODEL", "step-3.7-flash")
    require(bool(key) and isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", model), "provider_not_configured", "StepFun API 密钥或模型未配置。", 503)
    return model


def _chat(kind, content):
    model = model_for(kind)
    payload = {"model": model, "messages": [{"role": "user", "content": content}], "max_tokens": MAX_TOKENS, "temperature": .1, "reasoning_effort": REASONING_EFFORT}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    require(len(body) <= MAX_REQUEST, "unsupported_modality", "逐帧输入超过6MiB上限。", 422)
    request = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer " + os.environ["COURTLENS_STEPFUN_API_KEY"], "Content-Type": "application/json", "Accept": "application/json"}, method="POST")
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=TIMEOUT_SECONDS) as response:
            length = response.headers.get("Content-Length")
            require(length is None or int(length) <= MAX_RESPONSE, "provider_failed", "StepFun 响应超出大小限制。", 502)
            require("json" in response.headers.get("Content-Type", "").lower(), "provider_failed", "StepFun 未返回 JSON。", 502)
            data = response.read(MAX_RESPONSE + 1)
            require(len(data) <= MAX_RESPONSE, "provider_failed", "StepFun 响应超出大小限制。", 502)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise BroadcastError("provider_failed", "StepFun 请求失败；请检查账户和网络。", 502, True)
    try:
        answer = json.loads(data)
        choice = answer["choices"][0]
        raw = choice["message"]["content"]
        if choice.get("finish_reason") != "stop" or not isinstance(raw, str) or not 0 < len(raw) <= 20000:
            reason = choice.get("finish_reason") if choice.get("finish_reason") in ("stop", "length", "content_filter", "tool_calls") else "other"
            usage = answer.get("usage") if isinstance(answer.get("usage"), dict) else {}
            token_count = next((usage.get(key) for key in ("completion_tokens", "output_tokens") if type(usage.get(key)) is int), None)
            detail = f"finishReason={reason}, contentLength={len(raw) if isinstance(raw, str) else 0}, outputTokens={token_count if token_count is not None else 'unknown'}"
            raise BroadcastError("provider_failed", "StepFun 生成未完成或返回空内容（" + detail + "）。", 502, True)
        return raw, answer.get("usage", {}), model
    except (KeyError, IndexError, TypeError, ValueError):
        raise BroadcastError("provider_failed", "StepFun 响应结构无效。", 502)


def _jpeg(path):
    try:
        from PIL import Image
        with Image.open(path) as frame:
            frame.thumbnail((960, 960))
            image = frame.convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=76, optimize=True)
            data = buffer.getvalue()
    except (ImportError, OSError, ValueError):
        raise BroadcastError("unsupported_modality", "真实证据帧无法转成模型输入。", 422)
    require(0 < len(data) <= MAX_IMAGE, "unsupported_modality", "单帧模型输入超过512KiB。", 422)
    return data


def execute_vision(service, project, job, options):
    require(options.get("providerId") == "stepfun-vision" and options.get("strategy") == "frames-first", "unsupported_modality", "StepFun 当前仅提供逐帧图像理解。", 422)
    model = model_for("vision")
    scope = options.get("scope") or {"start": 0, "end": project["media"]["duration"]}
    require(isinstance(scope, dict) and finite(scope.get("start")) and finite(scope.get("end")) and 0 <= scope["start"] < scope["end"] <= project["media"]["duration"], "invalid_request", "图像证据范围无效。", 422)
    require(scope["end"] - scope["start"] <= 48, "unsupported_modality", "StepFun 逐帧分析一次最多48秒；请显式缩小范围。", 422)
    count = min(6, max(2, round((scope["end"] - scope["start"]) / 2)))
    times = [scope["start"] + (scope["end"] - scope["start"]) * (i + .5) / count for i in range(count)]
    frames = service.frames(project["id"], project["revision"], times)["frames"]
    available = {frame["id"]: frame for frame in frames}
    prompt = ("你在看按源PTS排序的篮球素材关键帧，帧间可能发生未知动作。素材也可能只是合成圆点示意图；只有看得见人体姿势和球的动作才能说出手、接球等篮球事件。圆点移动只能写圆点位置变化，不能猜运动员、关节、球权或出手。"
              "只返回JSON对象 {\"observations\":[{\"type\":\"pass|shot|catch|movement|screen|result|other\",\"start\":秒,\"end\":秒,\"anchorTime\":秒或null,\"description\":\"可见事实\",\"frameIds\":[\"实际帧ID\"]}]}，最多2条。"
              "每条必须引用至少一张下方给定的frameId，起止时间须覆盖该帧的真实PTS且位于允许范围；anchorTime只能为所引帧的实际PTS或null。看不清就返回空数组。"
              "不要凭衣服猜具体身份、比赛结果、官方指标或战术因果。允许范围：" + json.dumps(scope, separators=(",", ":")))
    content = [{"type": "text", "text": prompt}]
    for frame in frames:
        image = _jpeg(service.store.find("frames", frame["id"]) / "frame.png")
        content.append({"type": "text", "text": f"frameId={frame['id']}，源PTS={frame['actualTime']:.6f}秒，PNG源hash={frame['sha256']}。"})
        content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")}})
    started = now()
    raw, usage, actual_model = _chat("vision", content)
    result, normalized_raw = _extract_json({"output": {"message": {"content": [{"text": raw}]}}})
    require(len(result["observations"]) <= 2, "schema_invalid", "StepFun 一次最多提出2个候选事件窗。", 422)
    run_id = uid()
    rows = _normalize(result, project, scope, run_id, "image-model", available)
    require(all(row["frameIds"] for row in rows), "schema_invalid", "逐帧模型候选必须引用实际看过的帧。", 422)
    require(all(row["anchorTime"] is None or any(abs(row["anchorTime"] - available[fid]["actualTime"]) <= .04 for fid in row["frameIds"]) for row in rows), "schema_invalid", "模型锚点必须来自所引真实证据帧。", 422)
    fingerprint = [{"id": frame["id"], "actualTime": frame["actualTime"], "sha256": frame["sha256"]} for frame in frames]
    return {"schema": "courtlens-observations/1", "mediaSha256": project["media"]["sha256"], "providerRun": {"id": run_id, "provider": "stepfun-step-plan", "modelId": actual_model, "mode": "image-model", "requestHash": hash_json({"model": model, "scope": scope, "mediaSha256": project["media"]["sha256"], "prompt": prompt, "frames": fingerprint, "maxTokens": MAX_TOKENS, "temperature": .1, "reasoningEffort": REASONING_EFFORT}), "responseHash": hashlib.sha256(normalized_raw.encode()).hexdigest(), "startedAt": started, "completedAt": now()}, "observations": rows, "rawProposal": normalized_raw, "frameFingerprints": fingerprint, "usage": usage, "strategy": "frames-first", "scope": scope, "proposalOnly": True}


def propose_story(project, audience, frame_times):
    from .story_model import story_prompt
    prompt = story_prompt(project, audience, frame_times)
    model = model_for("story")
    started = now()
    last_error = None
    for attempt in range(2):
        content = [{"type": "text", "text": prompt if attempt == 0 else prompt + "\n上一份候选未通过服务端证据校验：" + str(last_error)[:300] + "。请只返回修正的JSON。"}]
        raw, usage, actual_model = _chat("story", content)
        try:
            result = normalize_proposal(project, audience, raw, frame_times)
            audit = {"provider": "stepfun-step-plan", "modelId": actual_model, "requestHash": hash_json({"model": model, "prompt": prompt, "maxTokens": MAX_TOKENS, "temperature": .1, "reasoningEffort": REASONING_EFFORT}), "responseHash": hashlib.sha256(raw.encode()).hexdigest(), "startedAt": started, "completedAt": now(), "attempts": attempt + 1, "usage": usage, "proposalOnly": True}
            return result, audit
        except BroadcastError as exc:
            last_error = exc
    raise BroadcastError("schema_invalid", "StepFun 故事提议两次未通过证据校验：" + str(last_error)[:300], 422)
