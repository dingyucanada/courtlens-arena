#!/usr/bin/env python3
"""Serve CourtLens locally: python3 server.py --port 8765.

Only 127.0.0.1 is bound. Project videos and datasets are stored in the chosen
local workspace. The optional Arena model endpoint sends structured evidence to
the explicitly selected provider; original video bytes stay in this workspace.
"""

import argparse
import os
import signal
import json
import mimetypes
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from core.engine import analyze, ask
from core.adapters import blank_dataset, import_csv
from core.quality import quality_report
from core.workspace import Workspace, WorkspaceError
from core.arena_artifacts import ArenaArtifacts
from core.workspace_routes import WorkspaceRoutes, Response, FileResponse
from core.validation import ValidationError, validate_dataset

ROOT = Path(__file__).resolve().parent
VERSION = "4.0.0"
MAX_BODY_BYTES = 8 * 1024 * 1024


def reject_constant(value):
    raise ValueError("JSON 不允许非有限数字：" + value)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON 对象包含重复字段：" + key)
        result[key] = value
    return result


def parse_json(raw):
    return json.loads(raw, parse_constant=reject_constant, object_pairs_hook=unique_object)


class Handler(BaseHTTPRequestHandler):
    server_version = "CourtLens/" + VERSION
    sys_version = ""

    def log_message(self, format, *args):
        # Base logs only route and status, never posted datasets or questions.
        super().log_message(format, *args)

    def valid_host(self):
        host = self.headers.get("Host", "")
        return host in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")

    def send_json(self, body, status=200):
        raw = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.valid_host():
            return self.send_json({"error": "仅允许使用本机地址访问。"}, 403)
        route = urlsplit(self.path).path
        if route.startswith("/api/broadcast/v1/"):
            from core.broadcast.common import BroadcastError
            try:
                file = self.server.broadcast_routes.file(route)
                if file is not None:
                    return self.serve_file(*file, immutable=route.startswith("/api/broadcast/v1/releases/"))
                result = self.server.broadcast_routes.dispatch_json("GET", route)
                return self.send_json({"data": result[1]}, result[0])
            except BroadcastError as exc:
                return self.send_json({"error": exc.body()}, exc.status)
            except Exception:
                return self.send_json({"error": BroadcastError("schema_invalid", "广播资源读取失败。", 500).body()}, 500)
        if route == "/api/health":
            return self.send_json({"ok": True, "version": VERSION})
        if route == "/api/arena/capabilities":
            from core.arena_agent import capabilities
            return self.send_json(capabilities())
        if route == "/api/arena/voice-capabilities":
            from core.arena_voice import capabilities
            return self.send_json(capabilities())
        if route == "/api/demo":
            try:
                d = validate_dataset(parse_json((ROOT / "data" / "demo.json").read_text(encoding="utf-8")))
            except (OSError, ValueError, RecursionError) as exc:
                return self.send_json({"error": "演练数据不可用：" + str(exc)}, 500)
            return self.send_json(d)
        try:
            artifact_match = re.fullmatch(r"/api/arena/artifacts/([a-f0-9]{32})/(video|report)", route)
            if artifact_match:
                target, mime, filename = self.server.arena_artifacts.file(*artifact_match.groups())
                return self.serve_file(target, mime, filename, immutable=True)
            product_response=self.server.workspace_routes.dispatch_get(route)
            if product_response is not None:return self.send_product_response(product_response)
        except WorkspaceError as exc:
            return self.send_json({"error":str(exc),"code":exc.code},exc.status)
        except (OSError,ValueError) as exc:
            return self.send_json({"error":"本地项目读取失败，请检查工作目录与文件完整性。"},500)
        if route.startswith("/api/"):
            return self.send_json({"error": "未找到接口。"}, 404)
        self.serve_static(route)

    def serve_static(self, route):
        decoded = unquote(route)
        if decoded in ("/studio", "/arena", "/broadcast"):
            self.send_response(302)
            self.send_header("Location", decoded+"/")
            self.send_header("Content-Length", "0")
            self.security_headers()
            self.end_headers()
            return
        if decoded.startswith("/studio/"):
            directory, relative = ROOT / "site-dist", decoded[len("/studio/"):] or "studio.html"
        elif decoded.startswith("/arena/"):
            directory, relative = ROOT / "site-dist", decoded[len("/arena/"):] or "arena.html"
        elif decoded.startswith("/broadcast/"):
            directory, relative = ROOT / "site-dist" / "broadcast", decoded[len("/broadcast/"):] or "index.html"
        elif decoded in ("", "/"):
            directory, relative = ROOT / "site-dist", "index.html"
        elif decoded.startswith("/pro/"):
            directory, relative = ROOT / "site-dist" / "pro", decoded[len("/pro/"):]
        elif decoded in ("/studio.html", "/demo.html", "/presentation.pptx", "/favicon.svg"):
            directory, relative = ROOT / "site-dist", decoded.lstrip("/")
        elif decoded.startswith("/media/"):
            directory, relative = ROOT / "media", decoded[len("/media/"):]
        elif decoded.startswith("/templates/"):
            directory, relative = ROOT / "templates", decoded[len("/templates/"):]
        elif decoded.startswith("/data/"):
            directory, relative = ROOT / "data", decoded[len("/data/"):]
        else:
            directory, relative = ROOT / "web", decoded.lstrip("/")
        try:
            target = (directory / relative).resolve()
            target.relative_to(directory.resolve())
        except (ValueError, OSError):
            return self.send_json({"error": "无效文件路径。"}, 404)
        allowed = {".html", ".css", ".js", ".mjs", ".pptx", ".json", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".mp4", ".webm", ".vtt", ".woff", ".woff2", ".csv"}
        if not target.is_file() or target.suffix.lower() not in allowed:
            return self.send_json({"error": "文件不存在。"}, 404)
        return self.serve_file(target)

    def send_product_response(self,response):
        if isinstance(response,FileResponse):
            return self.serve_file(response.path,response.content_type,response.download_name)
        return self.send_json(response.body,response.status)

    def serve_file(self,target,content_type=None,download_name=None,immutable=False):
        target=Path(target)
        if not target.is_file():return self.send_json({"error":"文件不存在。"},404)
        size = target.stat().st_size
        start, end, status = 0, size - 1, 200
        requested = self.headers.get("Range")
        if requested:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
            if not match or not any(match.groups()):
                return self.range_error(size)
            left, right = match.groups()
            if left:
                start = int(left)
                end = min(int(right), size - 1) if right else size - 1
            else:
                suffix = int(right)
                if suffix <= 0:
                    return self.range_error(size)
                start, end = max(0, size - suffix), size - 1
            if start > end or start >= size:
                return self.range_error(size)
            status = 206
        self.send_response(status)
        content_type = content_type or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if download_name:
            from urllib.parse import quote
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''"+quote(download_name))
        if content_type.startswith("text/") or target.suffix in (".js", ".json"):
            content_type += "; charset=utf-8"
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(max(0, end - start + 1)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=31536000, immutable" if immutable else "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.security_headers()
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with target.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Browser changed the selected video or seek position.

    def range_error(self, size):
        self.send_response(416)
        self.send_header("Content-Range", f"bytes */{size}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if not self.valid_host():
            return self.send_json({"error": "仅允许使用本机地址访问。"}, 403)
        origin = self.headers.get("Origin")
        allowed_origins = (f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}")
        if origin and origin not in allowed_origins:
            return self.send_json({"error": "拒绝跨站请求；请从本机 CourtLens 页面操作。"}, 403)
        route = urlsplit(self.path).path
        broadcast_media = re.fullmatch(r"/api/broadcast/v1/projects/([A-Za-z0-9_-]{1,80})/media", route)
        if broadcast_media:
            from core.broadcast.common import BroadcastError
            if self.headers.get("Transfer-Encoding"):
                return self.send_json({"error": BroadcastError("invalid_request", "上传需要准确 Content-Length。").body()}, 400)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                expected = int(self.headers.get("If-Match", ""))
                self.connection.settimeout(120)
                result = self.server.broadcast_routes.service.upload(broadcast_media.group(1), expected, self.rfile, length, self.headers.get("X-Filename", "video.mp4"), self.headers.get_content_type())
                return self.send_json({"data": result}, 201)
            except (TypeError, ValueError):
                return self.send_json({"error": BroadcastError("invalid_request", "If-Match 或 Content-Length 无效。").body()}, 400)
            except BroadcastError as exc:
                return self.send_json({"error": exc.body()}, exc.status)
            except (OSError, TimeoutError):
                return self.send_json({"error": BroadcastError("media_unreadable", "上传读取失败。", 422).body()}, 422)
            except Exception:
                return self.send_json({"error": BroadcastError("media_unreadable", "上传失败。", 500).body()}, 500)
        if re.fullmatch(r'/api/projects/[a-f0-9]{32}/media',route):
            if self.headers.get("Transfer-Encoding"):
                return self.send_json({"error":"媒体导入需要确定的文件长度。"},400)
            try:
                length=int(self.headers.get("Content-Length","0"))
                revision=int(self.headers.get("X-Expected-Revision","0"))
                self.connection.settimeout(60)
                response=self.server.workspace_routes.dispatch_media(route,self.rfile,length,unquote(self.headers.get("X-Filename","video.mp4")),revision,self.headers.get_content_type())
                if response is None:return self.send_json({"error":"项目不存在。"},404)
                return self.send_product_response(response)
            except WorkspaceError as exc:return self.send_json({"error":str(exc),"code":exc.code},exc.status)
            except (ValueError,TimeoutError,OSError):return self.send_json({"error":"媒体导入失败：请核对文件、长度、项目版本及本机磁盘空间。"},400)
        if self.headers.get_content_type() != "application/json":
            return self.send_json({"error": "请求必须使用 application/json。"}, 415)
        if self.headers.get("Transfer-Encoding"):
            return self.send_json({"error": "不支持分块请求体。"}, 400)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json({"error": "无效 Content-Length。"}, 400)
        if length <= 0:
            return self.send_json({"error": "请求体不能为空。"}, 400)
        arena_video_route = route in ("/api/arena/narrate", "/api/arena/export-video")
        body_limit = 96 * 1024 * 1024 if arena_video_route else MAX_BODY_BYTES
        if length > body_limit:
            return self.send_json({"error": f"JSON 超过 {body_limit // (1024 * 1024)} MiB 限制；请缩短视频片段或降低轨迹采样率。"}, 413)
        try:
            self.connection.settimeout(60 if arena_video_route else 15)
            raw = self.rfile.read(length)
            if len(raw) != length:
                return self.send_json({"error": "请求体不完整。"}, 400)
            try:
                body = parse_json(raw)
            except (ValueError, UnicodeDecodeError, RecursionError):
                if route.startswith("/api/broadcast/v1/"):
                    from core.broadcast.common import BroadcastError
                    return self.send_json({"error": BroadcastError("invalid_request", "JSON 无效。", 400).body()}, 400)
                raise
            if not isinstance(body, dict):
                if route.startswith("/api/broadcast/v1/"):
                    from core.broadcast.common import BroadcastError
                    return self.send_json({"error": BroadcastError("invalid_request", "请求必须是 JSON 对象。", 400).body()}, 400)
                raise ValidationError("request", "请求必须是对象")
            if route.startswith("/api/broadcast/v1/"):
                from core.broadcast.common import BroadcastError
                try:
                    result = self.server.broadcast_routes.dispatch_json("POST", route, body, dict(self.headers))
                    return self.send_json({"data": result[1]}, result[0])
                except BroadcastError as exc:
                    return self.send_json({"error": exc.body()}, exc.status)
                except Exception:
                    return self.send_json({"error": BroadcastError("schema_invalid", "广播请求处理失败。", 500).body()}, 500)
            if route == "/api/arena/export-video":
                try:
                    return self.send_json(self.server.arena_artifacts.save(body), 201)
                except OSError:
                    return self.send_json({"error": "本机成片保存失败；请检查工作目录与可用磁盘空间。", "code": "artifact_write_failed"}, 500)
            if route == "/api/arena/narrate":
                from core.arena_voice import narrate, ArenaVoiceError
                try:
                    result = narrate(body)
                except ArenaVoiceError as exc:
                    return self.send_json(exc.as_dict(), exc.status)
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(result.video_bytes)))
                self.send_header("Content-Disposition", 'attachment; filename="courtlens-arena-narrated.mp4"')
                self.send_header("Cache-Control", "no-store")
                for key, value in result.response_headers().items():
                    self.send_header(key, value)
                self.security_headers()
                self.end_headers()
                try:
                    self.wfile.write(result.video_bytes)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if route=="/api/arena/agent":
                from core.arena_agent import run, ArenaAgentError
                try:return self.send_json(run(body))
                except ArenaAgentError as exc:return self.send_json(exc.as_dict(),exc.status)
            if route=="/api/quality":return self.send_json({"report":quality_report(body.get("dataset"))})
            if route=="/api/new-dataset":return self.send_json({"dataset":blank_dataset(body.get("video"),body.get("game"),body.get("source"))})
            if route=="/api/adapt/csv":return self.send_json(import_csv(body.get("csv"),body.get("video"),body.get("game"),body.get("source"),body.get("leverage_semantics")))
            product_response=self.server.workspace_routes.dispatch_post(route,body)
            if product_response is not None:return self.send_product_response(product_response)
            if route not in ("/api/analyze","/api/ask"):return self.send_json({"error":"未找到接口。"},404)
            if "dataset" not in body:
                raise ValidationError("dataset", "缺少数据集")
            audience = body.get("audience", "fan")
            if route == "/api/analyze":
                response = analyze(body["dataset"], audience)
            else:
                response = ask(body["dataset"], body.get("question"), body.get("possession_id"), audience)
            return self.send_json(response)
        except WorkspaceError as exc:
            return self.send_json({"error":str(exc),"code":exc.code},exc.status)
        except ValidationError as exc:
            return self.send_json({"error": str(exc), "path": exc.path}, 400)
        except (ValueError, UnicodeDecodeError, RecursionError) as exc:
            return self.send_json({"error": "JSON 无效：" + str(exc)}, 400)
        except TimeoutError:
            return self.send_json({"error": "读取请求超时。"}, 408)


