"""One bounded Fargate task: hydrate, call the shared core, CAS-persist, publish."""
import io
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.config import Config

from cloud.common.snapshot import Conflict, get_project, hydrate, persist

TABLE = os.environ["TABLE_NAME"]
INPUT = os.environ["INPUT_BUCKET"]
RELEASES = os.environ["RELEASE_BUCKET"]
OWNER = os.environ["OWNER_ID"]
JOB_ID = os.environ["JOB_ID"]
DDB = boto3.client("dynamodb")
S3 = boto3.client("s3")
AGENT = boto3.client("bedrock-agentcore", config=Config(connect_timeout=10, read_timeout=210, retries={"total_max_attempts": 1}))


def job_key():
    return {"pk": {"S": "OWNER#" + OWNER}, "sk": {"S": "JOB#" + JOB_ID}}


def load_job():
    row = DDB.get_item(TableName=TABLE, Key=job_key(), ConsistentRead=True).get("Item")
    if not row or row.get("jobId", {}).get("S") != JOB_ID:
        raise ValueError("Job record missing or mismatched")
    return {"projectId": row["projectId"]["S"], "jobType": row["jobType"]["S"],
            "expectedRevision": int(row["expectedRevision"]["N"]),
            "options": json.loads(row.get("options", {"S": "{}"})["S"])}


def set_job(status, message=None, release_id=None, expected=None, result_revision=None, result_id=None):
    values = {":status": {"S": status}}
    update = "SET #status=:status"
    if message:
        values[":message"] = {"S": message[:500]}
        update += ", errorMessage=:message"
    if release_id:
        values[":release"] = {"S": release_id}
        update += ", releaseId=:release"
    if result_revision is not None:
        values[":revision"] = {"N": str(result_revision)}
        update += ", resultRevision=:revision"
    if result_id:
        values[":resultId"] = {"S": result_id}
        update += ", resultId=:resultId"
    args = {"TableName": TABLE, "Key": job_key(), "UpdateExpression": update,
            "ExpressionAttributeNames": {"#status": "status"}, "ExpressionAttributeValues": values}
    if expected is not None:
        values[":expected"] = {"S": expected}
        args["ConditionExpression"] = "#status=:expected"
    DDB.update_item(**args)


def still_running():
    row = DDB.get_item(TableName=TABLE, Key=job_key(), ConsistentRead=True).get("Item")
    if not row or row.get("status", {}).get("S") != "running":
        raise Conflict("Job was cancelled or superseded")


def unlock(kind):
    lock = "render" if kind == "render" else "analyze" if kind in ("analyze", "probe-provider", "cv", "frames", "model-story") else "ingest"
    try:
        DDB.delete_item(TableName=TABLE, Key={"pk": {"S": "SYSTEM"}, "sk": {"S": "LOCK#" + lock}},
                        ConditionExpression="jobId=:job", ExpressionAttributeValues={":job": {"S": JOB_ID}})
    except Exception:
        pass


def run_core(workspace, job):
    request = {"projectId": job["projectId"], "expectedRevision": job["expectedRevision"],
               "jobType": job["jobType"], "options": job["options"]}
    request_path = Path(workspace) / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    process = subprocess.run([sys.executable, "-m", "core.broadcast.cloud_worker", "--request", str(request_path), "--workspace", str(workspace)],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=900, check=False)
    if process.returncode:
        try:
            problem = json.loads(process.stdout)
            message = problem.get("error", {}).get("message", "Business worker failed")
        except (ValueError, AttributeError):
            message = "Business worker failed; inspect redacted task log"
        raise RuntimeError(message)
    result = json.loads(process.stdout)
    if not isinstance(result, dict) or not isinstance(result.get("job"), dict):
        raise RuntimeError("Business worker produced no Job result")
    if result["job"].get("status") not in ("succeeded", "needs_review"):
        raise RuntimeError("Business worker did not report terminal success")
    return result


