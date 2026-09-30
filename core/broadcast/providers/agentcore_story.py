"""Normalize one cloud AgentCore story proposal into an unreviewed local draft."""
import hashlib
import json
import os
import re
from datetime import datetime, timezone

from ..common import BroadcastError, now, require, uid
from ..schema import validate as validate_shape
from ..validation import content_hash, story as validate_story
from .story_model import normalize_proposal


def import_proposal(service, project, expected, options):
    require(options.get("_trustedAgentCore") is True and os.environ.get("AGENT_RUNTIME_ARN"), "provider_unverified", "AgentCore 故事只能由受控云worker导入。", 403)
    require(options.get("audience") in ("fan", "pro"), "invalid_request", "故事受众无效。")
    fixed = service.store.project_dir(project["id"]) / "agentcore-story.json"
    require(fixed.is_file() and not fixed.is_symlink() and fixed.stat().st_size <= 1024 * 1024, "provider_unverified", "缺少本次 AgentCore 故事候选。", 422)
    try:
        record = json.loads(fixed.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise BroadcastError("schema_invalid", "AgentCore 故事候选文件无效。", 422)
    fields = {"rawProposal", "runtimeArn", "modelId", "requestHash", "responseHash", "inputRevision", "projectContentHash", "mediaSha256", "invokedAt"}
    require(isinstance(record, dict) and fields <= set(record) <= fields | {"usage", "requestId"}, "schema_invalid", "AgentCore 故事旁证字段无效。", 422)
    require(record["runtimeArn"] == os.environ["AGENT_RUNTIME_ARN"] and record["inputRevision"] == expected and record["projectContentHash"] == content_hash(project) and record["mediaSha256"] == project["media"]["sha256"], "revision_conflict", "故事候选与项目版本、源片或运行资源不匹配。", 409)
    raw = record["rawProposal"]
    require(isinstance(raw, str) and 0 < len(raw) <= 20000 and isinstance(record["modelId"], str) and 1 <= len(record["modelId"]) <= 160 and re.fullmatch(r"[a-f0-9]{64}", record["requestHash"]) and hashlib.sha256(raw.encode()).hexdigest() == record["responseHash"], "schema_invalid", "故事候选指纹或模型信息无效。", 422)
    try:
        invoked = datetime.fromisoformat(record["invokedAt"].replace("Z", "+00:00"))
        freshness = abs((datetime.now(timezone.utc) - invoked).total_seconds())
    except (ValueError, TypeError, AttributeError):
        freshness = float("inf")
    require(freshness <= 600, "provider_unverified", "AgentCore 故事不是本次新调用。", 422)
    candidate = normalize_proposal(project, options["audience"], raw, service._frame_times(project), options.get("commentaryStyle"), options.get("language"))
    validate_shape(candidate, "story")
    validate_story({**project, "story": candidate}, service._frame_times(project))
    audit_id = uid()
    audit = {"id": audit_id, "provider": "agentcore-runtime", "modelId": record["modelId"], "runtimeArn": record["runtimeArn"], "requestHash": record["requestHash"], "responseHash": record["responseHash"], "inputRevision": expected, "projectContentHash": record["projectContentHash"], "mediaSha256": record["mediaSha256"], "invokedAt": record["invokedAt"], "importedAt": now(), "storyHash": hashlib.sha256(json.dumps(candidate, ensure_ascii=False, sort_keys=True).encode()).hexdigest(), "usage": record.get("usage", {}), "requestId": record.get("requestId"), "proposalOnly": True}
    return candidate, audit
