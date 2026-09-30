"""HTTP-contract adapter over BroadcastService; Lambda can reuse dispatch_json."""
import json
import re
from urllib.parse import parse_qs, urlsplit

from .common import BroadcastError, finite, require, valid_id
from .service import BroadcastService

PREFIX = "/api/broadcast/v1"
PROJECT = re.compile(r"^/projects/([A-Za-z0-9_-]{1,80})(?:/(.+))?$")
JOB = re.compile(r"^/jobs/([A-Za-z0-9_-]{1,80})(?:/(cancel))?$")
RELEASE = re.compile(r"^/releases/([A-Za-z0-9_-]{1,80})(?:/(film\.mp4|captions\.vtt|manifest\.json))?$")


class BroadcastRoutes:
    def __init__(self, workspace_root):
        self.service = BroadcastService(workspace_root)

    def dispatch_json(self, method, path, body=None, headers=None):
        """Return (status, JSON data). Binary media uses file() separately."""
        headers = headers or {}
        body = body or {}
        parsed = urlsplit(path)
        if not parsed.path.startswith(PREFIX + "/"):
            return None
        route = parsed.path[len(PREFIX):]
        service = self.service
        if method == "GET":
            if route == "/tactics":
                from .tactics import retrieve
                query = parse_qs(parsed.query, keep_blank_values=True)
                require(set(query) in ({"projectId", "at"}, {"projectId", "at", "q"}) and
                        all(len(items) == 1 for items in query.values()) and valid_id(query["projectId"][0]),
                        "invalid_request", "战术检索需要唯一的项目、时刻和可选关键词。", 422)
                try:
                    at = float(query["at"][0])
                except ValueError:
                    raise BroadcastError("invalid_request", "战术检索时刻无效。", 422)
                require(finite(at), "invalid_request", "战术检索时刻无效。", 422)
                project = service.get(query["projectId"][0])
                return 200, retrieve(project, service._frame_times(project), at, query.get("q", [""])[0])
            if route == "/capabilities":
                return 200, service.capabilities()
            if route == "/projects":
                return 200, service.list()
            match = PROJECT.fullmatch(route)
            if match and match.group(2) is None:
                return 200, service.get(match.group(1))
            match = JOB.fullmatch(route)
            if match and match.group(2) is None:
                return 200, service.job(match.group(1))
            match = RELEASE.fullmatch(route)
            if match and match.group(2) is None:
                return 200, service.release(match.group(1))
            raise BroadcastError("invalid_request", "未找到接口。", 404)
        require(method == "POST" and isinstance(body, dict), "invalid_request", "请求须为 JSON 对象。")
        if route == "/projects":
            require(set(body) == {"title", "mode"}, "invalid_request", "创建字段无效。")
            return 201, service.create(body["title"], body["mode"])
        match = re.fullmatch(r"/providers/([A-Za-z0-9_-]{1,80})/probe", route)
        if match:
            require(set(body) == {"projectId", "expectedRevision", "frameId", "scope"}, "invalid_request", "探针字段无效。")
            return 202, service.start_job(body["projectId"], body["expectedRevision"], "probe-provider", {"providerId": match.group(1), "scope": body["scope"], "frameId": body["frameId"], "strategy": "frames-first" if body["frameId"] else "video-first"}, headers.get("Idempotency-Key"))
        match = PROJECT.fullmatch(route)
        if match:
            pid, action = match.groups()
            require(action is not None, "invalid_request", "未找到接口。", 404)
            expected = body.get("expectedRevision")
            if action == "edit":
                require(set(body) == {"expectedRevision", "patch"}, "invalid_request", "编辑字段无效。")
                return 200, service.edit(pid, expected, body["patch"])
            if action == "metrics":
                require(set(body) == {"expectedRevision", "bundle"}, "invalid_request", "指标字段无效。")
                return 200, service.metrics(pid, expected, body["bundle"])
            if action == "frames":
                require(set(body) == {"expectedRevision", "times"}, "invalid_request", "抽帧字段无效。")
                return 200, service.frames(pid, expected, body["times"])
            if action == "observations/import":
                require(set(body) == {"expectedRevision", "bundle"}, "invalid_request", "观察导入字段无效。")
                return 200, service.import_observations(pid, expected, body["bundle"])
            if action == "cv/import":
                require(set(body) == {"expectedRevision", "result"}, "invalid_request", "CV 导入字段无效。")
                return 200, service.import_cv(pid, expected, body["result"])
            if action == "story":
                require({"expectedRevision", "audience", "mode", "providerId"} <= set(body) <= {"expectedRevision", "audience", "mode", "providerId", "commentaryStyle", "language"}, "invalid_request", "故事字段无效。")
                if body["mode"] == "model":
                    return 202, service.start_job(pid, expected, "model-story", {"audience": body["audience"], "providerId": body["providerId"], "commentaryStyle": body.get("commentaryStyle", "zh-analysis"), "language": body.get("language")}, headers.get("Idempotency-Key"))
                return 200, service.template_story(pid, expected, body["audience"], body["mode"], body["providerId"], body.get("commentaryStyle", "zh-analysis"), body.get("language"))
            if action == "review":
                require(set(body) in ({"expectedRevision", "actor", "checks", "note"}, {"expectedRevision", "actor", "checks", "note", "reviewerType"}), "invalid_request", "审核字段无效。")
                return 200, service.review(pid, expected, body["actor"], body["checks"], body["note"], body.get("reviewerType", "human"))
            if action == "render":
                require(set(body) == {"expectedRevision", "voiceMode", "voiceId"}, "invalid_request", "导出字段无效。")
                return 202, service.start_job(pid, expected, "render", {"voiceMode": body["voiceMode"], "voiceId": body["voiceId"]}, headers.get("Idempotency-Key"))
            if action == "analyze":
                require(set(body) == {"expectedRevision", "providerId", "scope", "strategy"}, "invalid_request", "分析字段无效。")
                return 202, service.start_job(pid, expected, "analyze", {"providerId": body["providerId"], "scope": body["scope"], "strategy": body["strategy"]}, headers.get("Idempotency-Key"))
            if action == "cv":
                require(set(body) == {"expectedRevision", "providerId", "scope"}, "invalid_request", "CV 字段无效。")
                return 202, service.start_job(pid, expected, "cv", {"providerId": body["providerId"], "scope": body["scope"]}, headers.get("Idempotency-Key"))
        match = JOB.fullmatch(route)
        if match and match.group(2) == "cancel":
            require(not body, "invalid_request", "取消不接收参数。")
            return 200, service.cancel(match.group(1))
        raise BroadcastError("invalid_request", "未找到接口。", 404)

    def file(self, path):
        if not path.startswith(PREFIX + "/"):
            return None
        route = path[len(PREFIX):]
        match = re.fullmatch(r"/media/([A-Za-z0-9_-]{1,80})", route)
        if match:
            directory = self.service.store.find("media", match.group(1))
            files = list(directory.glob("source.*"))
            require(len(files) == 1 and files[0].is_file() and not files[0].is_symlink(), "media_mismatch", "原片不可读取。", 404)
            return files[0], "video/mp4" if files[0].suffix == ".mp4" else "video/webm" if files[0].suffix == ".webm" else "video/quicktime" if files[0].suffix == ".mov" else "video/x-matroska"
        match = re.fullmatch(r"/frames/([A-Za-z0-9_-]{1,80})", route)
        if match:
            file = self.service.store.find("frames", match.group(1)) / "frame.png"
            return file, "image/png"
        match = RELEASE.fullmatch(route)
        if match and match.group(2):
            file = self.service.store.find("releases", match.group(1)) / match.group(2)
            require(file.is_file() and not file.is_symlink(), "invalid_request", "成片资源不存在。", 404)
            mime = {"film.mp4": "video/mp4", "captions.vtt": "text/vtt", "manifest.json": "application/json"}[match.group(2)]
            return file, mime
        return None
