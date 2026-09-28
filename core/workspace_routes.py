"""HTTP-neutral hooks for the existing local server.

Initialize ONCE, not per request::

    workspace = Workspace(data_root, app_root=ROOT, render_python=bundled_python)
    routes = WorkspaceRoutes(workspace)
    response = routes.dispatch_get(urlsplit(self.path).path)
    # None => fall through; Response => send_json(body, status).
    # FileResponse => existing controlled file/Range sender, attachment when
    # download_name is not None. Never expose workspace as a static directory.

JSON POSTs use dispatch_post(route, body). Raw /media uploads use
dispatch_media(route, self.rfile, length, unquote(X-Filename), revision, mime).
Catch WorkspaceError and send {error: exc.message, code: exc.code}, exc.status;
existing ValidationError remains 400. Call routes.close() on server shutdown.
"""

from dataclasses import dataclass
from pathlib import Path
import re

from .jobs import JobManager
from .workspace import WorkspaceError


@dataclass(frozen=True)
class Response:
    status: int
    body: dict


@dataclass(frozen=True)
class FileResponse:
    path: Path
    content_type: str
    download_name: str = None


class WorkspaceRoutes:
    def __init__(self, workspace, jobs=None):
        self.workspace = workspace
        self.jobs = jobs or JobManager(workspace)

    def close(self):
        self.jobs.close()

    def dispatch_get(self, route):
        if route == "/api/capabilities":
            return Response(200, self.workspace.capabilities())
        if route == "/api/projects":
            return Response(200, {"projects": self.workspace.list_projects()})
        match = re.fullmatch(r"/api/projects/([^/]+)(?:/(history|media|jobs))?", route)
        if match:
            project_id, action = match.groups()
            if action == "history":
                return Response(200, {"revisions": self.workspace.history(project_id)})
            if action == "media":
                path, mime = self.workspace.media_file(project_id)
                return FileResponse(path, mime)
            if action == "jobs":
                return Response(200, {"jobs": self.jobs.list_jobs(project_id)})
            return Response(200, {"project": self.workspace.get_project(project_id)})
        match = re.fullmatch(r"/api/jobs/([^/]+)(?:/files/([^/]+))?", route)
        if match:
            job_id, name = match.groups()
            if name:
                path, mime = self.jobs.file(job_id, name)
                return FileResponse(path, mime, name)
            return Response(200, {"job": self.jobs.get_job(job_id)})
        return None

    def dispatch_post(self, route, body):
        if not isinstance(body, dict):
            raise WorkspaceError(400, "请求必须是 JSON 对象。", "invalid_request")
        if route == "/api/projects":
            return Response(201, {"project": self.workspace.create_project(body.get("name"), body.get("dataset"))})
        match = re.fullmatch(r"/api/projects/([^/]+)/(save|restore|export)", route)
        if match:
            project_id, action = match.groups()
            expected = body.get("expected_revision")
            if action == "save":
                return Response(200, {"project": self.workspace.save_project(project_id, body.get("name"), body.get("dataset"), expected)})
            if action == "restore":
                return Response(200, {"project": self.workspace.restore_project(project_id, body.get("revision"), expected)})
            return Response(202, {"job": self.jobs.enqueue(project_id, expected, body.get("audience", "fan"), voice=body.get("voice", False))})
        match = re.fullmatch(r"/api/jobs/([^/]+)/cancel", route)
        if match:
            return Response(200, {"job": self.jobs.cancel(match.group(1))})
        return None

    def dispatch_media(self, route, stream, length, filename, expected_revision, content_type=None):
        match = re.fullmatch(r"/api/projects/([^/]+)/media", route)
        if not match:
            return None
        project = self.workspace.import_media(match.group(1), stream, length, filename, expected_revision, content_type)
        return Response(200, {"project": project})