class CourtLensServer(ThreadingHTTPServer):
    def server_close(self):
        super().server_close()
        if hasattr(self,"workspace_routes"):
            close=getattr(self.workspace_routes,"close",None)
            if close:close()

def create_server(port=8765,workspace_root=None,render_python=None):
    server = CourtLensServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    try:
        workspace = Workspace(workspace_root or ROOT/"workspace",app_root=ROOT,render_python=render_python)
        server.arena_artifacts = ArenaArtifacts(workspace.root, ffprobe=workspace.ffprobe)
        server.workspace_routes = WorkspaceRoutes(workspace)
        from core.broadcast.routes import BroadcastRoutes
        server.broadcast_routes = BroadcastRoutes(workspace.root)
    except BaseException:
        server.server_close()
        raise
    return server


def main():
    parser = argparse.ArgumentParser(description="CourtLens 本地证据分析演练")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--workspace",default=str(ROOT/"workspace"),help="项目、历史版本与媒体保存目录")
    parser.add_argument("--render-python",default=os.environ.get("COURTLENS_RENDER_PYTHON"),help="含Pillow的渲染Python解释器")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port 必须介于 1 和 65535")
    server = create_server(args.port,Path(args.workspace).expanduser().resolve(),args.render_python)
    def shutdown_signal(signum,frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,shutdown_signal)
    print(f"CourtLens ready: http://127.0.0.1:{server.server_port} (Broadcast video studio)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
