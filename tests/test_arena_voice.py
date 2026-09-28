"""Local narration boundary tests; mocks are not claims of real TTS success."""

import base64
from copy import deepcopy
import json
from email.parser import Parser
import io
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

from core import arena_voice as voice


def fixture():
    return {"videoBase64": base64.b64encode(b"\x1a\x45\xdf\xa3mock-webm").decode(), "duration": 10,
            "provenance": {"kind": "synthetic", "source": "test fixture"},
            "cues": [{"start": 0, "end": 4, "text": "本地配音测试。", "evidenceIds": [], "origin": "manual"},
                     {"start": 5, "end": 9.9, "text": "第二句话完整保留。", "origin": "evidence-engine"}]}


class Pipeline:
    def __init__(self, duration=10, speech=1.5, fitted=1.4, installed=True, packets=None):
        self.duration, self.speech, self.fitted, self.installed = duration, speech, fitted, installed
        self.packets = packets
        self.commands = []

    def __call__(self, command, *, timeout):
        self.commands.append(command)
        assert 0 < timeout <= 120
        name = Path(command[0]).name
        if name == "say":
            if command[1:] == ["-v", "?"]:
                return "Tingting zh_CN # installed\n" if self.installed else "Alex en_US # installed\n"
            Path(command[command.index("-o") + 1]).write_bytes(b"fixture speech")
            return ""
        if name == "ffmpeg":
            output = Path(command[-1])
            if output.suffix == ".wav":
                with wave.open(str(output), "wb") as result:
                    result.setnchannels(1)
                    result.setsampwidth(2)
                    result.setframerate(voice.SAMPLE_RATE)
                    result.writeframes(b"\x01\x00" * round(self.fitted * voice.SAMPLE_RATE))
            else:
                output.write_bytes(b"fixture-mp4")
            return ""
        if "-show_packets" in command:
            assert command[command.index("-of") + 1] == "json"
            return self.packets if self.packets is not None else json.dumps({"packets": [
                {"pts_time": "0.000000", "side_data_list": [{"side_data_type": "Matroska BlockAdditional"}]},
                {"pts_time": "0.040000", "duration_time": "N/A", "tags": {"unrelated": ","}},
                {"pts_time": f"{self.duration - .04:.6f}", "duration_time": "0.040000",
                 "side_data_list": [{"side_data_type": "Matroska BlockAdditional"}]}]})
        if command[-1].endswith(".aiff"):
            return str(self.speech)
        if command[-1].endswith(".mp4"):
            return json.dumps({"format": {"duration": str(self.duration)}, "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360},
                {"codec_type": "audio", "codec_name": "aac"}]})
        return json.dumps({"format": {"format_name": "matroska,webm"}, "streams": [
            {"codec_type": "video", "codec_name": "vp9", "width": 640, "height": 360}]})


