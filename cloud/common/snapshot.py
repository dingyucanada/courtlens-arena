"""Immutable S3 workspace snapshots; DynamoDB pointer is changed with revision CAS."""
import io
import hashlib
import json
import os
import re
import stat
import uuid
import zipfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

PROJECT_ID = re.compile(r"^[a-f0-9]{32}$")
MAX_UNPACKED = 512 * 1024 * 1024
MAX_SNAPSHOT = 128 * 1024 * 1024
MAX_ENTRIES = 10000
s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")


class Conflict(Exception):
    pass


def project_key(owner, project_id):
    if not isinstance(owner, str) or len(owner) > 128 or not PROJECT_ID.fullmatch(project_id or ""):
        raise ValueError("Invalid owner or project ID")
    return {"pk": {"S": "OWNER#" + owner}, "sk": {"S": "PROJECT#" + project_id}}


def get_project(table, owner, project_id):
    row = ddb.get_item(TableName=table, Key=project_key(owner, project_id), ConsistentRead=True).get("Item")
    if not row:
        raise FileNotFoundError("Project not found")
    return {"revision": int(row["revision"]["N"]), "snapshotKey": row["snapshotKey"]["S"], "title": row["title"]["S"]}


def _safe_members(archive, project_id):
    members = archive.infolist()
    if len(members) > MAX_ENTRIES or sum(m.file_size for m in members) > MAX_UNPACKED:
        raise ValueError("Snapshot exceeds bounded extraction size")
    prefix = f"broadcast/{project_id}/"
    for member in members:
        name = member.filename
        parts = Path(name).parts
        if not name.startswith(prefix) or not parts or any(p in ("", ".", "..") for p in parts) or name.startswith("/"):
            raise ValueError("Snapshot contains unsafe path")
        mode = member.external_attr >> 16
        if stat.S_ISLNK(mode) or (mode and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))):
            raise ValueError("Snapshot contains unsupported file type")
    return members


def media_object(bucket, project):
    media = project.get("media")
    if not isinstance(media, dict) or not PROJECT_ID.fullmatch(media.get("id", "")):
        raise ValueError("Project has no valid media identity")
    prefix = f"projects/{project['id']}/media/{media['id']}/source."
    rows = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=3).get("Contents", [])
    allowed = re.compile(rf"projects/{project['id']}/media/{media['id']}/source\.(mp4|mov|webm|mkv)")
    keys = [row["Key"] for row in rows if allowed.fullmatch(row["Key"])]
    if len(keys) != 1:
        raise ValueError("Current media object not found or ambiguous")
    return keys[0]


def hydrate(bucket, snapshot_key, project_id, workspace, include_media=False):
    if not re.fullmatch(rf"projects/{project_id}/snapshots/[a-f0-9]{{32}}\.zip", snapshot_key):
        raise ValueError("Snapshot key does not belong to project")
    target = Path(workspace).resolve()
    target.mkdir(parents=True, exist_ok=True)
    source = s3.get_object(Bucket=bucket, Key=snapshot_key)
    if source["ContentLength"] > MAX_SNAPSHOT:
        raise ValueError("Snapshot archive too large")
    raw = source["Body"].read(MAX_SNAPSHOT + 1)
    if len(raw) > MAX_SNAPSHOT:
        raise ValueError("Snapshot archive too large")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for member in _safe_members(archive, project_id):
            destination = (target / member.filename).resolve()
            if not destination.is_relative_to(target):
                raise ValueError("Snapshot path escaped workspace")
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, open(destination, "wb") as output:
                    while chunk := source.read(1024 * 1024):
                        output.write(chunk)
    folder = target / "broadcast" / project_id
    if include_media:
        project = json.loads((folder / "project.json").read_text(encoding="utf-8"))
        if project.get("id") != project_id:
            raise ValueError("Snapshot project ID mismatch")
        media = project.get("media")
        if media:
            key = media_object(bucket, project)
            source = folder / "media" / media["id"] / Path(key).name
            source.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(bucket, key, str(source))
            digest = hashlib.sha256()
            with source.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != media["sha256"] or source.stat().st_size != media["bytes"]:
                raise ValueError("Hydrated media does not match project manifest")
    return folder


def persist(bucket, table, owner, project_id, workspace, expected_revision, new_revision, old_key, title):
    directory = Path(workspace).resolve() / "broadcast" / project_id
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError("Project workspace missing")
    key = f"projects/{project_id}/snapshots/{uuid.uuid4().hex}.zip"
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
        total = 0
        for file in directory.rglob("*"):
            if file.is_symlink():
                raise ValueError("Workspace contains symbolic link")
            if not file.is_file():
                continue
            if re.fullmatch(r"media/[a-f0-9]{32}/source\.(mp4|mov|webm|mkv)", file.relative_to(directory).as_posix()):
                # Source media is immutable in S3; keeping it out of snapshots makes edits bounded.
                continue
            if re.fullmatch(r"releases/[a-f0-9]{32}/(film\.mp4|captions\.vtt|narration\.wav)", file.relative_to(directory).as_posix()):
                # Published bytes live in the release bucket. Keep summary/manifest for service.release.
                continue
            total += file.stat().st_size
            if total > MAX_UNPACKED:
                raise ValueError("Workspace exceeds snapshot limit")
            archive.write(file, file.relative_to(Path(workspace)))
    if memory.getbuffer().nbytes > MAX_SNAPSHOT:
        raise ValueError("Snapshot archive exceeds 128 MiB limit")
    s3.put_object(Bucket=bucket, Key=key, Body=memory.getvalue(), ContentType="application/zip", Metadata={"revision": str(new_revision)})
    if old_key is None:
        item = {**project_key(owner, project_id), "revision": {"N": str(new_revision)}, "snapshotKey": {"S": key}, "title": {"S": title}}
        try:
            ddb.put_item(TableName=table, Item=item, ConditionExpression="attribute_not_exists(pk)")
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise Conflict("Project already exists") from exc
            raise
    else:
        try:
            ddb.update_item(TableName=table, Key=project_key(owner, project_id),
                            UpdateExpression="SET revision=:new, snapshotKey=:key, title=:title",
                            ConditionExpression="revision=:old AND snapshotKey=:oldKey",
                            ExpressionAttributeValues={":new": {"N": str(new_revision)}, ":key": {"S": key}, ":title": {"S": title}, ":old": {"N": str(expected_revision)}, ":oldKey": {"S": old_key}})
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise Conflict("Project revision changed") from exc
            raise
    return key
