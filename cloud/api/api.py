"""Cognito-guarded cloud adapter over the shared BroadcastService workspace."""
import base64
import hashlib
import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

from cloud.common.snapshot import Conflict, get_project, hydrate, media_object, persist, project_key
from core.broadcast.common import BroadcastError

TABLE = os.environ["TABLE_NAME"]
INPUT = os.environ["INPUT_BUCKET"]
RELEASES = os.environ["RELEASE_BUCKET"]
WORKFLOW = os.environ.get("WORKFLOW_ARN")
MAX_UPLOAD = 256 * 1024 * 1024
VOICE_PROVIDERS = frozenset(x for x in os.environ.get("VOICE_PROVIDER_IDS", "").split(",") if x in ("minimax", "stepfun", "polly"))
ID = re.compile(r"^[a-f0-9]{32}$")
DDB = boto3.client("dynamodb")
S3 = boto3.client("s3")
SFN = boto3.client("stepfunctions")


class HttpError(Exception):
    def __init__(self, code, message, status=422):
        super().__init__(message)
        self.code, self.status = code, status


def response(status, obj=None, headers=None):
    return {"statusCode": status, "headers": {"Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", **(headers or {})},
            "body": json.dumps(obj, ensure_ascii=False) if obj is not None else ""}


def error(code, message, status, job_id=None):
    return response(status, {"error": {"code": code, "message": message, "retryable": status >= 500, "fields": [], "jobId": job_id}})


def parse_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw, validate=True)
    elif isinstance(raw, str):
        raw = raw.encode()
    if len(raw) > 9 * 1024 * 1024:
        raise HttpError("upload_too_large", "API body limit exceeded; use signed upload", 413)
    return raw


def json_body(event):
    try:
        value = json.loads(parse_body(event))
    except (ValueError, TypeError):
        raise HttpError("invalid_request", "Invalid JSON", 400)
    if not isinstance(value, dict):
        raise HttpError("invalid_request", "Request body must be an object", 400)
    return value


def owner_from(event):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    owner = claims.get("sub")
    if not isinstance(owner, str) or not owner:
        raise HttpError("unauthorized", "Cognito user identity required", 401)
    return owner


def service(workspace):
    from core.broadcast.service import BroadcastService
    return BroadcastService(workspace)


def with_project(owner, project_id, fn, mutates=False):
    if not ID.fullmatch(project_id):
        raise HttpError("invalid_request", "Invalid project ID", 400)
    pointer = get_project(TABLE, owner, project_id)
    with tempfile.TemporaryDirectory(prefix="courtlens-api-") as root:
        folder = hydrate(INPUT, pointer["snapshotKey"], project_id, root)
        current = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        if current.get("id") != project_id or current.get("revision") != pointer["revision"]:
            raise Conflict("Project snapshot revision mismatch")
        result = fn(service(root), current, root)
        if mutates:
            if not isinstance(result, dict) or result.get("id") != project_id:
                raise ValueError("Project mutation did not return the current project")
            updated = json.loads((folder / "project.json").read_text(encoding="utf-8"))
            persist(INPUT, TABLE, owner, project_id, root, pointer["revision"], updated["revision"], pointer["snapshotKey"], updated["title"])
            return public_project_view(None, result, owner)
        return result


def job_key(owner, job_id):
    return {"pk": {"S": "OWNER#" + owner}, "sk": {"S": "JOB#" + job_id}}