class ArenaVoiceTests(unittest.TestCase):
    def setUp(self):
        self.paths = patch.object(voice.shutil, "which", side_effect=lambda name: "/tools/" + name)
        self.paths.start()
        self.addCleanup(self.paths.stop)

    def test_real_mux_contract_and_source_labels_with_mock_tools(self):
        body, pipeline = fixture(), Pipeline()
        original = deepcopy(body)
        result = voice.narrate(body, executor=pipeline)
        self.assertEqual(body, original)
        self.assertEqual(result.video_bytes, b"fixture-mp4")
        self.assertEqual(result.report["originalAudio"], "omitted")
        self.assertFalse(result.report["sourceAuthenticated"])
        self.assertFalse(result.report["cueFrameAlignmentVerified"])
        self.assertEqual(result.report["cues"][0]["origin"], "manual")
        self.assertEqual(result.report["cues"][0]["evidenceIds"], [])
        self.assertTrue(all(not cue["tailTruncated"] for cue in result.report["cues"]))
        summary = json.loads(result.response_headers()["X-CourtLens-Voice-Report"])
        self.assertNotIn("cues", summary)
        for command in pipeline.commands:
            if Path(command[0]).name in ("ffmpeg", "ffprobe"):
                self.assertEqual(command[command.index("-protocol_whitelist") + 1], "file,pipe")
            self.assertNotIn(body["cues"][0]["text"], command)
        mux = next(command for command in pipeline.commands if command[-1].endswith(".mp4") and Path(command[0]).name == "ffmpeg")
        self.assertEqual([mux[index + 1] for index, value in enumerate(mux) if value == "-map"], ["0:v:0", "1:a:0"])
        self.assertIn("libx264", mux)
        self.assertIn("aac", mux)

    def test_only_small_verified_drift_scales_cues_and_is_reported_approximate(self):
        result = voice.narrate(fixture(), executor=Pipeline(duration=10.3))
        self.assertEqual(result.report["timingDriftSeconds"], .3)
        self.assertEqual(result.report["timingScale"], 1.03)
        self.assertEqual(result.report["cues"][1]["outputStart"], 5.15)
        self.assertIn("approximate", result.report["alignment"])

    def test_significant_drift_rejected_before_speech(self):
        pipeline = Pipeline(duration=10.6)
        with self.assertRaises(voice.ArenaVoiceError) as caught:
            voice.narrate(fixture(), executor=pipeline)
        self.assertEqual(caught.exception.code, "timing_drift")
        self.assertFalse(any("-o" in command for command in pipeline.commands))

    def test_packet_json_uses_named_times_and_ignores_unrelated_metadata(self):
        packets = {"format": {"duration": "N/A"}, "packets": [
            {"pts_time": "0.100000", "side_data_list": [{"side_data_type": "Matroska BlockAdditional"}]},
            {"pts_time": "0.500000", "duration_time": "N/A", "tags": {"unrelated": ",\n"}},
            {"pts_time": "1.100000", "duration_time": "0.040000"},
            {"pts_time": "0.900000", "duration_time": "0.040000"}]}
        # PTS need not be monotonic in decode order. A nonzero origin is removed.
        self.assertAlmostEqual(voice._packet_clock_duration(json.dumps(packets)), 1.04)
        # Missing frame duration contributes no invented frame length.
        self.assertEqual(voice._packet_clock_duration(json.dumps({"packets": [
            {"pts_time": "0"}, {"pts_time": "1", "duration_time": "N/A"}]})), 1)

    def test_packet_json_invalid_times_and_structure_are_rejected(self):
        malformed = ["not JSON", "[]", "null", "{}", '{"packets": []}',
                     '{"packets": {}}', '{"packets": [null]}']
        changes = [{}, {"pts_time": "N/A"}, {"pts_time": None}, {"pts_time": True},
                   {"pts_time": "NaN"}, {"pts_time": "Infinity"}, {"pts_time": "bad"},
                   {"pts_time": 0, "duration_time": None}, {"pts_time": 0, "duration_time": True},
                   {"pts_time": 0, "duration_time": "NaN"}, {"pts_time": 0, "duration_time": "Infinity"},
                   {"pts_time": 0, "duration_time": "bad"}, {"pts_time": 0, "duration_time": "-0.04"},
                   {"pts_time": "-0.051", "duration_time": "1"},
                   {"pts_time": "0.501", "duration_time": "1"},
                   {"pts_time": "0", "duration_time": "180.001"}]
        malformed.extend(json.dumps({"packets": [packet]}) for packet in changes)
        for raw in malformed:
            with self.subTest(raw=raw), self.assertRaises(voice.ArenaVoiceError) as caught:
                voice._packet_clock_duration(raw)
            self.assertEqual(caught.exception.code, "invalid_video_clock")
            self.assertEqual(caught.exception.status, 422)

    def test_packet_metadata_never_relaxes_clock_or_drift_validation(self):
        raw = json.dumps({"packets": [{"pts_time": "0", "duration_time": "N/A"},
                                     {"pts_time": "10.6", "side_data_list": [{"duration_time": "-0.6"}]}]})
        pipeline = Pipeline(packets=raw)
        with self.assertRaises(voice.ArenaVoiceError) as caught:
            voice.narrate(fixture(), executor=pipeline)
        self.assertEqual(caught.exception.code, "timing_drift")
        self.assertFalse(any("-o" in command for command in pipeline.commands))

    def test_two_percent_tolerance_for_longer_recordings(self):
        body = fixture()
        body["duration"] = 100
        result = voice.narrate(body, executor=Pipeline(duration=101.5))
        self.assertEqual(result.report["timingToleranceSeconds"], 2)

    def test_invalid_duration_cues_text_and_provenance(self):
        changes = [("duration", True), ("duration", float("nan")), ("duration", 181),
                   ("cues", []), ("cues", [{}] * 257), ("provenance", {}), ("provenance", None)]
        for field, value in changes:
            body = fixture()
            body[field] = value
            with self.subTest(field=field, value=str(value)[:30]), self.assertRaises(voice.ArenaVoiceError):
                voice.validate_request(body)
        for change in ({"start": True}, {"end": 11}, {"text": ""}, {"text": "\0"},
                       {"origin": []}, {"evidenceIds": "fake"}, {"text": "x" * 20001}):
            body = fixture()
            body["cues"][0].update(change)
            with self.subTest(change=str(change)[:40]), self.assertRaises(voice.ArenaVoiceError):
                voice.validate_request(body)

    def test_total_text_overlap_and_paths_are_rejected(self):
        body = fixture()
        body["cues"][0]["text"] = "a" * 10001
        body["cues"][1]["text"] = "a" * 10001
        with self.assertRaises(voice.ArenaVoiceError) as caught:
            voice.validate_request(body)
        self.assertEqual(caught.exception.code, "text_too_large")
        body = fixture()
        body["cues"][1]["start"] = 3
        with self.assertRaises(voice.ArenaVoiceError) as caught:
            voice.validate_request(body)
        self.assertEqual(caught.exception.code, "overlapping_cues")
        body = fixture()
        body["videoPath"] = "/arbitrary/local/file"
        with self.assertRaises(voice.ArenaVoiceError):
            voice.validate_request(body)

    def test_generated_evidence_ids_may_contain_long_play_and_player_ids(self):
        body = fixture()
        identifier = "p" * 120 + ":window-first:" + "d" * 120
        body["cues"][0]["evidenceIds"] = [identifier]
        request = voice.validate_request(body)
        self.assertEqual(request["cues"][0]["evidenceIds"], [identifier])
        body["cues"][0]["evidenceIds"] = ["x" * 321]
        with self.assertRaises(voice.ArenaVoiceError):
            voice.validate_request(body)

    def test_bad_base64_wrong_container_and_size_limit(self):
        for encoded in ("!", "", "汉", base64.b64encode(b"other container").decode()):
            body = fixture()
            body["videoBase64"] = encoded
            with self.subTest(encoded=encoded), self.assertRaises(voice.ArenaVoiceError):
                voice.validate_request(body)
        with patch.object(voice, "MAX_VIDEO_BYTES", 6):
            with self.assertRaises(voice.ArenaVoiceError) as caught:
                voice.validate_request(fixture())
            self.assertEqual(caught.exception.status, 413)

    def test_unsupported_and_missing_voice_have_no_fallback(self):
        body = fixture()
        body["voice"] = "Alex"
        with self.assertRaises(voice.ArenaVoiceError) as caught:
            voice.narrate(body, executor=Pipeline())
        self.assertEqual(caught.exception.code, "unsupported_voice")
        with self.assertRaises(voice.ArenaVoiceError) as caught:
            voice.narrate(fixture(), executor=Pipeline(installed=False))
        self.assertEqual(caught.exception.status, 503)
        with patch.object(voice.shutil, "which", return_value=None):
            with self.assertRaises(voice.ArenaVoiceError):
                voice.narrate(fixture(), executor=Pipeline())

    def test_dense_speech_and_measured_overflow_never_truncate(self):
        for pipeline in (Pipeline(speech=20), Pipeline(fitted=4.1)):
            with self.assertRaises(voice.ArenaVoiceError) as caught:
                voice.narrate(fixture(), executor=pipeline)
            self.assertEqual(caught.exception.code, "speech_too_dense")
            self.assertFalse(any(command[-1].endswith(".mp4") for command in pipeline.commands))

    def test_command_timeout_and_no_shell(self):
        with patch.object(voice.subprocess, "run", side_effect=subprocess.TimeoutExpired("say", 1)) as run:
            with self.assertRaises(voice.ArenaVoiceError) as caught:
                voice._execute(["say", "-v", "?"], timeout=1)
            self.assertEqual(caught.exception.status, 504)
            self.assertIs(run.call_args.kwargs["shell"], False)
            self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_late_tool_result_is_rejected(self):
        with patch.object(voice.time, "monotonic", side_effect=[0, 0, 121]):
            with self.assertRaises(voice.ArenaVoiceError) as caught:
                voice.narrate(fixture(), executor=Pipeline())
        self.assertEqual(caught.exception.code, "voice_timeout")

    def test_concurrency_limit_and_slot_released_after_error(self):
        with patch.object(voice, "_SLOTS", threading.BoundedSemaphore(2)):
            voice._SLOTS.acquire()
            voice._SLOTS.acquire()
            with self.assertRaises(voice.ArenaVoiceError) as caught:
                voice.narrate(fixture(), executor=Pipeline())
            self.assertEqual(caught.exception.code, "voice_busy")
            voice._SLOTS.release()
            voice._SLOTS.release()
            with self.assertRaises(voice.ArenaVoiceError):
                voice.narrate({}, executor=Pipeline())
            self.assertEqual(voice.narrate(fixture(), executor=Pipeline()).report["cueCount"], 2)

    def test_capabilities_discovery_is_not_a_real_narration_test(self):
        with patch.object(voice, "_execute", return_value="Tingting zh_CN # installed\n"):
            result = voice.capabilities()
        self.assertTrue(result["available"])
        self.assertFalse(result["realTestPassed"])
        self.assertEqual(result["limits"]["concurrentRequests"], 2)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "local ffmpeg/ffprobe required")
