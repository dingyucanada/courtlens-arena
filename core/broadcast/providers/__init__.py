"""Real provider adapters. Capability checks never invoke a paid model."""
import json
import os
import shutil
import subprocess
import hashlib
import re
from pathlib import Path

from ..common import BroadcastError, require


def _probe_file(root, name):
    path = Path(root) / (name + ".json")
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _row(id, kind, configured, available, modalities, mode, reason, message, record):
    return {"id": id, "kind": kind, "configured": configured, "available": available, "verified": bool(record and record.get("passed")), "modalities": modalities, "mode": mode, "reasonCode": reason, "message": message, "lastProbeAt": record.get("at") if record else None, "lastProbeResult": "passed" if record and record.get("passed") else "failed" if record else "never"}


def voice_fingerprint(mode):
    """Identify the approved TTS configuration without storing or hashing a secret."""
    require(mode in ("minimax", "stepfun"), "voice_unavailable", "语音配置无效。", 503)
    prefix = "COURTLENS_" + mode.upper() + "_"
    variant = os.environ.get("COURTLENS_MINIMAX_REGION", "global") if mode == "minimax" else os.environ.get("COURTLENS_STEPFUN_API_VARIANT", "openapi")
    settings = {"provider": mode, "model": os.environ.get(prefix + "MODEL"), "voiceId": os.environ.get(prefix + "VOICE_ID"), "variant": variant}
    return hashlib.sha256(json.dumps(settings, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def capabilities(root):
    rows = []
    region = os.environ.get("COURTLENS_BEDROCK_REGION") or os.environ.get("AWS_REGION")
    semantic = os.environ.get("COURTLENS_SEMANTIC_MODEL_ID")
    vision = os.environ.get("COURTLENS_VISION_MODEL_ID")
    story = os.environ.get("COURTLENS_STORY_MODEL_ID") or semantic
    try:
        import importlib.util
        sdk = importlib.util.find_spec("boto3") is not None
    except (ImportError, ValueError):
        sdk = False
    for pid, model, modal in (("bedrock-video", semantic, ["video", "image", "text"]), ("bedrock-image", vision, ["image", "text"]), ("bedrock-story", story, ["text"])):
        configured = bool(region and model)
        available = configured and sdk
        reason = None if available else "provider_not_configured" if not configured else "provider_unverified"
        message = "已配置，尚未实测。" if available else "请配置区域、模型 ID 和 boto3。"
        rows.append(_row(pid, "semantic", configured, available, modal, "bedrock-converse", reason, message, _probe_file(root, pid)))
    for pid, model_kind, modal, mode in (("stepfun-vision", "VISION", ["image", "text"], "stepfun-vision-frames"), ("stepfun-story", "STORY", ["text"], "stepfun-story-text")):
        model = os.environ.get("COURTLENS_STEPFUN_" + model_kind + "_MODEL", "step-3.7-flash")
        configured = bool(os.environ.get("COURTLENS_STEPFUN_API_KEY") and isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", model))
        record = _probe_file(root, pid)
        if record and record.get("modelId") != model:
            record = None
        rows.append(_row(pid, "semantic", configured, configured, modal, mode, None if record and record.get("passed") else "provider_unverified" if configured else "provider_not_configured", "已配置；独立探测通过。" if record and record.get("passed") else "已配置，尚未进行独立健康探测。" if configured else "请配置 StepFun 密钥与模型。", record if configured else None))
    command = os.environ.get("COURTLENS_CV_COMMAND")
    configured = bool(command)
    caps = None
    if configured and Path(command).is_absolute() and Path(command).is_file() and os.access(command, os.X_OK):
        try:
            result = subprocess.run([command, "--capabilities"], capture_output=True, timeout=3, check=True)
            caps = json.loads(result.stdout)
            if caps.get("schema") != "courtlens-cv-capabilities/1":
                caps = None
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    available = bool(caps and caps.get("available") and caps.get("model", {}).get("weightsPresent"))
    fixture = bool(caps and "fixture" in str(caps.get("providerId", "")).lower())
    rows.append(_row("cv-command", "cv", configured, available and not fixture, [], "approved-command", "provider_unverified" if fixture else None if available else "cv_not_installed" if not configured else "weights_missing", "仅协议测试夹具，不代表篮球CV模型可用。" if fixture else "CV 命令与权重已找到，尚未用本片实测。" if available else "请配置已批准 CV 可执行文件与权重。", _probe_file(root, "cv-command") if not fixture else None))
    say = shutil.which("say")
    local_voice = False
    if say:
        try:
            output = subprocess.run([say, "-v", "?"], capture_output=True, timeout=3, check=True).stdout.decode("utf-8", "replace")
            local_voice = any(line.split()[:1] == ["Tingting"] for line in output.splitlines())
        except (OSError, subprocess.SubprocessError):
            pass
    rows.append(_row("local-tts", "voice", bool(say), local_voice, ["text"], "macos-say", None if local_voice else "voice_unavailable", "婷婷中文语音可用。" if local_voice else "本机未安装婷婷中文语音。", None))
    for mode in ("minimax", "stepfun"):
        prefix = "MINIMAX" if mode == "minimax" else "STEPFUN"
        configured = all(os.environ.get("COURTLENS_" + prefix + "_" + field) for field in ("API_KEY", "MODEL", "VOICE_ID"))
        if mode == "minimax" and os.environ.get("COURTLENS_MINIMAX_REGION", "global") not in ("global", "china"):
            configured = False
        if mode == "stepfun" and os.environ.get("COURTLENS_STEPFUN_API_VARIANT", "openapi") not in ("openapi", "step-plan"):
            configured = False
        record = _probe_file(root, "voice-" + mode)
        if record and record.get("fingerprint") != voice_fingerprint(mode):
            record = None
        rows.append(_row(mode, "voice", bool(configured), bool(configured), ["text"], "https-tts", None if record and record.get("passed") else "provider_unverified" if configured else "voice_unavailable", "当前语音配置已通过真实成片。" if record and record.get("passed") else "配置完整，尚未进行独立健康探测。" if configured else "请配置语音密钥、模型、音色和允许的区域。", record if configured else None))
    rows.append(_row("polly", "voice", bool(os.environ.get("COURTLENS_POLLY_REGION")), False, ["text"], "aws-polly", "provider_unverified", "Polly 需要显式配置与实测；当前没有生产发布。", None))
    return rows


def check_configured(kind, options):
    pid = options.get("providerId")
    require(pid in ("bedrock-video", "bedrock-image", "stepfun-vision", "cv-command", "agentcore-proposal"), "provider_not_configured", "选择一个已配置的真实提供者。", 503)
    if pid == "agentcore-proposal":
        require(options.get("_trustedAgentCore") is True and bool(os.environ.get("AGENT_RUNTIME_ARN")), "provider_not_configured", "AgentCore 仅能由受控云worker导入。", 503)
        return
    if kind == "cv":
        require(pid == "cv-command" and bool(os.environ.get("COURTLENS_CV_COMMAND")), "cv_not_installed", "CV 命令未配置。", 503)
    elif pid == "stepfun-vision":
        from .stepfun import model_for
        model_for("vision")
        require(options.get("strategy") == "frames-first", "unsupported_modality", "StepFun 当前仅支持真实证据帧。", 422)
    else:
        model = os.environ.get("COURTLENS_SEMANTIC_MODEL_ID" if pid == "bedrock-video" else "COURTLENS_VISION_MODEL_ID")
        require(pid != "cv-command" and model and (os.environ.get("COURTLENS_BEDROCK_REGION") or os.environ.get("AWS_REGION")), "provider_not_configured", "Bedrock 区域或模型 ID 未配置。", 503)
        if options.get("strategy") == "video-first":
            require(pid == "bedrock-video", "unsupported_modality", "所选模型未声明视频输入能力。", 422)


def execute(service, project, job, options):
    pid = options["providerId"]
    if pid == "agentcore-proposal":
        from .agentcore_import import execute_agentcore_proposal
        return execute_agentcore_proposal(service, project, job, options)
    if pid == "cv-command":
        from .cv_command import execute_cv
        return execute_cv(service, project, job, options)
    if pid == "stepfun-vision":
        from .stepfun import execute_vision
        return execute_vision(service, project, job, options)
    from .bedrock import execute_bedrock
    return execute_bedrock(service, project, job, options)