def invoke_agent_proposal(workspace, job, project):
    if job["jobType"] not in ("analyze", "probe-provider"):
        return
    media = project.get("media")
    if not isinstance(media, dict) or not re.fullmatch(r"[a-f0-9]{64}", media.get("sha256", "")):
        raise ValueError("Current project has no verified media manifest")
    from core.broadcast.service import BroadcastService
    service = BroadcastService(workspace)
    source = service.media_path(project)
    media_digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            media_digest.update(chunk)
    if media_digest.hexdigest() != media["sha256"]:
        raise ValueError("Current media bytes do not match manifest")
    key = f"projects/{project['id']}/media/{media['id']}/{source.name}"
    head = S3.head_object(Bucket=INPUT, Key=key)
    if head.get("Metadata", {}).get("sha256") != media["sha256"] or head["ContentLength"] != media["bytes"]:
        raise ValueError("Agent media object differs from current project")
    scope = job["options"].get("scope") or {"start": 0, "end": min(4, media["duration"]) if job["jobType"] == "probe-provider" else media["duration"]}
    if not isinstance(scope, dict) or type(scope.get("start")) not in (int, float) or type(scope.get("end")) not in (int, float) or not 0 <= scope["start"] < scope["end"] <= min(180, media["duration"]):
        raise ValueError("Agent scope invalid")
    strategy = job["options"].get("strategy") or ("frames-first" if job["jobType"] == "probe-provider" and job["options"].get("frameId") else "video-first" if job["jobType"] == "probe-provider" else None)
    if strategy not in ("video-first", "frames-first") or job["options"].get("providerId") != "agentcore-proposal" or (strategy == "video-first" and scope["end"] - scope["start"] > 90):
        raise ValueError("Agent strategy/model modality invalid")
    job["options"]["strategy"] = strategy
    job["options"]["scope"] = scope
    seed_times = None
    if job["jobType"] == "probe-provider" and job["options"].get("frameId"):
        frame_id = job["options"]["frameId"]
        if not isinstance(frame_id, str) or not re.fullmatch(r"[a-f0-9]{32}", frame_id):
            raise ValueError("Probe frame ID invalid")
        frame_path = service.store.project_dir(project["id"]) / "frames" / frame_id / "frame.json"
        if not frame_path.is_file() or frame_path.is_symlink() or frame_path.parent.is_symlink():
            raise ValueError("Probe frame is unavailable in current project")
        frame = json.loads(frame_path.read_text())
        if frame.get("mediaSha256") != media["sha256"] or type(frame.get("actualTime")) not in (int, float) or not scope["start"] <= frame["actualTime"] < scope["end"]:
            raise ValueError("Probe frame differs from selected source scope")
        seed_times = [frame["actualTime"]]
    arn = os.environ["AGENT_RUNTIME_ARN"]
    payload = {"kind": "video-proposal", "projectId": project["id"], "key": key, "mediaSha256": media["sha256"],
               "inputRevision": job["expectedRevision"], "scope": scope, "strategy": strategy,
               "rosterIds": [player["id"] for player in project["context"]["roster"]]}
    if seed_times is not None:
        payload["seedTimes"] = seed_times
    response = AGENT.invoke_agent_runtime(agentRuntimeArn=arn, runtimeSessionId=uuid.uuid4().hex + "-courtlens", payload=json.dumps(payload).encode(), qualifier="DEFAULT")
    if response.get("statusCode") != 200 or "application/json" not in response.get("contentType", ""):
        raise RuntimeError("AgentCore returned an unsuccessful or unsupported response")
    body = response["response"].read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise RuntimeError("AgentCore response exceeds 1 MiB")
    proposal = json.loads(body)
    if proposal.get("status") != "proposal" or proposal.get("mediaSha256") != media["sha256"] or proposal.get("strategy") != strategy or proposal.get("scope") != scope or proposal.get("mode") != ("video-model" if strategy == "video-first" else "image-model") or not isinstance(proposal.get("rawProposal"), str) or not proposal["rawProposal"] or not re.fullmatch(r"[a-f0-9]{64}", proposal.get("requestHash", "")) or hashlib.sha256(proposal["rawProposal"].encode()).hexdigest() != proposal.get("responseHash"):
        raise RuntimeError("AgentCore proposal missing identity or provenance")
    seen_frames = proposal.get("frameFingerprints")
    if not isinstance(seen_frames, list) or len(seen_frames) > 16 or any(not isinstance(frame, dict) or not re.fullmatch(r"[a-f0-9]{32}", frame.get("id", "")) or not re.fullmatch(r"[a-f0-9]{64}", frame.get("sha256", "")) or type(frame.get("actualTime")) not in (int, float) or not scope["start"] <= frame["actualTime"] <= scope["end"] for frame in seen_frames):
        raise RuntimeError("AgentCore frame evidence invalid or outside selected scope")
    video_input = proposal.get("videoInput")
    if strategy == "video-first" and (not isinstance(video_input, dict) or video_input.get("sourceStart") != scope["start"] or video_input.get("sourceEnd") != scope["end"] or video_input.get("sourceSha256") != media["sha256"] or not isinstance(video_input.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", video_input["sha256"]) or type(video_input.get("bytes")) is not int or not 0 < video_input["bytes"] <= 4 * 1024 * 1024):
        raise RuntimeError("AgentCore bounded derivative missing")
    if strategy == "frames-first" and video_input is not None:
        raise RuntimeError("Frames-first Agent unexpectedly sent video")
    record = {"mediaSha256": media["sha256"], "inputRevision": job["expectedRevision"], "runtimeArn": arn,
              "requestHash": proposal["requestHash"], "responseHash": proposal["responseHash"],
              "rawProposal": proposal["rawProposal"], "invokedAt": datetime.now(timezone.utc).isoformat(),
              "modelId": proposal.get("modelId"), "usage": proposal.get("usage", []), "requestId": proposal.get("requestId"),
              "scope": scope, "strategy": strategy, "mode": proposal["mode"], "frameFingerprints": seen_frames,
              "videoInput": video_input, "toolCalls": proposal.get("toolCalls", 0)}
    (Path(workspace) / "broadcast" / project["id"] / "agentcore-proposal.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")


def invoke_agent_story(workspace, job, project):
    from core.broadcast.validation import content_hash
    if job["jobType"] != "model-story":
        return
    media = project.get("media")
    if not isinstance(media, dict) or not re.fullmatch(r"[a-f0-9]{64}", media.get("sha256", "")):
        raise ValueError("Current project has no verified source media")
    from core.broadcast.commentary_style import resolve_style
    audience = job["options"].get("audience")
    style = resolve_style(job["options"].get("commentaryStyle"))
    if audience not in ("fan", "pro") or job["options"].get("providerId") != "agentcore-story":
        raise ValueError("Story job audience/provider invalid")
    accepted = sorted((o for o in project["observations"] if o["review"]["status"] == "accepted"), key=lambda o: o["start"])[:30]
    if not accepted:
        raise ValueError("Model story requires accepted observations")
    accepted_ids = {o["id"] for o in accepted}
    confirmed = [b for b in project["bindings"] if b["status"] == "confirmed" and b["observationId"] in accepted_ids][:30]
    records = {r["id"]: r for r in (project.get("metrics") or {}).get("records", [])}
    dictionary = (project.get("metrics") or {}).get("dictionary", {}).get("metrics", {})
    handles = []
    for binding in confirmed:
        for rid in binding["metricRecordIds"]:
            record = records[rid]
            entry = dictionary[record["metricId"]]
            handles.append({"id": rid, "metricId": record["metricId"], "label": entry["label"], "unit": entry["unit"],
                            "granularity": record["scope"]["granularity"], "availableAt": record["time"]["availableAt"],
                            "validTo": record["time"].get("validTo"), "bindingId": binding["id"]})
    end = round(media["duration"] * 25) / 25
    if end > media["duration"]:
        end -= .04
    evidence = {"audience": audience, "commentaryStyle": style["id"], "sourceRange": {"start": 0, "end": end},
                "observations": [{k: o[k] for k in ("id", "type", "start", "end", "anchorTime", "segmentId", "description", "playerIds", "frameIds")} for o in accepted],
                "bindings": [{k: b[k] for k in ("id", "observationId", "officialEventId", "shotId", "metricRecordIds", "timeMapping")} for b in confirmed],
                "metricHandles": handles}
    arn = os.environ["AGENT_RUNTIME_ARN"]
    payload = {"kind": "story-draft", "projectId": project["id"], "mediaSha256": media["sha256"],
               "inputRevision": job["expectedRevision"], "projectContentHash": content_hash(project), "evidence": evidence}
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    if len(raw) > 60000:
        raise ValueError("Reviewed story evidence exceeds AgentCore invocation limit")
    response = AGENT.invoke_agent_runtime(agentRuntimeArn=arn, runtimeSessionId=uuid.uuid4().hex + "-story", payload=raw, qualifier="DEFAULT")
    if response.get("statusCode") != 200 or "application/json" not in response.get("contentType", ""):
        raise RuntimeError("AgentCore story invocation failed")
    body = response["response"].read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise RuntimeError("AgentCore story response exceeds 1 MiB")
    proposal = json.loads(body)
    if proposal.get("status") != "proposal" or proposal.get("mediaSha256") != media["sha256"] or not isinstance(proposal.get("rawProposal"), str) or not proposal["rawProposal"] or not re.fullmatch(r"[a-f0-9]{64}", proposal.get("requestHash", "")) or not re.fullmatch(r"[a-f0-9]{64}", proposal.get("responseHash", "")):
        raise RuntimeError("AgentCore story proposal missing identity or provenance")
    record = {"mediaSha256": media["sha256"], "inputRevision": job["expectedRevision"], "projectContentHash": payload["projectContentHash"],
              "runtimeArn": arn, "modelId": proposal.get("modelId"), "requestHash": proposal["requestHash"], "responseHash": proposal["responseHash"],
              "rawProposal": proposal["rawProposal"], "invokedAt": datetime.now(timezone.utc).isoformat(), "usage": proposal.get("usage", {}), "requestId": proposal.get("requestId")}
    (Path(workspace) / "broadcast" / project["id"] / "agentcore-story.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")


def ingest(workspace, job, project):
    from core.broadcast.service import BroadcastService
    options = job["options"]
    key = options.get("uploadKey")
    pid = job["projectId"]
    if not isinstance(key, str) or not re.fullmatch(rf"projects/{pid}/staging/[a-f0-9]{{32}}\.(mp4|mov|webm|mkv)", key):
        raise ValueError("Upload staging key invalid")
    source = S3.get_object(Bucket=INPUT, Key=key)
    length = source["ContentLength"]
    if length != options.get("bytes") or not 0 < length <= 256 * 1024 * 1024:
        raise ValueError("Upload size changed")
    if source.get("Metadata", {}).get("sha256") != options.get("sha256"):
        raise ValueError("Upload hash metadata changed")
    service = BroadcastService(workspace)
    result = service.upload(pid, job["expectedRevision"], source["Body"], length, options["filename"], options["contentType"])
    if result["media"]["sha256"] != options["sha256"]:
        raise ValueError("Uploaded bytes do not match declared SHA-256")
    media = result["media"]
    media_path = service.media_path(result)
    public_key = f"projects/{pid}/media/{media['id']}/{media_path.name}"
    S3.upload_file(str(media_path), INPUT, public_key, ExtraArgs={"ContentType": options["contentType"], "Metadata": {"sha256": media["sha256"]}})
    return {"job": {"status": "succeeded"}, "project": result}


def extract_frames(workspace, job, project):
    from core.broadcast.service import BroadcastService
    from core.broadcast.common import require
    times = job["options"].get("times")
    require(isinstance(times, list) and 1 <= len(times) <= 16 and all(type(t) in (int, float) and 0 <= t <= 180 for t in times),
            "invalid_request", "Invalid frame timestamps")
    svc = BroadcastService(workspace)
    current = svc.get(job["projectId"])
    if current.get("revision") != job["expectedRevision"] or current.get("media", {}).get("sha256") != project.get("media", {}).get("sha256"):
        raise Conflict("Project or media changed before frame extraction")
    result = svc.frames(job["projectId"], job["expectedRevision"], times)
    for frame in result["frames"]:
        if frame["mediaSha256"] != project["media"]["sha256"] or not re.fullmatch(r"[a-f0-9]{32}", frame["id"]):
            raise ValueError("Extracted frame identity differs from current media")
        file = Path(workspace) / "broadcast" / job["projectId"] / "frames" / frame["id"] / "frame.png"
        if not file.is_file() or file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != frame["sha256"]:
            raise ValueError("Extracted frame bytes failed verification")
    return result


def commit_frames(workspace, project_id, job, previous, updated, frames):
    still_running()
    set_job("committing", expected="running")
    # Private objects may be orphaned by a CAS conflict; no signed URL is exposed until CAS and job success.
    for frame in frames:
        file = Path(workspace) / "broadcast" / project_id / "frames" / frame["id"] / "frame.png"
        S3.upload_file(str(file), INPUT, f"projects/{project_id}/frames/{frame['id']}/frame.png",
                       ExtraArgs={"ContentType": "image/png", "Metadata": {"sha256": frame["sha256"], "media-sha256": frame["mediaSha256"]}})
    persist(INPUT, TABLE, OWNER, project_id, workspace, job["expectedRevision"], updated["revision"], previous["snapshotKey"], updated["title"])
    DDB.update_item(TableName=TABLE, Key=job_key(),
                    UpdateExpression="SET #status=:succeeded, framesResult=:frames",
                    ConditionExpression="#status=:committing",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={":succeeded": {"S": "succeeded"}, ":committing": {"S": "committing"},
                                               ":frames": {"S": json.dumps(frames, separators=(",", ":"))}})


def release_assets(workspace, project_id, result):
    release = result.get("release")
    if not release:
        return None
    release_id = release.get("id")
    if not isinstance(release_id, str) or not re.fullmatch(r"[a-f0-9]{32}", release_id):
        raise ValueError("Release ID invalid")
    folder = Path(workspace) / "broadcast" / project_id / "releases" / release_id
    assets = []
    for name, mime in (("captions.vtt", "text/vtt"), ("manifest.json", "application/json"), ("summary.json", "application/json"), ("film.mp4", "video/mp4")):
        file = folder / name
        if not file.is_file() or file.is_symlink():
            raise ValueError("Verified release asset missing")
        assets.append((name, mime, file))
    return release_id, assets


def publish_release(release_id, assets):
    # MP4 is last: before the CAS there are no public writes; until the final copy there is no playable file.
    for name, mime, file in assets:
        key = f"releases/{release_id}/{name}"
        if name == "manifest.json":
            from core.broadcast.common import hash_json
            manifest = json.loads(file.read_text(encoding="utf-8"))
            manifest.pop("manifestHash", None)
            # The source upload is private; an anonymous viewer must never receive a dead API URL.
            manifest["source"]["mediaUrl"] = None
            manifest["source"]["playbackAvailable"] = False
            manifest["source"]["playbackReason"] = "private-source"
            manifest["manifestHash"] = hash_json(manifest)
            S3.put_object(Bucket=RELEASES, Key=key, Body=json.dumps(manifest, ensure_ascii=False).encode(), ContentType=mime, CacheControl="public, max-age=31536000, immutable")
        elif name == "summary.json":
            summary = json.loads(file.read_text(encoding="utf-8"))
            for field, asset in (("videoUrl", "film.mp4"), ("captionsUrl", "captions.vtt"), ("manifestUrl", "manifest.json")):
                summary[field] = f"/releases/{release_id}/{asset}"
            S3.put_object(Bucket=RELEASES, Key=key, Body=json.dumps(summary, ensure_ascii=False).encode(), ContentType=mime, CacheControl="public, max-age=31536000, immutable")
        else:
            S3.upload_file(str(file), RELEASES, key, ExtraArgs={"ContentType": mime, "CacheControl": "public, max-age=31536000, immutable"})


def index_assets(owner, project_id, project, release_id):
    if project.get("media"):
        media_id = project["media"]["id"]
        DDB.put_item(TableName=TABLE, Item={"pk": {"S": "OWNER#" + owner}, "sk": {"S": "MEDIA#" + media_id}, "projectId": {"S": project_id}})
    if release_id:
        DDB.put_item(TableName=TABLE, Item={"pk": {"S": "OWNER#" + owner}, "sk": {"S": "RELEASE#" + release_id}, "projectId": {"S": project_id}})


def commit_and_publish(workspace, project_id, job, previous, updated, result):
    item = release_assets(workspace, project_id, result)
    release_id, assets = item if item else (None, [])
    still_running()
    phase = "publishing" if release_id else "committing"
    set_job(phase, expected="running")
    persist(INPUT, TABLE, OWNER, project_id, workspace, job["expectedRevision"], updated["revision"], previous["snapshotKey"], updated["title"])
    if release_id:
        publish_release(release_id, assets)
    index_assets(OWNER, project_id, updated, release_id)
    set_job(result["job"]["status"], release_id=release_id, expected=phase,
            result_revision=updated["revision"] if job["jobType"] == "model-story" else None,
            result_id=result["job"].get("resultId"))


def main():
    job = load_job()
    if job["jobType"] not in ("ingest", "analyze", "probe-provider", "cv", "render", "frames", "model-story"):
        raise ValueError("Unsupported job type")
    set_job("running", expected="queued")
    try:
        pid = job["projectId"]
        project = get_project(TABLE, OWNER, pid)
        if project["revision"] != job["expectedRevision"]:
            raise Conflict("Project revision changed before worker started")
        with tempfile.TemporaryDirectory(prefix="courtlens-job-") as temp:
            folder = hydrate(INPUT, project["snapshotKey"], pid, temp, include_media=job["jobType"] != "ingest")
            data = json.loads((folder / "project.json").read_text(encoding="utf-8"))
            if data.get("id") != pid or data.get("revision") != job["expectedRevision"]:
                raise Conflict("Snapshot identity/revision mismatch")
            if job["jobType"] in ("analyze", "probe-provider"):
                invoke_agent_proposal(temp, job, data)
            if job["jobType"] == "model-story":
                invoke_agent_story(temp, job, data)
            result = ingest(temp, job, project) if job["jobType"] == "ingest" else (extract_frames(temp, job, data) if job["jobType"] == "frames" else run_core(temp, job))
            updated = json.loads((folder / "project.json").read_text(encoding="utf-8"))
            if updated.get("id") != pid or not isinstance(updated.get("revision"), int) or updated["revision"] < job["expectedRevision"]:
                raise ValueError("Worker produced invalid project revision")
            # An unchanged revision is valid for a probe that only records an unreviewed run.
            if job["jobType"] == "frames":
                commit_frames(temp, pid, job, project, updated, result["frames"])
            else:
                commit_and_publish(temp, pid, job, project, updated, result)
    except Exception as exc:
        for phase in ("running", "publishing", "committing"):
            try:
                set_job("failed", f"{type(exc).__name__}: {exc}", expected=phase)
                break
            except Exception:
                continue
        raise
    finally:
        unlock(job["jobType"])


if __name__ == "__main__":
    main()