class ArenaVoiceRealClockTests(unittest.TestCase):
    def probe(self, path):
        command = [shutil.which("ffprobe"), "-v", "error", "-protocol_whitelist", "file,pipe", "-f", "matroska",
                   "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time,duration_time", "-of", "json", str(path)]
        return voice._execute(command, timeout=10)

    def test_generated_alpha_webm_contains_real_packet_side_data(self):
        # Alpha VP9 reproduces MediaRecorder's BlockAdditional side-data column
        # without checking a large binary fixture into the repository.
        with tempfile.TemporaryDirectory(prefix="courtlens-arena-clock-test-") as temporary:
            source = Path(temporary) / "alpha.webm"
            voice._execute([shutil.which("ffmpeg"), "-v", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe",
                "-f", "lavfi", "-i", "color=c=red@0.5:s=64x64:r=25:d=0.4", "-vf", "format=yuva420p", "-c:v", "libvpx-vp9",
                "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-deadline", "realtime", "-cpu-used", "8", "-threads", "1", "-an", str(source)], timeout=10)
            raw = self.probe(source)
            self.assertTrue(any(packet.get("side_data_list") for packet in json.loads(raw)["packets"]))
            self.assertAlmostEqual(voice._packet_clock_duration(raw), .4, places=6)

    def test_actual_arena_recording_missing_durations_and_side_data(self):
        captured = os.environ.get("COURTLENS_CAPTURED_WEBM")
        source = Path(captured) if captured else None
        if source is None or not source.is_file():
            self.skipTest("captured Arena recording is not bundled; generated side-data regression runs independently")
        raw = self.probe(source)
        packets = json.loads(raw)["packets"]
        self.assertEqual(len(packets), 299)
        self.assertTrue(any("duration_time" not in packet for packet in packets))
        self.assertTrue(any(packet.get("side_data_list") for packet in packets))
        self.assertAlmostEqual(voice._packet_clock_duration(raw), 12.071, places=6)