def get_job(owner, job_id):
    if not ID.fullmatch(job_id):
        raise HttpError("invalid_request", "Invalid job ID", 400)
    row = DDB.get_item(TableName=TABLE, Key=job_key(owner, job_id), ConsistentRead=True).get("Item")
    if not row:
        raise HttpError("not_found", "Job not found", 404)
    state = row["status"]["S"]
    public_state = "running" if state in ("committing", "publishing") else state
    result = None
    if state == "succeeded" and row["jobType"]["S"] == "frames" and "framesResult" in row:
        frames = json.loads(row["framesResult"]["S"])
        project_id = row["projectId"]["S"]
        result = {"frames": [{**frame, "url": S3.generate_presigned_url(
            "get_object", Params={"Bucket": INPUT, "Key": f"projects/{project_id}/frames/{frame['id']}/frame.png"}, ExpiresIn=600)}
            for frame in frames]}
    if state == "succeeded" and row["jobType"]["S"] == "model-story" and "resultRevision" in row:
        result = {"projectId": row["projectId"]["S"], "projectRevision": int(row["resultRevision"]["N"])}
    return {"id": job_id, "projectId": row["projectId"]["S"], "inputRevision": int(row["expectedRevision"]["N"]),
            "type": row["jobType"]["S"], "status": public_state, "stage": "verify" if state in ("committing", "publishing") else state,
            "startedAt": None, "completedAt": None, "progress": None,
            "resultId": row.get("resultId", row.get("releaseId", {})).get("S"), "result": result,
            "error": ({"code": "render_failed", "message": row["errorMessage"]["S"], "retryable": False, "fields": [], "jobId": job_id} if "errorMessage" in row else None), "cacheHit": False}


def published_releases(owner, project):
    result = []
    for release in project.get("releases", []):
        rid = release.get("id")
        if not isinstance(rid, str) or not ID.fullmatch(rid):
            continue
        row = DDB.get_item(TableName=TABLE, Key={"pk": {"S": "OWNER#" + owner}, "sk": {"S": "RELEASE#" + rid}}, ConsistentRead=True).get("Item")
        if row and row.get("projectId", {}).get("S") == project["id"]:
            result.append(release)
    return result


def public_project_view(svc, project, owner):
    view = json.loads(json.dumps(project))
    if view.get("media"):
        key = media_object(INPUT, project)
        view["media"]["mediaUrl"] = S3.generate_presigned_url("get_object", Params={"Bucket": INPUT, "Key": key}, ExpiresIn=600)
    view["releases"] = published_releases(owner, view)
    for release in view["releases"]:
        release_id = release["id"]
        for field, name in (("videoUrl", "film.mp4"), ("captionsUrl", "captions.vtt"), ("manifestUrl", "manifest.json")):
            release[field] = f"/releases/{release_id}/{name}"
    return view


def cancel_job(owner, job_id):
    job = get_job(owner, job_id)
    if job["status"] in ("succeeded", "failed", "blocked", "cancelled", "needs_review"):
        return job
    if job["status"] != "running" and job["status"] != "queued":
        raise HttpError("revision_conflict", "Job is already committing its result", 409)
    key = job_key(owner, job_id)
    try:
        DDB.update_item(TableName=TABLE, Key=key, UpdateExpression="SET #status=:cancelled",
                        ConditionExpression="#status IN (:queued,:running)", ExpressionAttributeNames={"#status": "status"},
                        ExpressionAttributeValues={":cancelled": {"S": "cancelled"}, ":queued": {"S": "queued"}, ":running": {"S": "running"}})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HttpError("revision_conflict", "Job changed while cancelling", 409) from exc
        raise
    row = DDB.get_item(TableName=TABLE, Key=key, ConsistentRead=True)["Item"]
    if "executionArn" in row:
        try:
            SFN.stop_execution(executionArn=row["executionArn"]["S"], cause="Cancelled by editor")
        except Exception as exc:
            # DynamoDB cancellation is authoritative; the worker checks status before commit.
            print(json.dumps({"event": "stop_execution_failed_after_cancel", "jobId": job_id, "type": type(exc).__name__}))
    kind = row["jobType"]["S"]
    lock = "render" if kind == "render" else "analyze" if kind in ("analyze", "probe-provider", "cv", "frames", "model-story") else "ingest"
    try:
        DDB.delete_item(TableName=TABLE, Key={"pk": {"S": "SYSTEM"}, "sk": {"S": "LOCK#" + lock}},
                        ConditionExpression="jobId=:job", ExpressionAttributeValues={":job": {"S": job_id}})
    except DDB.exceptions.ConditionalCheckFailedException:
        pass
    return get_job(owner, job_id)


