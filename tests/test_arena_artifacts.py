"""Local export boundary tests and real MP4/WebM HTTP delivery checks."""

import base64
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import http.client
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from core import arena_artifacts as artifacts
from core.workspace import WorkspaceError


FAKE_VIDEO = b"\x1a\x45\xdf\xa3fixture-webm"


def request_body(video=FAKE_VIDEO, filename="courtlens-arena.webm"):
    return {"videoBase64": base64.b64encode(video).decode("ascii"), "filename": filename,
            "report": {"kind": "synthetic", "sourceAuthenticated": False,
                       "cueFrameAlignmentVerified": False, "durationSeconds": 1}}


class ArtifactRequestTests(unittest.TestCase):
    def error(self, body, code=None, status=None):
        with self.assertRaises(WorkspaceError) as caught:
            artifacts.validate_request(body)
        if code:
            self.assertEqual(caught.exception.code, code)
        if status:
            self.assertEqual(caught.exception.status, status)

    def test_normalized_request_does_not_mutate_client_report(self):
        body = request_body()
        original = deepcopy(body)
        video, filename, report, extension, demuxer, mime = artifacts.validate_request(body)
        report["kind"] = "changed"
        self.assertEqual(body, original)
        self.assertEqual((video, filename, extension, demuxer, mime),
                         (FAKE_VIDEO, body["filename"], "webm", "matroska", "video/webm"))

    def test_strict_base64_rejects_empty_whitespace_non_ascii_and_noncanonical(self):
        for encoded in ("", "!", "汉", "YQ==\n", "YR==", "YWJj=", "data:video/webm;base64,YQ==", 42):
            with self.subTest(encoded=encoded):
                body = request_body()
                body["videoBase64"] = encoded
                self.error(body, "invalid_video_base64")

    def test_decoded_and_encoded_size_limits(self):
        with patch.object(artifacts, "MAX_VIDEO_BYTES", 10):
            for video in (b"x" * 11, b"x" * 13):
                with self.subTest(size=len(video)):
                    self.error(request_body(video), "video_too_large", 413)

    def test_filename_cannot_select_paths_or_inject_headers(self):
        for name in ("../out.webm", "/out.webm", "C:\\out.webm", "out/webm.webm", "x\r\nX-Header: yes.webm",
                     "x\x00.webm", " x.webm", "x.webm ", "x" * 121, "out.txt", None):
            with self.subTest(name=name):
                body = request_body()
                body["filename"] = name
                self.error(body, "invalid_filename")

    def test_unknown_fields_and_input_paths_are_rejected(self):
        for extra in ("path", "videoPath", "outputPath", "url", "mimeType"):
            body = request_body()
            body[extra] = "/arbitrary/file"
            self.error(body)
        self.error([])

    def test_format_signature_and_filename_must_agree(self):
        self.error(request_body(b"#EXTM3U\nfile:///etc/passwd"), "invalid_video")
        self.error(request_body(filename="out.mp4"), "filename_format_mismatch")
        self.error(request_body(b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00", "out.webm"), "filename_format_mismatch")

    def test_report_is_bounded_finite_simple_json(self):
        invalid = [[], {"value": float("nan")}, {"value": float("inf")}, {"value": 10 ** 500},
                   {"value": object()}, {"value": [0] * 4001}, {"x" * 161: 1}, {"value": "\ud800"}]
        nested = {}
        for _ in range(18):
            nested = {"nested": nested}
        invalid.append(nested)
        for report in invalid:
            with self.subTest(report=str(report)[:50]):
                body = request_body()
                body["report"] = report
                self.error(body)
        body = request_body()
        body["report"] = {"text": "x" * artifacts.MAX_REPORT_BYTES}
        self.error(body, "report_too_large", 413)

    def test_report_cannot_assert_authenticated_or_verified_sources(self):
        for name in ("sourceAuthenticated", "source_verified", "cueFrameAlignmentVerified", "serverVerified"):
            for value in (True, 1, "verified"):
                body = request_body()
                body["report"] = {"nested": {name: value}}
                self.error(body, "unverified_report_claim")

    def test_report_cannot_persist_credentials_or_input_output_paths(self):
        for name in ("apiKey", "Authorization", "access_token", "password", "videoPath", "inputPath", "outputPath"):
            body = request_body()
            body["report"] = {"nested": {name: "sensitive fixture"}}
            self.error(body, "invalid_report")


class ArtifactStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="arena-artifacts-test-")
        self.workspace = Path(self.temp.name)
        self.store = artifacts.ArenaArtifacts(self.workspace)
        self.probe = patch.object(artifacts.ArenaArtifacts, "probe_video", return_value={
            "durationSeconds": 1.0, "width": 64, "height": 48, "codec": "vp9"})
        self.probe.start()

    def tearDown(self):
        self.probe.stop()
        self.temp.cleanup()

    def save(self):
        return self.store.save(request_body())

    def test_atomic_save_fingerprint_persistence_and_unverified_sidecar(self):
        result = self.save()
        identifier = result["url"].split("/")[-2]
        self.assertRegex(identifier, r"^[a-f0-9]{32}$")
        self.assertEqual(result["bytes"], len(FAKE_VIDEO))
        self.assertEqual(result["sha256"], hashlib.sha256(FAKE_VIDEO).hexdigest())
        reopened = artifacts.ArenaArtifacts(self.workspace)
        path, mime, filename = reopened.file(identifier)
        self.assertEqual((path.read_bytes(), mime, filename), (FAKE_VIDEO, "video/webm", request_body()["filename"]))
        report_path, _, report_name = reopened.file(identifier, "report")
        record = json.loads(report_path.read_bytes())
        self.assertFalse(record["sourceAuthenticated"])
        self.assertFalse(record["cueFrameAlignmentVerified"])
        self.assertEqual(record["clientReport"], request_body()["report"])
        self.assertTrue(report_name.endswith(".report.json"))
        self.assertEqual([path.name for path in self.store.root.iterdir()], [identifier])

    def test_successful_exports_get_distinct_immutable_identifiers(self):
        first, second = self.save(), self.save()
        self.assertNotEqual(first["url"], second["url"])
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual(len(list(self.store.root.iterdir())), 2)

    def test_failed_probe_never_publishes_or_leaks_temporary_video(self):
        with patch.object(self.store, "probe_video", side_effect=WorkspaceError(422, "bad video")):
            with self.assertRaises(WorkspaceError):
                self.save()
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_failed_sidecar_write_removes_only_incomplete_export(self):
        first = self.save()
        original = self.store._write
        def fail(path, raw):
            if path.name == "report.json":
                raise OSError("injected disk error")
            original(path, raw)
        with patch.object(self.store, "_write", side_effect=fail):
            with self.assertRaises(OSError):
                self.save()
        identifier = first["url"].split("/")[-2]
        self.assertEqual([path.name for path in self.store.root.iterdir()], [identifier])
        self.assertEqual(self.store.file(identifier)[0].read_bytes(), FAKE_VIDEO)

    def test_count_quota_preserves_existing_video(self):
        self.store.max_artifacts = 1
        first = self.save()
        with self.assertRaises(WorkspaceError) as caught:
            self.save()
        self.assertEqual((caught.exception.code, caught.exception.status), ("arena_artifact_quota", 507))
        self.assertIn("整理", str(caught.exception))
        self.assertEqual(self.store.file(first["url"].split("/")[-2])[0].read_bytes(), FAKE_VIDEO)

    def test_byte_quota_counts_sidecar_and_never_evicts(self):
        self.store.max_bytes = len(FAKE_VIDEO) + 1
        with self.assertRaises(WorkspaceError) as caught:
            self.save()
        self.assertEqual(caught.exception.code, "arena_artifact_quota")
        self.assertEqual(list(self.store.root.iterdir()), [])
        self.store.max_bytes = len(FAKE_VIDEO) - 1
        with self.assertRaises(WorkspaceError):
            self.save()

    def test_concurrent_instances_share_quota_lock(self):
        first = artifacts.ArenaArtifacts(self.workspace, max_artifacts=1)
        second = artifacts.ArenaArtifacts(self.workspace, max_artifacts=1)
        barrier = threading.Barrier(2)
        def run(store):
            barrier.wait(timeout=5)
            try:
                return store.save(request_body())["url"]
            except WorkspaceError as exc:
                return exc.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(run, (first, second)))
        self.assertEqual(outcomes.count(507), 1)
        self.assertEqual(sum(isinstance(outcome, str) for outcome in outcomes), 1)
        self.assertEqual(len(list(self.store.root.iterdir())), 1)

    def test_unpublished_crash_leftover_consumes_quota_without_eviction(self):
        pending = self.store.root / ".pending-crash"
        pending.mkdir()
        (pending / "video.webm").write_bytes(FAKE_VIDEO)
        self.store.max_artifacts = 1
        with self.assertRaises(WorkspaceError) as caught:
            self.save()
        self.assertEqual(caught.exception.code, "arena_artifact_quota")
        self.assertEqual((pending / "video.webm").read_bytes(), FAKE_VIDEO)

    def test_path_traversal_and_unknown_ids_never_read_local_files(self):
        outside = self.workspace / "outside.txt"
        outside.write_text("private fixture")
        for identifier in ("../outside.txt", "0" * 32, ".pending-crash", "A" * 32, "/etc/passwd"):
            with self.subTest(identifier=identifier), self.assertRaises(WorkspaceError) as caught:
                self.store.file(identifier)
            self.assertEqual(caught.exception.status, 404)
        self.assertEqual(outside.read_text(), "private fixture")

    def test_symlinked_root_directory_and_video_are_rejected(self):
        result = self.save()
        identifier = result["url"].split("/")[-2]
        video = self.store.file(identifier)[0]
        outside = self.workspace / "outside.webm"
        outside.write_bytes(FAKE_VIDEO)
        video.unlink()
        video.symlink_to(outside)
        with self.assertRaises(WorkspaceError) as caught:
            self.store.file(identifier)
        self.assertEqual(caught.exception.status, 404)
        with self.assertRaises(WorkspaceError):
            self.save()
        other = self.workspace / "other"
        other.mkdir()
        (other / "arena_artifacts").symlink_to(self.store.root, target_is_directory=True)
        with self.assertRaises(WorkspaceError) as caught:
            artifacts.ArenaArtifacts(other)
        self.assertEqual(caught.exception.code, "unsafe_artifact_storage")
        self.assertEqual(outside.read_bytes(), FAKE_VIDEO)

    def test_symlinked_artifact_or_sidecar_is_not_served(self):
        result = self.save()
        identifier = result["url"].split("/")[-2]
        directory = self.store.root / identifier
        outside = self.workspace / "private-report.json"
        outside.write_text("private fixture")
        report = directory / "report.json"
        report.unlink()
        report.symlink_to(outside)
        with self.assertRaises(WorkspaceError):
            self.store.file(identifier)
        link = self.store.root / ("f" * 32)
        link.symlink_to(directory, target_is_directory=True)
        with self.assertRaises(WorkspaceError):
            self.store.file(link.name)


class ArtifactProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="arena-probe-test-")
        self.store = artifacts.ArenaArtifacts(self.temp.name, ffprobe="/tools/ffprobe")
        self.path = self.store.root / "video.webm"
        self.path.write_bytes(FAKE_VIDEO)
        self.available = patch.object(artifacts, "executable_available", return_value=True)
        self.available.start()
        self.info = {"format": {"format_name": "matroska,webm", "duration": "1"}, "streams": [{
            "index": 0, "codec_type": "video", "codec_name": "vp9", "width": 64,
            "height": 48, "avg_frame_rate": "10/1"}]}
        self.packets = {"packets": [{"pts_time": "0", "duration_time": "0.1"},
                                    {"pts_time": "0.9", "duration_time": "0.1"}]}
        self.frames = {"streams": [{"nb_read_frames": "10"}]}

    def tearDown(self):
        self.available.stop()
        self.temp.cleanup()

    def probe(self, info=None, packets=None, frames=None):
        with patch.object(self.store, "_probe_output", side_effect=[
            info or self.info, packets or self.packets, frames or self.frames]) as run:
            result = self.store.probe_video(self.path, "webm", "matroska")
            for (command,), _ in run.call_args_list:
                self.assertEqual(command[command.index("-protocol_whitelist") + 1], "file,pipe")
                self.assertEqual(command[command.index("-f") + 1], "matroska")
            return result

    def test_known_codec_actual_timeline_and_decode_are_required(self):
        self.assertEqual(self.probe()["durationSeconds"], 1)
        self.assertEqual(self.probe()["codec"], "vp9")

    def test_mediarecorder_missing_duration_and_zero_frame_rate_are_supported(self):
        info = deepcopy(self.info)
        del info["format"]["duration"]
        info["streams"][0]["avg_frame_rate"] = "0/0"
        self.assertEqual(self.probe(info)["durationSeconds"], 1)

    def test_excessive_container_duration_unknown_codec_and_oversized_dimensions(self):
        variants = []
        for field, value in (("codec_name", "unknown"), ("width", 100000), ("codec_type", "audio")):
            info = deepcopy(self.info)
            info["streams"][0][field] = value
            variants.append(info)
        for duration in ("nan", "186", "0"):
            info = deepcopy(self.info)
            info["format"]["duration"] = duration
            variants.append(info)
        for info in variants:
            with self.subTest(info=info), self.assertRaises(WorkspaceError):
                self.probe(info)

    def test_actual_video_duration_cannot_use_shorter_client_or_container_duration(self):
        packets = {"packets": [{"pts_time": "0", "duration_time": "0.1"},
                               {"pts_time": "185", "duration_time": "0.1"}]}
        with self.assertRaises(WorkspaceError) as caught:
            self.probe(packets=packets)
        self.assertEqual(caught.exception.code, "invalid_video_timeline")

    def test_no_frames_nonfinite_timestamps_and_large_indices_are_rejected(self):
        with self.assertRaises(WorkspaceError) as caught:
            self.probe(frames={"streams": [{"nb_read_frames": "0"}]})
        self.assertEqual(caught.exception.code, "invalid_video_frames")
        for rows in ([{"pts_time": "nan"}], [{}], [{"pts_time": "0"}] * 25001):
            with self.assertRaises(WorkspaceError):
                self.probe(packets={"packets": rows})

    def test_missing_ffprobe_is_descriptive(self):
        with patch.object(artifacts, "executable_available", return_value=False):
            with self.assertRaises(WorkspaceError) as caught:
                self.store.probe_video(self.path, "webm", "matroska")
        self.assertEqual((caught.exception.status, caught.exception.code), (503, "ffprobe_unavailable"))


class ArtifactRealHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise unittest.SkipTest("Real artifact HTTP tests require FFmpeg and FFprobe")
        cls.fixtures = tempfile.TemporaryDirectory(prefix="arena-real-video-")
        cls.videos = {}
        for extension, codec in (("mp4", "libx264"), ("webm", "libvpx-vp9")):
            path = Path(cls.fixtures.name) / ("fixture." + extension)
            subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                            "color=c=navy:s=64x48:r=10:d=1", "-c:v", codec, "-pix_fmt", "yuv420p",
                            str(path)], check=True, capture_output=True, timeout=20)
            cls.videos[extension] = path.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        from server import create_server
        self.temp = tempfile.TemporaryDirectory(prefix="arena-http-workspace-")
        try:
            self.server = create_server(0, self.temp.name)
        except PermissionError:
            self.temp.cleanup()
            raise unittest.SkipTest("Localhost socket permissions required for real HTTP checks")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()
        self.temp.cleanup()

    def request(self, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        headers = dict(headers or {})
        if body is not None:
            body = json.dumps(body).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def export(self, extension="mp4"):
        body = request_body(self.videos[extension], "篮球成片." + extension)
        status, _, raw = self.request("/api/arena/export-video", "POST", body)
        self.assertEqual(status, 201, raw)
        return json.loads(raw)

    def test_real_mp4_and_webm_upload_download_fingerprints(self):
        for extension in ("mp4", "webm"):
            with self.subTest(extension=extension):
                result = self.export(extension)
                status, headers, video = self.request(result["url"])
                self.assertEqual(status, 200)
                self.assertEqual(video, self.videos[extension])
                self.assertEqual(headers["Content-Type"], "video/" + extension)
                self.assertIn("immutable", headers["Cache-Control"])
                self.assertIn("attachment; filename*=UTF-8''", headers["Content-Disposition"])
                self.assertEqual(result["sha256"], hashlib.sha256(video).hexdigest())
                self.assertEqual(result["bytes"], len(video))

    def test_real_range_head_and_unsatisfiable_range(self):
        result = self.export()
        status, headers, video = self.request(result["url"], headers={"Range": "bytes=4-15"})
        self.assertEqual((status, video), (206, self.videos["mp4"][4:16]))
        self.assertEqual(headers["Content-Range"], f"bytes 4-15/{len(self.videos['mp4'])}")
        status, headers, video = self.request(result["url"], headers={"Range": "bytes=-8"})
        self.assertEqual((status, video), (206, self.videos["mp4"][-8:]))
        status, headers, video = self.request(result["url"], "HEAD")
        self.assertEqual((status, video), (200, b""))
        self.assertEqual(int(headers["Content-Length"]), len(self.videos["mp4"]))
        status, headers, video = self.request(result["url"], headers={"Range": "bytes=999999-"})
        self.assertEqual((status, video), (416, b""))

    def test_report_sidecar_and_unknown_paths(self):
        result = self.export()
        status, headers, raw = self.request(result["url"].removesuffix("video") + "report")
        self.assertEqual(status, 200)
        report = json.loads(raw)
        self.assertEqual(report["sha256"], result["sha256"])
        self.assertFalse(report["sourceAuthenticated"])
        for path in ("/api/arena/artifacts/../workspace.sqlite3/video", "/api/arena/artifacts/" + "0" * 32 + "/video"):
            status, _, _ = self.request(path)
            self.assertEqual(status, 404)

    def test_host_origin_and_json_content_type_policy_are_preserved(self):
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"}):
            status, _, _ = self.request("/api/arena/export-video", "POST", request_body(), headers)
            self.assertEqual(status, 403)
        result = self.export()
        status, _, _ = self.request(result["url"], headers={"Host": "evil.example"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("/api/arena/export-video", "POST", request_body(), {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)

    def test_request_budget_chunked_body_and_invalid_base64_fail_as_json(self):
        status, headers, raw = self.request("/api/arena/export-video", "POST", headers={
            "Content-Type": "application/json", "Content-Length": str(artifacts.MAX_JSON_BYTES + 1)})
        self.assertEqual(status, 413)
        self.assertIn("application/json", headers["Content-Type"])
        status, _, _ = self.request("/api/arena/export-video", "POST", headers={
            "Content-Type": "application/json", "Transfer-Encoding": "chunked"})
        self.assertEqual(status, 400)
        body = request_body()
        body["videoBase64"] = "!"
        status, _, raw = self.request("/api/arena/export-video", "POST", body)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)["code"], "invalid_video_base64")

    def test_quota_http_error_preserves_existing_download(self):
        self.server.arena_artifacts.max_artifacts = 1
        first = self.export()
        status, _, raw = self.request("/api/arena/export-video", "POST", request_body(self.videos["mp4"], "next.mp4"))
        self.assertEqual(status, 507)
        self.assertEqual(json.loads(raw)["code"], "arena_artifact_quota")
        self.assertEqual(self.request(first["url"])[2], self.videos["mp4"])


if __name__ == "__main__":
    unittest.main()
