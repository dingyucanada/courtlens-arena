"""Atomic local project and immutable artifact storage. Paths only contain server IDs."""
import json
import os
import threading
from pathlib import Path

from .common import BroadcastError, valid_id


class BroadcastStore:
    def __init__(self, workspace_root):
        self.root = Path(workspace_root).resolve() / "broadcast"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def project_dir(self, project_id):
        if not valid_id(project_id):
            raise BroadcastError("invalid_request", "项目 ID 无效。")
        candidate = self.root / project_id
        if candidate.is_symlink() or candidate.resolve() != candidate or candidate.resolve().parent != self.root:
            raise BroadcastError("invalid_request", "项目路径无效。", 403)
        return candidate

    def read(self, project_id):
        try:
            return json.loads((self.project_dir(project_id) / "project.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise BroadcastError("invalid_request", "项目不存在。", 404)
        except (OSError, ValueError):
            raise BroadcastError("schema_invalid", "项目文件损坏。", 500)

    def write(self, project):
        directory = self.project_dir(project["id"])
        directory.mkdir(parents=True, exist_ok=True)
        self.atomic(directory / "project.json", project)

    @staticmethod
    def atomic(path, value):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name("." + path.name + "." + os.urandom(8).hex())
        try:
            with tmp.open("x", encoding="utf-8") as out:
                json.dump(value, out, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)

    def list_projects(self):
        result = []
        for path in self.root.glob("*/project.json"):
            try:
                p = json.loads(path.read_text(encoding="utf-8"))
                result.append({"id": p["id"], "title": p["title"], "revision": p["revision"], "updatedAt": p["updatedAt"], "hasMedia": p["media"] is not None, "latestReleaseId": p["releases"][-1]["id"] if p["releases"] else None})
            except (KeyError, OSError, ValueError):
                continue
        return sorted(result, key=lambda p: p["updatedAt"], reverse=True)

    def find(self, category, item_id):
        if category not in ("jobs", "media", "frames", "releases") or not valid_id(item_id):
            raise BroadcastError("invalid_request", "资源 ID 无效。")
        for directory in self.root.iterdir():
            if directory.is_dir() and valid_id(directory.name):
                if directory.is_symlink() or directory.resolve() != directory:
                    continue
                candidate = directory / category / item_id
                if candidate.exists() and candidate.is_dir() and not candidate.is_symlink() and candidate.resolve().is_relative_to(self.root) and not candidate.parent.is_symlink():
                    return candidate
        raise BroadcastError("invalid_request", "资源不存在。", 404)