def start_job(owner, project_id, expected, kind, options, idem):
    if not isinstance(project_id, str) or not ID.fullmatch(project_id) or type(expected) is not int:
        raise HttpError("invalid_request", "projectId and expectedRevision required", 400)
    if not isinstance(idem, str) or not re.fullmatch(r"[A-Za-z0-9._-]{8,80}", idem):
        raise HttpError("invalid_request", "Idempotency-Key must be 8–80 safe characters", 400)
    canonical = json.dumps({"projectId": project_id, "expectedRevision": expected, "kind": kind, "options": options}, sort_keys=True, separators=(",", ":"))
    request_hash = hashlib.sha256(canonical.encode()).hexdigest()
    idem_key = {"pk": {"S": "OWNER#" + owner}, "sk": {"S": "IDEMP#" + idem}}
    existing = DDB.get_item(TableName=TABLE, Key=idem_key, ConsistentRead=True).get("Item")
    if existing:
        if existing["requestHash"]["S"] != request_hash:
            raise HttpError("revision_conflict", "Idempotency-Key reused for another request", 409)
        return get_job(owner, existing["jobId"]["S"])
    pointer = get_project(TABLE, owner, project_id)
    if pointer["revision"] != expected:
        raise HttpError("revision_conflict", "Project revision changed", 409)
    control = DDB.get_item(TableName=TABLE, Key={"pk": {"S": "SYSTEM"}, "sk": {"S": "CONTROL#jobs"}}, ConsistentRead=True).get("Item")
    if control and control.get("paused", {}).get("BOOL") is True:
        raise HttpError("jobs_paused", "New cloud jobs are paused by the operator", 503)
    lock_class = "render" if kind == "render" else "analyze" if kind in ("analyze", "cv", "probe-provider", "frames", "model-story") else "ingest"
    job_id = uuid.uuid4().hex
    now = int(time.time())
    row = {**job_key(owner, job_id), "jobId": {"S": job_id}, "projectId": {"S": project_id},
           "expectedRevision": {"N": str(expected)}, "jobType": {"S": kind}, "options": {"S": json.dumps(options, separators=(",", ":"))}, "status": {"S": "queued"}}
    lock_key = {"pk": {"S": "SYSTEM"}, "sk": {"S": "LOCK#" + lock_class}}
    try:
        DDB.transact_write_items(TransactItems=[
            {"Put": {"TableName": TABLE, "Item": row, "ConditionExpression": "attribute_not_exists(pk)"}},
            {"Put": {"TableName": TABLE, "Item": {**lock_key, "jobId": {"S": job_id}, "expiresAt": {"N": str(now + 1300)}},
                     "ConditionExpression": "attribute_not_exists(pk) OR expiresAt < :now", "ExpressionAttributeValues": {":now": {"N": str(now)}}}},
            {"Put": {"TableName": TABLE, "Item": {**idem_key, "jobId": {"S": job_id}, "requestHash": {"S": request_hash}}, "ConditionExpression": "attribute_not_exists(pk)"}},
        ])
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            raise HttpError("capacity_busy", "Another job is running; retry after it completes", 429) from exc
        raise
    try:
        started = SFN.start_execution(stateMachineArn=WORKFLOW, name=job_id, input=json.dumps({"jobId": job_id, "ownerId": owner}))
        DDB.update_item(TableName=TABLE, Key=job_key(owner, job_id), UpdateExpression="SET executionArn=:arn", ExpressionAttributeValues={":arn": {"S": started["executionArn"]}})
    except Exception:
        DDB.update_item(TableName=TABLE, Key=job_key(owner, job_id), UpdateExpression="SET #status=:failed", ExpressionAttributeNames={"#status": "status"}, ExpressionAttributeValues={":failed": {"S": "failed"}})
        DDB.delete_item(TableName=TABLE, Key=lock_key, ConditionExpression="jobId=:id", ExpressionAttributeValues={":id": {"S": job_id}})
        raise
    return get_job(owner, job_id)


def signed_upload(owner, project_id, body):
    expected = body.get("expectedRevision")
    pointer = get_project(TABLE, owner, project_id)
    if type(expected) is not int or pointer["revision"] != expected:
        raise HttpError("revision_conflict", "Project revision changed", 409)
    size, sha, mime = body.get("bytes"), body.get("sha256"), body.get("contentType")
    extensions = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv"}
    if type(size) is not int or not 0 < size <= MAX_UPLOAD or not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{64}", sha) or mime not in extensions:
        raise HttpError("invalid_request", "Upload bytes, SHA-256 or media type invalid", 422)
    key = f"projects/{project_id}/staging/{uuid.uuid4().hex}.{extensions[mime]}"
    url = S3.generate_presigned_url("put_object", Params={"Bucket": INPUT, "Key": key, "ContentType": mime, "Metadata": {"sha256": sha}}, ExpiresIn=600)
    return {"uploadUrl": url, "uploadKey": key, "requiredHeaders": {"Content-Type": mime, "x-amz-meta-sha256": sha}, "expiresInSeconds": 600}


