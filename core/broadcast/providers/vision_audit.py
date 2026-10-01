"""Private, bounded visible-response audit; never save transport or reasoning."""
import math

from ..common import now, require, valid_id


def json_safe(value):
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def visible_text(response):
    content = response.get("output", {}).get("message", {}).get("content", [])
    # Do not persist reasoningContent, signatures, transport headers or images.
    return "\n".join(row["text"] for row in content
                     if isinstance(row, dict) and isinstance(row.get("text"), str))[:20000]


def safe_usage(usage):
    return {key: value for key, value in (usage.items() if isinstance(usage, dict) else [])
            if key in ("inputTokens", "outputTokens", "totalTokens")
            and type(value) is int and value >= 0}


def save(service, project, job, filename, value):
    """Use only internal filenames. A minimal test double may lack persistence."""
    require(filename in ("bedrock-responses.json", "bedrock-validation.json"),
            "invalid_request", "视觉审计文件名无效。", 403)
    if not (hasattr(service.store, "project_dir") and hasattr(service.store, "atomic")
            and valid_id(job.get("id"))):
        return
    directory = service.store.project_dir(project["id"]) / "jobs" / job["id"]
    require(not directory.is_symlink() and not directory.parent.is_symlink(),
            "invalid_request", "模型审计目录无效。", 403)
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    service.store.atomic(directory / filename, json_safe({
        "schema": "courtlens-vision-audit/1", "projectId": project["id"],
        "jobId": job["id"], "inputRevision": project["revision"],
        "mediaSha256": project["media"]["sha256"], "recordedAt": now(), **value}))
    (directory / filename).chmod(0o600)
