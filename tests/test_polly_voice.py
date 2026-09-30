import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.providers import capabilities
from core.broadcast.media import FFMPEG
from core.broadcast.providers.voice import MAX_AUDIO_BYTES, _polly_audio, configured_voice, synthesize
from core.broadcast.service import BroadcastService


class _Stream(io.BytesIO):
    pass


class PollyVoiceTest(unittest.TestCase):
    def _env(self, **override):
        values = {
            "COURTLENS_ALLOWED_REGION": "us-west-2",
            "COURTLENS_POLLY_REGION": "us-west-2",
            "COURTLENS_POLLY_ENGINE": "neural",
            "COURTLENS_POLLY_VOICE_ID": "Zhiyu",
        }
        values.update(override)
        return patch.dict(os.environ, values)

    def test_config_requires_explicit_matching_region_engine_voice(self):
        with self._env():
            self.assertEqual(configured_voice("polly"), "Zhiyu")
            with self.assertRaises(BroadcastError):
                configured_voice("polly", "Other")
        with self._env(COURTLENS_POLLY_REGION="us-east-1"):
            with self.assertRaises(BroadcastError):
                configured_voice("polly")
        with self._env(COURTLENS_POLLY_ENGINE="standard"):
            with self.assertRaises(BroadcastError):
                configured_voice("polly")

    def test_synthesize_uses_bounded_mp3_stream_and_credential_chain(self):
        stream = _Stream(b"ID3" + b"a" * 30)
        calls = []

        class FakeClient:
            def synthesize_speech(self, **kwargs):
                calls.append(kwargs)
                return {"AudioStream": stream}

        with self._env(), patch("boto3.client", return_value=FakeClient()) as client:
            self.assertEqual(_polly_audio("精彩回合", "Zhiyu"), b"ID3" + b"a" * 30)
            self.assertEqual(client.call_args.args, ("polly",))
            self.assertEqual(client.call_args.kwargs["region_name"], "us-west-2")
        self.assertEqual(calls, [{"Engine":"neural","VoiceId":"Zhiyu","LanguageCode":"cmn-CN","Text":"精彩回合","TextType":"text","OutputFormat":"mp3","SampleRate":"24000"}])
        self.assertTrue(stream.closed)

    def test_rejects_long_input_and_oversized_response(self):
        with self._env(), patch("boto3.client") as client:
            with self.assertRaises(BroadcastError):
                _polly_audio("字" * 3001, "Zhiyu")
            client.assert_not_called()
        stream = _Stream(b"ID3" + b"a" * MAX_AUDIO_BYTES)
        fake = type("FakeClient", (), {"synthesize_speech": lambda self, **kwargs: {"AudioStream": stream}})()
        with self._env(), patch("boto3.client", return_value=fake):
            with self.assertRaises(BroadcastError):
                _polly_audio("短句", "Zhiyu")
        self.assertTrue(stream.closed)

    def test_capability_never_claims_live_verification(self):
        with tempfile.TemporaryDirectory() as root, self._env():
            row = next(x for x in capabilities(root) if x["id"] == "polly")
            self.assertTrue(row["configured"])
            self.assertTrue(row["available"])
            self.assertFalse(row["verified"])

    def test_stubbed_polly_audio_reuses_measured_narration_window(self):
        with tempfile.TemporaryDirectory() as root:
            video = os.path.join(root, "film.mp4")
            mp3 = os.path.join(root, "fixture.mp3")
            subprocess.run([FFMPEG,"-v","error","-f","lavfi","-i","color=size=320x180:rate=25:duration=2","-c:v","libx264","-pix_fmt","yuv420p","-y",video],check=True)
            subprocess.run([FFMPEG,"-v","error","-f","lavfi","-i","sine=frequency=600:sample_rate=24000:duration=0.45","-c:a","libmp3lame","-y",mp3],check=True)
            stream = _Stream(Path(mp3).read_bytes())
            fake = type("FakeClient", (), {"synthesize_speech": lambda self, **kwargs: {"AudioStream": stream}})()
            beats = [{"beatId":"b1","outputStart":0.2,"outputEnd":1.5,"compiledText":"精彩回合"}]
            with self._env(), patch("boto3.client", return_value=fake):
                report = synthesize(video, beats, root, 2.0, mode="polly")
            self.assertEqual(report["provider"],"amazon-polly")
            self.assertGreater(report["cues"][0]["speechDuration"],0)
            self.assertLessEqual(report["cues"][0]["speechDuration"],1.29)
            self.assertTrue(stream.closed)

    def test_render_job_accepts_optional_polly_and_records_audio(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            video, mp3 = root / "source.mp4", root / "speech.mp3"
            subprocess.run([FFMPEG,"-v","error","-f","lavfi","-i","testsrc2=size=640x360:rate=25:duration=5","-c:v","libx264","-pix_fmt","yuv420p","-y",str(video)],check=True)
            subprocess.run([FFMPEG,"-v","error","-f","lavfi","-i","sine=frequency=600:sample_rate=24000:duration=0.45","-c:a","libmp3lame","-y",str(mp3)],check=True)
            speech = mp3.read_bytes()
            class FakeClient:
                def synthesize_speech(self, **kwargs):
                    return {"AudioStream": _Stream(speech)}
            service = BroadcastService(root / "service")
            project = service.create("Polly fixture", "manual")
            with video.open("rb") as source:
                project = service.upload(project["id"], project["revision"], source, video.stat().st_size, "source.mp4", "video/mp4")
            observation = {"id":"o"*32,"type":"movement","start":1.0,"end":2.0,"anchorTime":None,"segmentId":"s1","description":"画面中人物移动","playerIds":[],"unknownActors":["人物"],"frameIds":[],"source":{"kind":"manual","runId":None,"recordId":None},"confidence":None,"review":{"status":"accepted","actor":"fixture","reason":"fixture","at":"2026-09-30T00:00:00Z"},"geometry":None}
            project = service.edit(project["id"],project["revision"],{"observations":[observation]})
            beat = {"id":"b"*32,"label":"移动","sourceStart":2.0,"sourceEnd":4.0,"anchorTime":2.0,"observationIds":[observation["id"]],"bindingIds":[],"text":"画面中人物移动","explanationKind":"visible-fact","metricRecordId":None,"secondaryLabel":None,"annotation":None}
            story = {"schema":"courtlens-broadcast-story/1","title":"Polly fixture","audience":"fan","commentaryStyle":"zh-analysis","sourceRange":{"start":0,"end":5},"beats":[beat]}
            project = service.edit(project["id"],project["revision"],{"story":story})
            project = service.review(project["id"],project["revision"],"fixture",{key:True for key in ("identity","timing","metrics","wording","geometry")},"")
            with self._env(), patch("boto3.client",return_value=FakeClient()):
                job = service.start_job(project["id"],project["revision"],"render",{"voiceMode":"polly","voiceId":None})
                service._threads[job["id"]].join(30)
            done = service.job(job["id"])
            self.assertEqual(done["status"],"succeeded",done.get("error"))
            release = service.release(done["resultId"])
            self.assertEqual(release["summary"]["voice"]["mode"],"polly")
            self.assertEqual(release["summary"]["voice"]["provider"],"amazon-polly")


if __name__ == "__main__":
    unittest.main()
