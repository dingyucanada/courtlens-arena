"""Explicit model input declarations and configuration-bound probe evidence.

Declarations are operator input, not evidence of AWS access or model accuracy.
No model-name guessing, credential inspection or network calls occur here.
"""
import hashlib
import json
import os
from pathlib import Path

from ..common import require

ADAPTER_VERSION = "bedrock-evidence-2"
PROVIDERS = frozenset(("bedrock-video", "bedrock-image", "bedrock-story",
                       "agentcore-proposal", "agentcore-story"))


def declared_modalities():
    values = os.environ.get("COURTLENS_BEDROCK_MODALITIES", "text").split(",")
    values = [value.strip() for value in values]
    if not values or len(set(values)) != len(values) or any(value not in ("text", "image", "video") for value in values):
        return []
    return sorted(values)


def supports(provider_id, strategy=None):
    if provider_id not in PROVIDERS:
        return False
    modes = set(declared_modalities())
    if provider_id.endswith("-story"):
        return strategy in (None, "text") and "text" in modes
    strategy = strategy or ("frames-first" if provider_id == "bedrock-image" else "video-first")
    required = {"text", "image"} if strategy == "frames-first" else {"text", "image", "video"} if strategy == "video-first" else None
    return bool(required and required <= modes and os.environ.get("COURTLENS_BEDROCK_TOOLS", "0") == "1"
                and not (provider_id == "bedrock-image" and strategy == "video-first"))


def require_access(provider_id, strategy=None):
    require(supports(provider_id, strategy), "unsupported_modality",
            "当前模型未显式声明此输入方式及所需工具能力；文本模型可用于解说写作。", 422)


def model_id(provider_id):
    if provider_id.startswith("agentcore-"):
        return os.environ.get("MODEL_ID")
    if provider_id == "bedrock-video":
        return os.environ.get("COURTLENS_SEMANTIC_MODEL_ID")
    if provider_id == "bedrock-image":
        return os.environ.get("COURTLENS_VISION_MODEL_ID")
    if provider_id == "bedrock-story":
        return os.environ.get("COURTLENS_STORY_MODEL_ID") or os.environ.get("COURTLENS_SEMANTIC_MODEL_ID")
    return None


def configuration_fingerprint(provider_id):
    require(provider_id in PROVIDERS, "invalid_request", "模型提供者无效。")
    settings = {"provider": provider_id, "model": model_id(provider_id),
                "region": os.environ.get("COURTLENS_BEDROCK_REGION") or os.environ.get("AWS_REGION"),
                "allowedProfile": os.environ.get("COURTLENS_ALLOWED_INFERENCE_PROFILE"),
                "modalities": declared_modalities(), "tools": os.environ.get("COURTLENS_BEDROCK_TOOLS", "0") == "1",
                "adapterVersion": ADAPTER_VERSION}
    return hashlib.sha256(json.dumps(settings, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def probe_filename(provider_id, strategy):
    require(provider_id in PROVIDERS and strategy in ("video-first", "frames-first", "text"),
            "invalid_request", "模型探测方式无效。")
    return provider_id + "-" + strategy + ".json"


def matching_probe(root, provider_id, strategy):
    try:
        record = json.loads((Path(root) / probe_filename(provider_id, strategy)).read_text())
    except (OSError, ValueError):
        return None
    if (not isinstance(record, dict) or record.get("fingerprint") != configuration_fingerprint(provider_id)
            or record.get("strategy") != strategy or type(record.get("passed")) is not bool
            or not model_id(provider_id) or not supports(provider_id, strategy)):
        return None
    return record