class ArenaVoiceHttpTests(unittest.TestCase):
    def request(self, path, body=None, headers=None, method="POST"):
        # Exercise the real handler without requiring a listening socket in CI.
        from server import Handler
        body = (body or "").encode("utf-8")
        headers = {"Content-Type": "application/json", "Content-Length": str(len(body)),
                   "Host": "127.0.0.1:8765", **(headers or {})}
        handler = Handler.__new__(Handler)
        handler.command, handler.path, handler.request_version = method, path, "HTTP/1.1"
        handler.requestline = f"{method} {path} HTTP/1.1"
        handler.server = SimpleNamespace(server_port=8765)
        handler.connection = SimpleNamespace(settimeout=lambda timeout: None)
        handler.headers = Parser().parsestr("\n".join(f"{key}: {value}" for key, value in headers.items()))
        handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
        handler.log_message = lambda *args: None
        getattr(handler, "do_" + method)()
        head, output = handler.wfile.getvalue().split(b"\r\n\r\n", 1)
        status_line, header_text = head.decode("iso-8859-1").split("\r\n", 1)
        return int(status_line.split()[1]), dict(Parser().parsestr(header_text).items()), output

    def test_success_download_headers_and_error_json(self):
        report = {"provider": voice.PROVIDER, "voice": voice.VOICE, "cueCount": 2,
                  "durationSeconds": 10, "plannedDurationSeconds": 10, "inputDurationSeconds": 10,
                  "timingDriftSeconds": 0, "timingScale": 1, "alignment": "approximate",
                  "originalAudio": "omitted", "sourceAuthenticated": False, "cueFrameAlignmentVerified": False}
        with patch.object(voice, "narrate", return_value=voice.NarrationResult(b"mp4-test", report)):
            status, headers, output = self.request("/api/arena/narrate", json.dumps(fixture()))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "video/mp4")
        self.assertIn("attachment", headers["Content-Disposition"])
        self.assertEqual(headers["X-CourtLens-Voice-Original-Audio"], "omitted")
        self.assertEqual(output, b"mp4-test")
        with patch.object(voice, "narrate", side_effect=voice.ArenaVoiceError("fixture timeout", "voice_timeout", 504)):
            status, headers, output = self.request("/api/arena/narrate", json.dumps(fixture()))
        self.assertEqual(status, 504)
        self.assertEqual(json.loads(output)["code"], "voice_timeout")

    def test_narration_limit_exception_other_routes_remain_eight_mib(self):
        status, _, _ = self.request("/api/arena/narrate", headers={"Content-Length": str(96 * 1024 * 1024 + 1)})
        self.assertEqual(status, 413)
        status, _, _ = self.request("/api/arena/agent", headers={"Content-Length": str(8 * 1024 * 1024 + 1)})
        self.assertEqual(status, 413)

    def test_host_and_origin_checks_apply_to_narration(self):
        for headers in ({"Origin": "https://other.example"}, {"Host": "other.example"}):
            with self.subTest(headers=headers):
                status, _, _ = self.request("/api/arena/narrate", json.dumps(fixture()), headers)
                self.assertEqual(status, 403)

    def test_capabilities_route_does_not_claim_synthesis_passed(self):
        with patch.object(voice, "capabilities", return_value={"available": True, "realTestPassed": False}):
            status, _, output = self.request("/api/arena/voice-capabilities", method="GET")
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(output)["realTestPassed"])


if __name__ == "__main__":
    unittest.main()