def handler(event, context):
    try:
        owner = owner_from(event)
        method = event.get("httpMethod", "")
        path = event.get("path", "")
        prefix = "/api/broadcast/v1"
        if not path.startswith(prefix):
            raise HttpError("not_found", "Unknown API path", 404)
        route = path[len(prefix):] or "/"
        parts = [x for x in route.split("/") if x]
        if any(x in (".", "..") or "%" in x for x in parts):
            raise HttpError("invalid_request", "Invalid path", 400)
        if method == "GET" and parts == ["capabilities"]:
            from core.broadcast.commentary_style import capability_styles, capability_options
            def agent_capability(pid, modalities):
                return {"id": pid, "kind": "semantic", "configured": True, "available": True, "verified": False,
                        "modalities": modalities, "mode": "agentcore-runtime", "reasonCode": "provider_unverified",
                        "message": "AgentCore runtime 已配置；当前媒体与模型尚需真实运行验证。", "lastProbeAt": None, "lastProbeResult": "never"}
            def voice_capability(pid):
                configured = pid in VOICE_PROVIDERS
                return {"id": pid, "kind": "voice", "configured": configured, "available": configured, "verified": False,
                        "modalities": ["text"], "mode": "aws-polly" if pid == "polly" else "https-tts", "reasonCode": "provider_unverified" if configured else "voice_unavailable",
                        "message": "已配置但尚未实测语音供应商。" if configured else "此部署未配置该语音供应商。",
                        "lastProbeAt": None, "lastProbeResult": "never"}
            return response(200, {"data": {"schema": "courtlens-broadcast-capabilities/1",
                "renderer": {"available": True, "ffmpeg": True, "ffprobe": True, "node": True, "font": True},
                "providers": [agent_capability("agentcore-proposal", ["video", "image", "text"]), agent_capability("agentcore-story", ["text"]), voice_capability("minimax"), voice_capability("stepfun"), voice_capability("polly")], "commentaryStyles": capability_styles(cloud_modes=VOICE_PROVIDERS), **capability_options(cloud_modes=VOICE_PROVIDERS),
                "upload": {"mode": "signed-async", "maxBytes": MAX_UPLOAD},
                "deployment": {"mode": "aws", "agentService": "bedrock-agentcore-candidate", "region": os.environ.get("AWS_REGION"), "verified": False}}})
        if method == "GET" and parts == ["tactics"]:
            from core.broadcast.tactics import retrieve
            query = event.get("queryStringParameters") or {}
            if not isinstance(query, dict) or set(query) not in ({"projectId", "at"}, {"projectId", "at", "q"}):
                raise HttpError("invalid_request", "Tactic lookup requires a project and source time", 422)
            pid = query["projectId"]
            if not isinstance(pid, str) or not ID.fullmatch(pid):
                raise HttpError("invalid_request", "Invalid project ID", 422)
            try:
                at = float(query["at"])
            except (TypeError, ValueError):
                raise HttpError("invalid_request", "Invalid source time", 422)
            return response(200, {"data": with_project(owner, pid, lambda svc, current, root:
                retrieve(current, svc._frame_times(current), at, query.get("q", "")))})
        if method == "POST" and parts == ["projects"]:
            body = json_body(event)
            with tempfile.TemporaryDirectory(prefix="courtlens-create-") as root:
                project = service(root).create(body.get("title"), body.get("mode"))
                persist(INPUT, TABLE, owner, project["id"], root, 0, project["revision"], None, project["title"])
            return response(201, {"data": project})
        if method == "GET" and parts == ["projects"]:
            rows = DDB.query(TableName=TABLE, KeyConditionExpression="pk=:owner AND begins_with(sk,:project)",
                             ExpressionAttributeValues={":owner": {"S": "OWNER#" + owner}, ":project": {"S": "PROJECT#"}}, Limit=50)["Items"]
            summaries = []
            for row in rows:
                pid = row["sk"]["S"][len("PROJECT#"):]
                def summary(svc, current, root):
                    visible = published_releases(owner, current)
                    return {"id": pid, "title": current["title"], "revision": current["revision"], "updatedAt": current["updatedAt"], "hasMedia": current["media"] is not None, "latestReleaseId": visible[-1]["id"] if visible else None}
                summaries.append(with_project(owner, pid, summary))
            return response(200, {"data": {"projects": summaries}})
        if len(parts) >= 2 and parts[0] == "projects" and ID.fullmatch(parts[1]):
            pid = parts[1]
            if method == "GET" and parts[2:] == ["preflight"]:
                def preflight(svc, current, root):
                    report = svc.preflight(pid)
                    for check in report["checks"]:
                        if check["id"] == "renderer":
                            check.update(status="unknown", detail="媒体任务运行于远程 worker；须以实际生成影片验证，不能由 API 容器依赖判断。")
                    for frame in report["frames"]:
                        frame["url"] = S3.generate_presigned_url("get_object", Params={"Bucket": INPUT,
                            "Key": f"projects/{pid}/frames/{frame['id']}/frame.png"}, ExpiresIn=600)
                    return report
                return response(200, {"data": with_project(owner, pid, preflight)})
            if method == "GET" and len(parts) == 2:
                return response(200, {"data": with_project(owner, pid, lambda svc, current, root: public_project_view(svc, current, owner))})
            if method == "POST" and parts[2:] in (["metrics", "source"], ["metrics", "preview"]):
                body = json_body(event)
                is_source = parts[-1] == "source"
                fields = {"expectedRevision", "format", "text"} if is_source else {"expectedRevision", "request"}
                if set(body) != fields:
                    raise HttpError("invalid_request", "Invalid metric intake fields", 422)
                return response(200, {"data": with_project(owner, pid, lambda svc, current, root:
                    svc.metric_source(pid, body["expectedRevision"], body["format"], body["text"]) if is_source else
                    svc.metric_preview(pid, body["expectedRevision"], body["request"]))})
            if method == "POST" and parts[2:] == ["clock", "preview"]:
                body = json_body(event)
                if set(body) != {"expectedRevision", "request"}:
                    raise HttpError("invalid_request", "Invalid clock alignment fields", 422)
                return response(200, {"data": with_project(owner, pid, lambda svc, current, root:
                    svc.clock_preview(pid, body["expectedRevision"], body["request"]))})
            if method == "POST" and len(parts) == 3:
                action = parts[2]
                if action == "media":
                    raise HttpError("upload_too_large", "Cloud uploads use /uploads and /media/commit", 413)
                if action == "uploads":
                    return response(200, {"data": signed_upload(owner, pid, json_body(event))})
                body = json_body(event)
                expected = body.get("expectedRevision")
                if action == "edit":
                    return response(200, {"data": with_project(owner, pid, lambda s,c,r: s.edit(pid, expected, body.get("patch")), True)})
                if action == "metrics":
                    return response(200, {"data": with_project(owner, pid, lambda s,c,r: s.metrics(pid, expected, body.get("bundle")), True)})
                if action == "observations":
                    raise HttpError("not_found", "Use /observations/import", 404)
                if action == "story":
                    if body.get("mode") == "model":
                        idem = next((v for k,v in (event.get("headers") or {}).items() if k.lower() == "idempotency-key"), None)
                        if body.get("audience") not in ("fan", "pro") or body.get("providerId") != "agentcore-story":
                            raise HttpError("invalid_request", "Cloud model story requires AgentCore and a valid audience", 422)
                        return response(202, {"data": start_job(owner, pid, expected, "model-story", {"audience": body["audience"], "providerId": "agentcore-story", "commentaryStyle": body.get("commentaryStyle", "zh-analysis"), "language": body.get("language")}, idem)})
                    return response(200, {"data": with_project(owner, pid, lambda s,c,r: s.template_story(pid, expected, body.get("audience"), body.get("mode"), body.get("providerId"), body.get("commentaryStyle", "zh-analysis"), body.get("language")), True)})
                if action == "review":
                    return response(200, {"data": with_project(owner, pid, lambda s,c,r: s.review(pid, expected, body.get("actor"), body.get("checks"), body.get("note"), body.get("reviewerType", "human")), True)})
                if action in ("render", "analyze", "cv"):
                    if action == "cv":
                        raise HttpError("cv_not_installed", "No cloud CV weights/executor configured", 503)
                    if action == "render" and body.get("voiceMode") not in ("silent", *VOICE_PROVIDERS):
                        raise HttpError("voice_unavailable", "Requested cloud voice provider is not configured", 503)
                    idem = next((v for k,v in (event.get("headers") or {}).items() if k.lower() == "idempotency-key"), None)
                    return response(202, {"data": start_job(owner, pid, expected, action, {k:v for k,v in body.items() if k != "expectedRevision"}, idem)})
                if action == "frames":
                    times = body.get("times")
                    if not isinstance(times, list) or not 1 <= len(times) <= 16 or any(type(t) not in (int, float) or not 0 <= t <= 180 for t in times):
                        raise HttpError("invalid_request", "times must contain 1–16 timestamps within 0–180 seconds", 422)
                    idem = next((v for k,v in (event.get("headers") or {}).items() if k.lower() == "idempotency-key"), None)
                    return response(202, {"data": start_job(owner, pid, expected, "frames", {"times": times}, idem)})
            if method == "POST" and parts[2:] == ["media", "commit"]:
                body = json_body(event)
                idem = next((v for k,v in (event.get("headers") or {}).items() if k.lower() == "idempotency-key"), None)
                options = {k: body.get(k) for k in ("uploadKey", "bytes", "sha256", "contentType", "filename")}
                return response(202, {"data": start_job(owner, pid, body.get("expectedRevision"), "ingest", options, idem)})
            if method == "POST" and parts[2:] == ["observations", "import"]:
                body = json_body(event)
                return response(200, {"data": with_project(owner, pid, lambda s,c,r: s.import_observations(pid, body.get("expectedRevision"), body.get("bundle")), True)})
        if method == "POST" and len(parts) == 3 and parts[0] == "providers" and parts[2] == "probe":
            body = json_body(event)
            idem = next((v for k,v in (event.get("headers") or {}).items() if k.lower() == "idempotency-key"), None)
            return response(202, {"data": start_job(owner, body.get("projectId"), body.get("expectedRevision"), "probe-provider", {**body, "providerId": parts[1]}, idem)})
        if len(parts) == 2 and parts[0] == "jobs" and method == "GET":
            return response(200, {"data": get_job(owner, parts[1])})
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "cancel" and method == "POST":
            return response(200, {"data": cancel_job(owner, parts[1])})
        if len(parts) == 2 and parts[0] == "releases" and method == "GET":
            release_id = parts[1]
            if not ID.fullmatch(release_id):
                raise HttpError("invalid_request", "Invalid release ID", 400)
            row = DDB.get_item(TableName=TABLE, Key={"pk": {"S": "OWNER#" + owner}, "sk": {"S": "RELEASE#" + release_id}}, ConsistentRead=True).get("Item")
            if not row:
                raise HttpError("not_found", "Release not published", 404)
            pid = row["projectId"]["S"]
            def release_view(svc, current, root):
                data = svc.release(release_id)
                for field, name in (("videoUrl", "film.mp4"), ("captionsUrl", "captions.vtt"), ("manifestUrl", "manifest.json")):
                    data["summary"][field] = f"/releases/{release_id}/{name}"
                return data
            return response(200, {"data": with_project(owner, pid, release_view)})
        raise HttpError("not_found", "Unknown API path", 404)
    except HttpError as exc:
        return error(exc.code, str(exc), exc.status)
    except Conflict as exc:
        return error("revision_conflict", str(exc), 409)
    except BroadcastError as exc:
        return response(exc.status, {"error": exc.body()})
    except FileNotFoundError:
        return error("not_found", "Project not found", 404)
    except Exception as exc:
        # Never return a success-shaped response after an integration or provider failure.
        print(json.dumps({"event": "broadcast_api_failed", "type": type(exc).__name__}))
        return error("internal_error", "Cloud request failed; inspect request ID in CloudWatch", 500)
