"""Business service shared by local HTTP and an optional hydrated cloud worker."""
import copy
import hashlib
import json
import os
import re
import shutil
import threading
from pathlib import Path

from .common import BroadcastError, bounded_text, canonical, digest, finite, hash_json, now, require, uid, valid_id
from .media import MAX_UPLOAD, FFPROBE, FFMPEG, frame_at, probe, safe_filename, stream_upload
from .render import FONT, font_available, render
from .schema import validate as validate_shape
from .store import BroadcastStore
from .validation import bindings as validate_bindings, content_hash, metric_bundle, observations as validate_observations, story as validate_story


def validate_play_by_play(value, game_id):
    """Keep background event records bounded and separate from source-video PTS."""
    if value is None:
        return
    require(isinstance(value, dict) and set(value) == {"source", "entries"}, "invalid_request", "逐回合背景结构无效。")
    source = value["source"]
    basic = {"provider", "url", "retrievedAt", "gameId"}
    teams = {"awayTeamId", "homeTeamId"}
    require(isinstance(source, dict) and set(source) in (basic, basic | teams), "invalid_request", "逐回合来源无效。")
    require(bool(game_id) and source["gameId"] == game_id and isinstance(source["provider"], str) and
            1 <= len(source["provider"]) <= 80 and isinstance(source["url"], str) and
            source["url"].startswith("https://") and len(source["url"]) <= 500 and
            isinstance(source["retrievedAt"], str) and 1 <= len(source["retrievedAt"]) <= 80,
            "invalid_request", "逐回合来源须与本场比赛 ID 对应且提供 HTTPS 地址和获取时间。")
    if teams <= set(source):
        require(valid_id(source["awayTeamId"]) and valid_id(source["homeTeamId"]) and
                source["awayTeamId"] != source["homeTeamId"], "invalid_request", "逐回合主客队标识无效。")
    entries = value["entries"]
    require(isinstance(entries, list) and len(entries) <= 40, "invalid_request", "逐回合背景最多40项。")
    seen = set()
    for row in entries:
        require(isinstance(row, dict) and set(row) == {"id", "period", "clock", "text", "awayScore", "homeScore"} and
                valid_id(row["id"]) and row["id"] not in seen and type(row["period"]) is int and 1 <= row["period"] <= 20 and
                isinstance(row["clock"], str) and re.fullmatch(r"\d{1,2}:\d{2}", row["clock"]) and
                int(row["clock"].split(":")[0]) <= (12 if row["period"] <= 4 else 5) and
                int(row["clock"].split(":")[1]) < 60 and
                isinstance(row["text"], str) and 1 <= len(row["text"]) <= 240 and
                all(type(row[k]) is int and 0 <= row[k] <= 500 for k in ("awayScore", "homeScore")),
                "invalid_request", "逐回合条目字段、时间或比分无效。")
        seen.add(row["id"])


class BroadcastService:
    def __init__(self, workspace_root):
        self.store = BroadcastStore(workspace_root)
        self._threads = {}

    def capabilities(self):
        from .providers import capabilities
        from .commentary_style import capability_styles
        import shutil as _shutil
        import os as _os
        ffmpeg = bool(_shutil.which(FFMPEG) or Path(FFMPEG).is_file())
        ffprobe = bool(_shutil.which(FFPROBE) or Path(FFPROBE).is_file())
        node = bool(_shutil.which(_os.environ.get("COURTLENS_NODE", "node")) or (_os.environ.get("COURTLENS_NODE") and Path(_os.environ["COURTLENS_NODE"]).is_file()))
        font = font_available(FONT)
        return validate_shape({"schema": "courtlens-broadcast-capabilities/1", "renderer": {"available": ffmpeg and ffprobe and font, "ffmpeg": ffmpeg, "ffprobe": ffprobe, "node": node, "font": font}, "providers": capabilities(self.store.root), "commentaryStyles": capability_styles(), "deployment": {"mode": "local", "agentService": None, "region": _os.environ.get("AWS_REGION"), "verified": False}}, "capabilities")

    def create(self, title, mode):
        bounded_text(title, "title", 160, True)
        require(mode in ("manual", "assisted"), "invalid_request", "制作模式无效。")
        stamp = now()
        project = {"schema": "courtlens-broadcast/1", "id": uid(), "revision": 0, "title": title, "createdAt": stamp, "updatedAt": stamp, "mode": mode, "media": None, "context": {"gameId": None, "gameDate": None, "seasonId": None, "seasonType": None, "offenseTeamId": None, "roster": [], "playByPlay": None}, "observations": [], "bindings": [], "metrics": None, "story": None, "review": None, "releases": []}
        self.store.write(validate_shape(project, "project"))
        return project

    def get(self, project_id):
        return validate_shape(self.store.read(project_id), "project")

    def list(self):
        return {"projects": self.store.list_projects()}

    def _revision(self, project, expected):
        require(type(expected) is int, "invalid_request", "写操作需要 expectedRevision。")
        require(project["revision"] == expected, "revision_conflict", "项目已更新，请刷新后重试。", 409)

    def _save_edit(self, project):
        project["revision"] += 1
        project["updatedAt"] = now()
        project["review"] = None
        self.store.write(validate_shape(project, "project"))
        return project

    def _media_dir(self, project):
        media = project.get("media")
        require(media is not None, "media_mismatch", "项目尚未上传视频。", 422)
        directory = self.store.project_dir(project["id"]) / "media" / media["id"]
        require(directory.is_dir() and not directory.is_symlink() and directory.resolve().is_relative_to(self.store.root), "media_mismatch", "媒体目录无效。", 422)
        return directory

    def media_path(self, project):
        directory = self._media_dir(project)
        files = list(directory.glob("source.*"))
        require(len(files) == 1 and files[0].is_file() and not files[0].is_symlink(), "media_mismatch", "源片文件无效。", 422)
        return files[0]

    def upload(self, project_id, expected, stream, length, filename, content_type):
        require(content_type in ("video/mp4", "video/quicktime", "video/webm", "video/x-matroska"), "invalid_request", "只接受 MP4、MOV、WebM 视频。", 415)
        ext = {"video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv"}[content_type]
        with self.store.lock:
            project = self.get(project_id)
            self._revision(project, expected)
            require(type(length) is int and 0 < length <= MAX_UPLOAD, "upload_too_large", "视频不得超过 256 MiB。", 413)
            mid = uid()
            directory = self.store.project_dir(project_id) / "media" / mid
            directory.mkdir(parents=True, exist_ok=False)
            source = directory / ("source" + ext)
            try:
                sha = stream_upload(stream, length, source)
                actual = probe(source)
                # The public manifest has the specified fields; frame index is a private sidecar.
                self.store.atomic(directory / "pts.json", {"framePts": actual.pop("framePts"), "frameTimes": actual.pop("frameTimes"), "firstFramePts": actual.pop("firstFramePts")})
                project["media"] = {"id": mid, "sha256": sha, "filename": safe_filename(filename), "bytes": length, "duration": actual["duration"], "width": actual["width"], "height": actual["height"], "timeBase": actual["timeBase"], "startPts": actual["startPts"], "fpsNumerator": actual["fpsNumerator"], "fpsDenominator": actual["fpsDenominator"], "variableFrameRate": actual["variableFrameRate"], "hasAudio": actual["hasAudio"], "mediaUrl": f"/api/broadcast/v1/media/{mid}", "posterUrl": None, "source": {"label": "用户上传", "kind": "user-provided", "rightsNote": "", "verified": False}}
                project["observations"] = []
                project["bindings"] = []
                project["metrics"] = None
                project["story"] = None
                self._save_edit(project)
                return project
            except BaseException:
                shutil.rmtree(directory, ignore_errors=True)
                raise

    def frames(self, project_id, expected, times):
        with self.store.lock:
            project = self.get(project_id)
            self._revision(project, expected)
            require(isinstance(times, list) and 1 <= len(times) <= 16, "invalid_request", "一次须请求 1–16 帧。")
            directory = self._media_dir(project)
            meta = json.loads((directory / "pts.json").read_text())
            meta["duration"] = project["media"]["duration"]
            output = []
            for t in times:
                fid = uid()
                fdir = self.store.project_dir(project_id) / "frames" / fid
                fdir.mkdir(parents=True, exist_ok=False)
                try:
                    target = fdir / "frame.png"
                    actual, pts = frame_at(self.media_path(project), meta, t, target)
                    fr = {"id": fid, "mediaSha256": project["media"]["sha256"], "requestedTime": t, "actualTime": actual, "pts": pts, "timeBase": project["media"]["timeBase"], "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "url": f"/api/broadcast/v1/frames/{fid}", "width": project["media"]["width"], "height": project["media"]["height"]}
                    validate_shape(fr, "frame")
                    self.store.atomic(fdir / "frame.json", fr)
                    output.append(fr)
                except BaseException:
                    shutil.rmtree(fdir, ignore_errors=True)
                    raise
            return {"frames": output}

    def _frame_ids(self, project):
        result = set()
        directory = self.store.project_dir(project["id"]) / "frames"
        if directory.exists():
            for f in directory.glob("*/frame.json"):
                try:
                    row = json.loads(f.read_text())
                    if row.get("mediaSha256") == project["media"]["sha256"]:
                        result.add(row["id"])
                except (OSError, ValueError, KeyError):
                    pass
        return result

    def _frame_times(self, project):
        result = {}
        directory = self.store.project_dir(project["id"]) / "frames"
        if directory.exists():
            for f in directory.glob("*/frame.json"):
                try:
                    row = json.loads(f.read_text())
                    if row.get("mediaSha256") == project["media"]["sha256"]:
                        result[row["id"]] = row["actualTime"]
                except (OSError, ValueError, KeyError):
                    pass
        return result

    def edit(self, project_id, expected, patch):
        with self.store.lock:
            p = self.get(project_id)
            self._revision(p, expected)
            require(isinstance(patch, dict) and patch and set(patch) <= {"title", "mode", "context", "source", "observations", "bindings", "story"}, "invalid_request", "编辑字段不在白名单。")
            if "title" in patch:
                p["title"] = bounded_text(patch["title"], "title", 160, True)
            if "mode" in patch:
                require(patch["mode"] in ("manual", "assisted"), "invalid_request", "模式无效。")
                p["mode"] = patch["mode"]
            if "context" in patch:
                context = patch["context"]
                require(isinstance(context, dict) and set(context) <= set(p["context"]) | {"playByPlay"}, "invalid_request", "比赛背景字段无效。")
                updated = {**p["context"], **context}
                if "gameId" in context and context["gameId"] != p["context"]["gameId"] and "playByPlay" not in context:
                    updated["playByPlay"] = None
                for key in ("gameId", "gameDate", "seasonId", "seasonType", "offenseTeamId"):
                    require(updated[key] is None or isinstance(updated[key], str) and 1 <= len(updated[key]) <= 120, "invalid_request", key + " 无效。")
                roster = updated["roster"]
                require(isinstance(roster, list) and len(roster) <= 40, "invalid_request", "名单过长。")
                for player in roster:
                    validate_shape(player, "player")
                    require(isinstance(player, dict) and set(player) == {"id", "name", "teamId", "jersey", "source", "validOn"} and valid_id(player["id"]) and valid_id(player["teamId"]), "invalid_request", "名单字段无效。")
                    for field in ("name", "source"):
                        bounded_text(player[field], field, 120, True)
                require(len({player["id"] for player in roster}) == len(roster), "schema_invalid", "名单球员 ID 不得重复。", 422)
                validate_play_by_play(updated.get("playByPlay"), updated["gameId"])
                if updated != p["context"]:
                    # Game/team/roster changes invalidate identity and event claims made earlier.
                    p["bindings"] = []
                p["context"] = updated
            if "source" in patch:
                require(p["media"] is not None and isinstance(patch["source"], dict) and set(patch["source"]) <= {"label", "kind", "rightsNote"}, "invalid_request", "来源字段无效。")
                source = {**p["media"]["source"], **patch["source"]}
                require(source["kind"] in ("official-provided", "user-provided", "synthetic"), "invalid_request", "来源种类无效。")
                bounded_text(source["label"], "source.label", 160, True)
                bounded_text(source["rightsNote"], "source.rightsNote", 500)
                source["verified"] = False
                p["media"]["source"] = source
            if "observations" in patch:
                require(p["media"] is not None, "media_mismatch", "先上传视频。", 422)
                old = {o["id"]: o for o in p["observations"]}
                rows = copy.deepcopy(patch["observations"])
                require(isinstance(rows, list) and len(rows) <= 300 and all(isinstance(row, dict) for row in rows), "schema_invalid", "观察须为有限大小的对象数组。", 422)
                for row in rows:
                    validate_shape(row, "observation")
                    if row.get("id") in old:
                        previous = old[row["id"]]
                        factual = ("type", "start", "end", "anchorTime", "segmentId", "description", "playerIds", "unknownActors", "confidence")
                        changed = any(row.get(key) != previous.get(key) for key in factual)
                        if changed and previous["source"]["kind"] in ("model", "cv"):
                            row["source"] = {"kind": "manual", "runId": previous["source"]["runId"], "recordId": previous["id"]}
                        else:
                            row["source"] = previous["source"]
                    else:
                        row["source"] = {"kind": "manual", "runId": None, "recordId": None}
                        row["confidence"] = None
                    validate_shape(row, "observation")
                validate_observations(rows, p["media"], p["context"]["roster"], self._frame_ids(p))
                p["observations"] = rows
            if "context" in patch and p["media"] is not None:
                # Removing a player who is still named by an observation is not a safe edit.
                validate_observations(p["observations"], p["media"], p["context"]["roster"], self._frame_ids(p))
            if "bindings" in patch:
                require(isinstance(patch["bindings"], list), "schema_invalid", "绑定须为数组。", 422)
                for binding in patch["bindings"]:
                    validate_shape(binding, "binding")
                validate_bindings(patch["bindings"], p)
                p["bindings"] = patch["bindings"]
            elif "observations" in patch:
                # An observation edit can invalidate an old binding.
                p["bindings"] = [b for b in p["bindings"] if b["observationId"] in {o["id"] for o in p["observations"]}]
            validate_bindings(p["bindings"], p)
            if "story" in patch:
                p["story"] = patch["story"]
                validate_shape(p["story"], "story")
                validate_story(p, self._frame_times(p))
            elif set(patch) & {"context", "observations", "bindings", "source"}:
                p["story"] = None
            return self._save_edit(p)

    def metrics(self, project_id, expected, bundle):
        with self.store.lock:
            p = self.get(project_id)
            self._revision(p, expected)
            require(p["media"] is not None, "media_mismatch", "先上传视频。", 422)
            metric_bundle(bundle)
            for play in bundle["plays"]:
                require(0 <= play["start"] < play["end"] <= p["media"]["duration"], "schema_invalid", "指标回合源时间越界。", 422)
            p["metrics"] = bundle
            p["bindings"] = []
            p["story"] = None
            return self._save_edit(p)

    def import_observations(self, project_id, expected, bundle):
        with self.store.lock:
            p = self.get(project_id)
            self._revision(p, expected)
            require(p["media"] is not None and isinstance(bundle, dict) and bundle.get("schema") == "courtlens-observations/1" and bundle.get("mediaSha256") == p["media"]["sha256"], "media_mismatch", "观察包和当前源片不一致。", 422)
            rows = copy.deepcopy(bundle.get("observations"))
            require(isinstance(rows, list) and len(rows) <= 300 and all(isinstance(row, dict) for row in rows) and isinstance(bundle.get("providerRun"), dict), "schema_invalid", "观察包字段无效。", 422)
            run_id = uid()
            stamp = now()
            # Imported provenance can never claim a model call or executed CV.
            for row in rows:
                row["id"] = uid()
                row["source"] = {"kind": "cv" if bundle.get("providerRun", {}).get("mode") in ("cv-imported", "cv-executed") else "manual", "runId": run_id, "recordId": None}
                row["review"] = {"status": "unreviewed", "actor": None, "reason": None, "at": None}
                validate_shape(row, "observation")
            validate_observations(rows, p["media"], p["context"]["roster"], self._frame_ids(p))
            sidecar = {"schema": "courtlens-observations/1", "mediaSha256": p["media"]["sha256"], "providerRun": {"id": run_id, "provider": "user-import", "modelId": None, "mode": "cv-imported" if rows and rows[0]["source"]["kind"] == "cv" else "manual", "requestHash": hash_json(bundle), "responseHash": hash_json(rows), "startedAt": stamp, "completedAt": stamp}, "observations": rows, "untrustedClaim": bundle.get("providerRun")}
            self.store.atomic(self.store.project_dir(project_id) / "runs" / (run_id + ".json"), sidecar)
            p["observations"].extend(rows)
            p["story"] = None
            return self._save_edit(p)

    def import_cv(self, project_id, expected, result):
        from .providers.cv_command import validate_result, normalize
        with self.store.lock:
            p = self.get(project_id)
            self._revision(p, expected)
            require(p["media"] is not None, "media_mismatch", "先上传视频。", 422)
            scope = {"start": 0, "end": p["media"]["duration"]}
            validate_result(result, p, scope)
            run_id = uid()
            rows = normalize(result, p, run_id, "cv-imported")
            for row in rows:
                validate_shape(row, "observation")
            stamp = now()
            sidecar = {"schema": "courtlens-observations/1", "mediaSha256": p["media"]["sha256"], "providerRun": {"id": run_id, "provider": result["provider"]["id"], "modelId": None, "mode": "cv-imported", "requestHash": hash_json(result), "responseHash": hash_json(rows), "startedAt": stamp, "completedAt": stamp}, "observations": rows, "cvResultHash": hash_json(result)}
            self.store.atomic(self.store.project_dir(project_id) / "runs" / (run_id + ".json"), sidecar)
            p["observations"].extend(rows)
            p["story"] = None
            return self._save_edit(p)

    def template_story(self, project_id, expected, audience, mode, provider_id, commentary_style="zh-analysis"):
        from .commentary_style import resolve_style
        style = resolve_style(commentary_style)["id"]
        if mode == "model":
            return self.model_story(project_id, expected, audience, provider_id, style)
        with self.store.lock:
            p = self.get(project_id)
            self._revision(p, expected)
            require(mode == "template", "provider_not_configured", "模型故事当前未配置，请使用证据模板。", 503)
            require(style == "zh-analysis", "invalid_request", "事实模板只用普通话；其他语言请选模型或手写初稿。")
            require(audience in ("fan", "pro"), "invalid_request", "受众无效。")
            require(p["media"] is not None, "media_mismatch", "先上传视频。", 422)
            accepted = sorted((o for o in p["observations"] if o["review"]["status"] == "accepted"), key=lambda x: x["start"])
            require(bool(accepted), "review_required", "先接受至少一条观察。", 422)
            beats = []
            end = p["media"]["duration"]
            previous = 0
            for o in accepted:
                start = max(o["end"], previous)
                if end - start < .25:
                    continue
                stop = min(end, start + 2.4)
                label = {"pass": "传球", "shot": "出手", "catch": "接球", "movement": "跑动", "screen": "掩护", "result": "结果", "other": "关键观察"}[o["type"]]
                beat = {"id": uid(), "label": label, "sourceStart": start, "sourceEnd": stop, "anchorTime": start, "observationIds": [o["id"]], "bindingIds": [], "text": o["description"], "explanationKind": "visible-fact", "metricRecordId": None, "secondaryLabel": None, "annotation": None}
                beats.append(beat)
                previous = stop
                if len(beats) == 3:
                    break
            require(bool(beats), "review_required", "观察结束后没有足够画面展示已取证解说。", 422)
            source_end = round(end * 25) / 25
            if source_end > end:
                source_end -= 1 / 25
            # Template keeps a one-piece source clip. Explicit review still required.
            p["story"] = {"schema": "courtlens-broadcast-story/1", "title": p["title"], "audience": audience, "commentaryStyle": style, "sourceRange": {"start": 0, "end": source_end}, "beats": beats}
            for beat in beats:
                beat["sourceEnd"] = min(beat["sourceEnd"], source_end)
            validate_shape(p["story"], "story")
            validate_story(p, self._frame_times(p))
            return self._save_edit(p)

    def model_story(self, project_id, expected, audience, provider_id, commentary_style="zh-analysis"):
        from .providers.story_model import propose
        from .commentary_style import resolve_style
        style = resolve_style(commentary_style)["id"]
        with self.store.lock:
            p = self.get(project_id)
            self._revision(p, expected)
            require(p["media"] is not None and audience in ("fan", "pro"), "invalid_request", "先上传视频并选择受众。")
            initial_hash = content_hash(p)
            frame_times = self._frame_times(p)
        failure_rows = []
        failure_path = self.store.project_dir(project_id) / "runs" / ("story-failed-" + uid() + ".json")
        def save_failure(row):
            failure_rows.append(row)
            self.store.atomic(failure_path, {"status": "failed-validation", "inputRevision": expected, "commentaryStyle": style, "attempts": failure_rows})
        candidate, audit = propose(p, audience, provider_id, frame_times, style, save_failure)
        with self.store.lock:
            current = self.get(project_id)
            require(current["revision"] == expected and content_hash(current) == initial_hash, "revision_conflict", "模型写作期间项目已变更，提议未覆盖当前内容。", 409)
            current["story"] = candidate
            validate_shape(candidate, "story")
            validate_story(current, self._frame_times(current))
            self.store.atomic(self.store.project_dir(project_id) / "runs" / ("story-" + uid() + ".json"), {**audit, "storyHash": hash_json(candidate), "inputRevision": expected})
            return self._save_edit(current)

    def review(self, project_id, expected, actor, checks, note, reviewer_type="human"):
        with self.store.lock:
            p = self.get(project_id)
            self._revision(p, expected)
            validate_story(p, self._frame_times(p))
            bounded_text(actor, "actor", 120, True)
            bounded_text(note, "note", 1200)
            require(reviewer_type in ("human", "ai"), "invalid_request", "审核身份必须为 human 或 ai。")
            require(isinstance(checks, dict) and set(checks) == {"identity", "timing", "metrics", "wording", "geometry"} and all(type(value) is bool and value is True for value in checks.values()), "review_required", "五项复核均须为 true。", 422)
            p["revision"] += 1
            p["updatedAt"] = now()
            p["review"] = {"contentHash": content_hash(p), "projectRevision": p["revision"], "actor": actor, "at": now(), "checks": checks, "result": "approved", "note": note, "reviewerType": reviewer_type}
            self.store.write(validate_shape(p, "project"))
            return p

    def _job_path(self, p, jid):
        return self.store.project_dir(p["id"]) / "jobs" / jid / "job.json"

    def _write_job(self, p, job):
        with self.store.lock:
            path = self._job_path(p, job["id"])
            if path.exists():
                previous = json.loads(path.read_text())
                require(previous["status"] != "cancelled" or job["status"] == "cancelled", "cancelled", "已取消任务不能重新运行。", 409)
            self.store.atomic(path, validate_shape(job, "job"))

    def job(self, jid):
        return validate_shape(json.loads((self.store.find("jobs", jid) / "job.json").read_text()), "job")

    def cancel(self, jid):
        with self.store.lock:
            job = self.job(jid)
            if job["status"] not in ("succeeded", "failed", "cancelled"):
                job["status"] = "cancelled"
                job["completedAt"] = now()
                job["error"] = BroadcastError("cancelled", "任务已取消。", 409, job_id=jid).body()
                p = self.get(job["projectId"])
                self._write_job(p, job)
            return job

    def start_job(self, project_id, expected, kind, options, idempotency_key=None):
        with self.store.lock:
            p = self.get(project_id)
            require(kind in ("render", "analyze", "cv", "probe-provider", "model-story"), "invalid_request", "任务类型无效。")
            require(isinstance(options, dict), "invalid_request", "任务参数须为对象。")
            key = idempotency_key
            if key is not None:
                require(isinstance(key, str) and 1 <= len(key) <= 100 and valid_id(key), "invalid_request", "Idempotency-Key 无效。")
                idem = self.store.project_dir(project_id) / "idempotency" / (key + ".json")
                request_hash = hash_json({"kind": kind, "options": options, "expectedRevision": expected})
                if idem.exists():
                    saved = json.loads(idem.read_text())
                    require(saved["requestHash"] == request_hash, "revision_conflict", "相同幂等键对应不同请求。", 409)
                    return self.job(saved["jobId"])
            self._revision(p, expected)
            if kind == "render":
                require(set(options) <= {"voiceMode", "voiceId"}, "invalid_request", "成片参数字段无效。")
                require(p["review"] is not None and p["review"]["projectRevision"] == p["revision"] and p["review"]["contentHash"] == content_hash(p), "review_required", "当前内容尚未完成复核。", 422)
                validate_story(p, self._frame_times(p))
                require(options.get("voiceMode") in ("silent", "local-tts", "minimax", "stepfun", "polly"), "invalid_request", "声音模式无效。")
                require(options.get("voiceId") is None or isinstance(options["voiceId"], str) and len(options["voiceId"]) <= 120, "invalid_request", "音色 ID 无效。")
                require(not p["media"]["variableFrameRate"], "unsupported_timebase", "VFR 视频尚无输出 PTS 映射。", 422)
                if options["voiceMode"] == "silent":
                    require(options.get("voiceId") is None, "invalid_request", "静音模式不得指定音色。")
                else:
                    from .providers.voice import configured_voice
                    configured_voice(options["voiceMode"], options.get("voiceId"))
            elif kind in ("analyze", "cv", "probe-provider"):
                from .providers import check_configured
                check_configured(kind, options)
            elif kind == "model-story":
                from .commentary_style import resolve_style
                resolve_style(options.get("commentaryStyle"))
                require(options.get("audience") in ("fan", "pro") and p["media"] is not None, "invalid_request", "先上传视频并选择受众。", 422)
                if options.get("providerId") == "agentcore-story":
                    require({"audience", "providerId", "_trustedAgentCore"} <= set(options) <= {"audience", "providerId", "commentaryStyle", "_trustedAgentCore"} and options["_trustedAgentCore"] is True and bool(os.environ.get("AGENT_RUNTIME_ARN")), "provider_not_configured", "云故事任务只接受受控 AgentCore 提议。", 503)
                else:
                    require({"audience", "providerId"} <= set(options) <= {"audience", "providerId", "commentaryStyle"} and options["providerId"] in ("stepfun-story", "bedrock-story", "bedrock-video", "bedrock-image"), "provider_not_configured", "选择已配置的文字模型。", 503)
                    if options["providerId"] == "stepfun-story":
                        from .providers.stepfun import model_for
                        model_for("story")
                    else:
                        model_key = "COURTLENS_VISION_MODEL_ID" if options["providerId"] == "bedrock-image" else "COURTLENS_STORY_MODEL_ID"
                        require(bool(os.environ.get(model_key) or (options["providerId"] != "bedrock-image" and os.environ.get("COURTLENS_SEMANTIC_MODEL_ID"))) and bool(os.environ.get("COURTLENS_BEDROCK_REGION") or os.environ.get("AWS_REGION")), "provider_not_configured", "故事模型或Bedrock区域未配置。", 503)
            jid = uid()
            job = {"id": jid, "projectId": project_id, "inputRevision": expected, "type": kind, "status": "queued", "stage": "queued", "startedAt": None, "completedAt": None, "progress": None, "resultId": None, "error": None, "cacheHit": False}
            self._write_job(p, job)
            self.store.atomic(self._job_path(p, jid).with_name("input.json"), {"options": options, "inputHash": content_hash(p)})
            if key is not None:
                self.store.atomic(idem, {"requestHash": request_hash, "jobId": jid})
            thread = threading.Thread(target=self.run_job, args=(jid,), daemon=True)
            self._threads[jid] = thread
            thread.start()
            return job

    def run_job(self, jid):
        job = self.job(jid)
        project_id = job["projectId"]
        p = self.get(project_id)
        input_data = json.loads(self._job_path(p, jid).with_name("input.json").read_text())
        try:
            with self.store.lock:
                job = self.job(jid)
                if job["status"] == "cancelled":
                    return job
                require(p["revision"] == job["inputRevision"] and content_hash(p) == input_data["inputHash"], "revision_conflict", "任务排队后项目已编辑，旧版本未执行。", 409)
                job["status"], job["stage"], job["startedAt"] = "running", "probe", now()
                self._write_job(p, job)
            if job["type"] == "render":
                with self.store.lock:
                    current = self.get(project_id)
                    require(current["revision"] == job["inputRevision"] and content_hash(current) == input_data["inputHash"], "revision_conflict", "编辑后的项目不能被旧任务发布。", 409)
                job["stage"] = "render"
                self._write_job(p, job)
                release_id = uid()
                staging = self._job_path(p, jid).parent / "staging"
                source_digest = hashlib.sha256()
                with self.media_path(p).open("rb") as source_stream:
                    for chunk in iter(lambda: source_stream.read(1024 * 1024), b""):
                        source_digest.update(chunk)
                actual_source_hash = source_digest.hexdigest()
                require(actual_source_hash == p["media"]["sha256"], "media_mismatch", "源片字节与已审 hash 不一致。", 422)
                understanding = self._understanding(p)
                first_pts = json.loads((self._media_dir(p) / "pts.json").read_text())["firstFramePts"]
                manifest, duration, video_hash = render(p, self.media_path(p), staging, voice_mode=input_data["options"]["voiceMode"], voice_id=input_data["options"].get("voiceId"), cancel_check=lambda: self.job(jid)["status"] == "cancelled", understanding=understanding, first_frame_pts=first_pts, frame_times=self._frame_times(p))
                with self.store.lock:
                    current = self.get(project_id)
                    require(self.job(jid)["status"] != "cancelled", "cancelled", "任务已取消。", 409)
                    require(current["revision"] == job["inputRevision"] and content_hash(current) == input_data["inputHash"], "revision_conflict", "旧版本结果未发布，项目已被编辑。", 409)
                    target = self.store.project_dir(project_id) / "releases" / release_id
                    target.parent.mkdir(parents=True, exist_ok=True)
                    staging.rename(target)
                    summary = {"id": release_id, "projectRevision": current["revision"], "contentHash": current["review"]["contentHash"], "createdAt": now(), "videoUrl": f"/api/broadcast/v1/releases/{release_id}/film.mp4", "captionsUrl": f"/api/broadcast/v1/releases/{release_id}/captions.vtt", "manifestUrl": f"/api/broadcast/v1/releases/{release_id}/manifest.json", "watchUrl": f"/broadcast/?release={release_id}", "duration": duration, "videoSha256": video_hash, "voice": manifest["voice"], "understanding": manifest["understanding"]}
                    validate_shape(summary, "release")
                    self.store.atomic(target / "summary.json", summary)
                    current["releases"].append(summary)
                    self.store.write(validate_shape(current, "project"))  # publishing does not mutate content revision
                    if manifest["voice"]["mode"] in ("minimax", "stepfun") and manifest["voice"]["audioSha256"]:
                        from .providers import voice_fingerprint
                        voice_mode = manifest["voice"]["mode"]
                        self.store.atomic(self.store.root / ("voice-" + voice_mode + ".json"), {"passed": True, "at": now(), "releaseId": release_id, "fingerprint": voice_fingerprint(voice_mode), "audioSha256": manifest["voice"]["audioSha256"]})
                    job["resultId"] = release_id
                    job["cacheHit"] = False
                    job["status"], job["stage"], job["completedAt"] = "succeeded", "done", now()
                    self._write_job(p, job)
                    return job
            elif job["type"] == "model-story":
                with self.store.lock:
                    job = self.job(jid)
                    if job["status"] == "cancelled":
                        return job
                    job["stage"] = "draft"
                    self._write_job(p, job)
                options = input_data["options"]
                if options["providerId"] == "agentcore-story":
                    from .providers.agentcore_story import import_proposal
                    candidate, audit = import_proposal(self, p, job["inputRevision"], options)
                    story_run_id = audit["id"]
                else:
                    from .providers.story_model import propose
                    failure_rows = []
                    failure_path = self.store.project_dir(project_id) / "runs" / ("story-failed-" + uid() + ".json")
                    def save_failure(row):
                        failure_rows.append(row)
                        self.store.atomic(failure_path, {"status": "failed-validation", "inputRevision": job["inputRevision"], "commentaryStyle": options.get("commentaryStyle", "zh-analysis"), "attempts": failure_rows})
                    candidate, audit = propose(p, options["audience"], options["providerId"], self._frame_times(p), options.get("commentaryStyle"), save_failure)
                    story_run_id = uid()
                with self.store.lock:
                    job = self.job(jid)
                    current = self.get(project_id)
                    require(job["status"] != "cancelled", "cancelled", "任务已取消。", 409)
                    require(current["revision"] == job["inputRevision"] and content_hash(current) == input_data["inputHash"], "revision_conflict", "旧版本故事提议未覆盖当前项目。", 409)
                    current["story"] = candidate
                    validate_shape(candidate, "story")
                    validate_story(current, self._frame_times(current))
                    self.store.atomic(self.store.project_dir(project_id) / "runs" / ("story-" + story_run_id + ".json"), {**audit, "storyHash": hash_json(candidate), "inputRevision": job["inputRevision"]})
                    current = self._save_edit(current)
                    if options["providerId"] == "agentcore-story":
                        (self.store.project_dir(project_id) / "agentcore-story.json").unlink(missing_ok=True)
                    job["resultId"] = story_run_id
                    job["result"] = {"projectId": project_id, "projectRevision": current["revision"]}
                    job["status"], job["stage"], job["completedAt"] = "succeeded", "done", now()
                    self._write_job(p, job)
                    return job
            else:
                from .providers import execute
                with self.store.lock:
                    if self.job(jid)["status"] == "cancelled":
                        return self.job(jid)
                    job["stage"] = "infer"
                    self._write_job(p, job)
                run = execute(self, p, job, input_data["options"])
                job["resultId"] = run["providerRun"]["id"]
                with self.store.lock:
                    if self.job(jid)["status"] == "cancelled":
                        return self.job(jid)
                    current = self.get(project_id)
                    run["trustedExecution"] = True
                    for row in run["observations"]:
                        validate_shape(row, "observation")
                    self.store.atomic(self.store.project_dir(project_id) / "runs" / (run["providerRun"]["id"] + ".json"), run)
                    if job["type"] == "probe-provider":
                        if self.job(jid)["status"] != "cancelled":
                            self.store.atomic(self.store.root / (input_data["options"]["providerId"] + ".json"), {"passed": True, "at": now(), "runId": run["providerRun"]["id"], "modelId": run["providerRun"]["modelId"]})
                    elif current["revision"] == job["inputRevision"] and content_hash(current) == input_data["inputHash"] and self.job(jid)["status"] != "cancelled":
                        current["observations"].extend(run["observations"])
                        self._save_edit(current)
                    else:
                        job["status"] = "needs_review"
                    if job["status"] != "needs_review":
                        job["status"] = "succeeded"
                    job["stage"], job["completedAt"] = "done", now()
                    self._write_job(p, job)
                    return job
        except BroadcastError as exc:
            with self.store.lock:
                job = self.job(jid)
                if job["status"] == "cancelled":
                    return job
                job["status"] = "blocked" if exc.code in ("provider_not_configured", "cv_not_installed", "weights_missing", "unsupported_modality", "voice_unavailable", "unsupported_timebase") else "failed"
                job["error"] = exc.body()
                job["error"]["jobId"] = jid
                job["completedAt"] = now()
                job["stage"] = "done"
                self._write_job(p, job)
            return job
        except Exception as exc:
            with self.store.lock:
                job = self.job(jid)
                if job["status"] == "cancelled":
                    return job
                job["status"] = "failed"
                job["error"] = BroadcastError("render_failed" if job["type"] == "render" else "provider_failed", "任务失败：" + str(exc)[:300], 500, job_id=jid).body()
                job["completedAt"] = now()
                job["stage"] = "done"
                self._write_job(p, job)
            return job

    def _understanding(self, project):
        used = {oid for beat in project["story"]["beats"] for oid in beat["observationIds"]}
        run_ids = {o["source"]["runId"] for o in project["observations"] if o["id"] in used and o["source"]["kind"] in ("model", "cv") and o["source"]["runId"]}
        trusted = []
        for rid in run_ids:
            file = self.store.project_dir(project["id"]) / "runs" / (rid + ".json")
            try:
                data = json.loads(file.read_text())
                if data.get("trustedExecution") and data.get("mediaSha256") == project["media"]["sha256"] and data.get("providerRun", {}).get("mode") in ("video-model", "image-model", "cv-executed"):
                    trusted.append(data["providerRun"])
            except (OSError, ValueError, KeyError):
                pass
        modes = {r["mode"] for r in trusted}
        mode = "video-model" if "video-model" in modes else "image-model" if "image-model" in modes else "cv-assisted" if "cv-executed" in modes else "manual"
        return {"mode": mode, "providerRunIds": sorted(r["id"] for r in trusted), "humanReviewed": (project.get("review") or {}).get("reviewerType", "human") == "human"}

    def release(self, rid):
        directory = self.store.find("releases", rid)
        return {"summary": validate_shape(json.loads((directory / "summary.json").read_text()), "release"), "manifest": json.loads((directory / "manifest.json").read_text())}
