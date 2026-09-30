"""Persisted real source frames + offline readiness; not recognition accuracy."""
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.common import hash_json, now
from core.broadcast.media import FFMPEG, FFPROBE
from core.broadcast.service import BroadcastService
from core.broadcast.validation import content_hash
from tools.preflight_broadcast import OfflinePreflightService, main, run_preflight


def snapshot(directory):
    return {str(p.relative_to(directory)):hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob("*") if p.is_file() and not p.is_symlink()}


class BroadcastPreflightTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not all(shutil.which(binary) or Path(binary).is_file() for binary in (FFMPEG, FFPROBE)):
            raise unittest.SkipTest("Real FFmpeg/ffprobe unavailable; frame restoration unverified")
        cls.source_temp = tempfile.TemporaryDirectory()
        cls.video = Path(cls.source_temp.name) / "test-source.mp4"
        subprocess.run([FFMPEG,"-v","error","-nostdin","-f","lavfi","-i","testsrc2=size=320x180:rate=25:duration=4",
                        "-c:v","libx264","-pix_fmt","yuv420p","-y",str(cls.video)],check=True,capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.source_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.service = OfflinePreflightService(self.workspace)
        self.project = self.service.create("Persisted offline fixture", "manual")
        with self.video.open("rb") as source:
            self.project = self.service.upload(self.project["id"],0,source,self.video.stat().st_size,"test-source.mp4","video/mp4")
        self.frames = self.service.frames(self.project["id"],self.project["revision"],[1.0,1.4])["frames"]
        observation = {"id":"o1", "type":"movement", "start":1, "end":1.5, "anchorTime":None,
                       "segmentId":"s1", "description":"画面中人物向前移动", "playerIds":[], "unknownActors":["人物"],
                       "frameIds":[f["id"] for f in self.frames], "source":{"kind":"manual","runId":None,"recordId":None},
                       "confidence":None, "review":{"status":"accepted","actor":"fixture","reason":"fixture","at":now()}, "geometry":None}
        self.project = self.service.edit(self.project["id"],self.project["revision"],{"observations":[observation]})
        story = {"schema":"courtlens-broadcast-story/1", "title":"离线验收", "audience":"fan", "commentaryStyle":"analysis",
                 "language":"zh-CN", "sourceRange":{"start":0,"end":4}, "beats":[{"id":"b1","label":"移动",
                 "sourceStart":2,"sourceEnd":3.8,"anchorTime":2,"observationIds":["o1"],"bindingIds":[],
                 "text":"画面中人物向前移动。","explanationKind":"visible-fact","metricRecordId":None,
                 "secondaryLabel":None,"annotation":None}]}
        self.project = self.service.edit(self.project["id"],self.project["revision"],{"story":story})
        checks = {k:True for k in ("identity","timing","metrics","wording","geometry")}
        self.project = self.service.review(self.project["id"],self.project["revision"],"fixture",checks,"")
        self.project_dir = self.service.store.project_dir(self.project["id"])

    def report(self):
        return OfflinePreflightService(self.workspace).preflight(self.project["id"])

    def checks(self, report):
        return {row["id"]:row for row in report["checks"]}

    def test_cli_reads_only_existing_evidence_without_project_or_model_mutation(self):
        before = snapshot(self.project_dir)
        original = copy.deepcopy(self.project)
        with patch("urllib.request.OpenerDirector.open",side_effect=AssertionError("network forbidden")), \
             patch("subprocess.run",side_effect=AssertionError("no command or extraction in preflight")), \
             patch("core.broadcast.providers.execute",side_effect=AssertionError("provider forbidden")), \
             patch.object(BroadcastService,"start_job",side_effect=AssertionError("jobs forbidden")), \
             patch.object(BroadcastService,"frames",side_effect=AssertionError("frame extraction forbidden")):
            report = run_preflight(self.workspace,self.project["id"],self.workspace / "report.json")
        after = self.service.get(self.project["id"])
        self.assertEqual(after,original)
        self.assertEqual(after["revision"],original["revision"])
        self.assertEqual(content_hash(after),content_hash(original))
        self.assertEqual(hash_json(after),report["contentHash"])
        self.assertEqual(before,snapshot(self.project_dir))
        self.assertFalse(report["offline"]["externalTransmission"])
        self.assertFalse(report["offline"]["modelCalls"])
        self.assertFalse(report["offline"]["projectWritten"])

    def test_real_saved_ffmpeg_frames_restore_after_service_restart(self):
        restored = self.report()
        self.assertEqual(restored["frames"],self.frames)
        self.assertEqual(restored["vision"]["counts"]["sourceFrames"],2)
        self.assertEqual(self.checks(restored)["frames"]["status"],"pass")
        for frame in restored["frames"]:
            raw = (self.project_dir / "frames" / frame["id"] / "frame.png").read_bytes()
            self.assertTrue(raw.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(hashlib.sha256(raw).hexdigest(),frame["sha256"])
            self.assertAlmostEqual(frame["actualTime"],frame["requestedTime"],places=6)

    def test_symlink_frame_directory_metadata_and_image_are_excluded(self):
        real = self.project_dir / "frames" / self.frames[0]["id"]
        catalogue = self.project_dir / "frames"
        (catalogue / "linked-directory").symlink_to(real,target_is_directory=True)
        for fake_id, linked_name in [("linked-json","frame.json"),("linked-png","frame.png")]:
            fake = catalogue / fake_id
            fake.mkdir()
            metadata = dict(self.frames[0],id=fake_id)
            (fake / "frame.json").write_text(json.dumps(metadata))
            shutil.copyfile(real / "frame.png",fake / "frame.png")
            (fake / linked_name).unlink()
            (fake / linked_name).symlink_to(real / linked_name)
        self.assertEqual([f["id"] for f in self.report()["frames"]],[f["id"] for f in self.frames])

    def test_tampered_frame_bytes_cannot_match_saved_frame_hash(self):
        frame = self.frames[0]
        target = self.project_dir / "frames" / frame["id"] / "frame.png"
        target.write_bytes(target.read_bytes() + b"tampered")
        report = self.report()
        self.assertNotIn(frame["id"],{row["id"] for row in report["frames"]})
        self.assertEqual(report["vision"]["counts"]["sourceFrames"],1)
        self.assertIn("source_frames_missing",{row["code"] for row in report["vision"]["reviewQueue"]})

    def test_missing_official_metrics_and_aws_gates_remain_unknown_without_percent_score(self):
        report = self.report()
        checks = self.checks(report)
        for key in ("metric-difficulty","metric-gravity","metric-leverage","aws-account","agent-service","cloudfront","portal-repo"):
            self.assertEqual(checks[key]["status"],"unknown")
        self.assertFalse(report["vision"]["accuracyCertified"])
        for key in ("score","percentage","passPercent","overallScore","overallPercentage"):
            self.assertNotIn(key,report)
        self.assertIn("未知",report["scope"])

    def test_old_approval_revision_cannot_authorize_new_project_revision(self):
        self.assertEqual(self.checks(self.report())["review"]["status"],"pass")
        approval = copy.deepcopy(self.project["review"])
        changed = self.service.edit(self.project["id"],self.project["revision"],{"title":"New metadata revision"})
        self.assertIsNone(changed["review"])
        # Reinsert a stale persisted approval to test the revision gate, even
        # though ordinary edits already invalidate review automatically.
        changed["review"] = approval
        self.assertEqual(content_hash(changed),approval["contentHash"])
        self.service.store.write(changed)
        self.assertEqual(self.checks(self.report())["review"]["status"],"fail")

    def test_modified_story_content_invalidates_old_review_hash(self):
        changed = copy.deepcopy(self.project)
        changed["story"]["beats"][0]["text"] = "人物继续向前移动。"
        self.assertNotEqual(content_hash(changed),changed["review"]["contentHash"])
        self.service.store.write(changed)
        self.assertEqual(self.checks(self.report())["review"]["status"],"fail")

    def test_persisted_provider_rejected_candidate_restores_in_review_queue(self):
        run = {"schema":"courtlens-observations/1", "mediaSha256":self.project["media"]["sha256"], "trustedExecution":True,
               "providerRun":{"id":"saved-run", "mode":"video-model", "provider":"saved-fixture-not-live",
               "requestHash":"a"*64,"responseHash":"b"*64}, "observations":[], "candidateRevisions":[{
               "candidateIndex":3,"reason":"姓名不在当场名单；已拒绝该候选", "frameIds":[self.frames[0]["id"]],
               "sourceWindow":{"start":1,"end":1.5}}]}
        self.service.store.atomic(self.project_dir / "runs" / "saved-run.json",run)
        before = snapshot(self.project_dir)
        report = self.report()
        rejected = [row for row in report["vision"]["reviewQueue"] if row["code"] == "semantic_candidate_rejected"]
        self.assertEqual(len(rejected),1)
        self.assertIn("姓名不在当场名单",rejected[0]["message"])
        self.assertEqual(rejected[0]["evidenceRefs"][0]["candidateIndex"],3)
        self.assertEqual(rejected[0]["evidenceRefs"][0]["frameIds"],[self.frames[0]["id"]])
        self.assertFalse(report["vision"]["automaticAcceptance"])
        self.assertEqual(self.service.get(self.project["id"])["observations"],self.project["observations"])
        self.assertEqual(before,snapshot(self.project_dir))

    def test_old_release_story_cannot_validate_current_audio(self):
        previous_story = copy.deepcopy(self.project["story"])
        previous_story["beats"][0]["text"] = "旧版本台词。"
        release_id = "saved-release"
        manifest = {"story":previous_story,"voiceReport":{"language":"zh-CN","provider":"saved-fixture-not-live",
                    "cues":[{"beatId":"b1","outputStart":2,"speechDuration":1,"tempo":1,"tailTruncated":False}]}}
        self.service.store.atomic(self.project_dir / "releases" / release_id / "manifest.json",manifest)
        p = copy.deepcopy(self.project)
        p["releases"] = [{"id":release_id,"projectRevision":p["revision"],"contentHash":content_hash(p),"createdAt":now(),
                        "videoUrl":"/fixture/film.mp4","captionsUrl":"/fixture/captions.vtt","manifestUrl":"/fixture/manifest.json",
                        "watchUrl":"/fixture/watch","duration":4,"videoSha256":"c"*64,
                        "voice":{"mode":"local-tts","provider":"saved-fixture-not-live","voiceId":"Tingting","audioSha256":"d"*64},
                        "understanding":{"mode":"manual","providerRunIds":[],"humanReviewed":True}}]
        self.service.store.write(p)
        rehearsal = self.report()["rehearsal"]
        self.assertIn("measured_story_mismatch",{row["code"] for row in rehearsal["issues"]})
        self.assertFalse(rehearsal["summary"]["timingAccepted"])
        self.assertFalse(rehearsal["beats"][0]["measuredAudio"]["reportMatchesStory"])
        self.assertFalse(rehearsal["summary"]["naturalnessValidated"])

    def test_report_never_overwrites_existing_file_or_symlink(self):
        output = self.workspace / "existing.json"
        output.write_text("keep this report")
        with self.assertRaises(FileExistsError):
            run_preflight(self.workspace,self.project["id"],output)
        self.assertEqual(output.read_text(),"keep this report")
        link = self.workspace / "report-link.json"
        link.symlink_to(output)
        with self.assertRaises(FileExistsError):
            run_preflight(self.workspace,self.project["id"],link)
        self.assertEqual(output.read_text(),"keep this report")

    def test_missing_workspace_and_report_inside_project_are_refused(self):
        missing = self.workspace / "never-create-this-workspace"
        with self.assertRaises(ValueError):
            run_preflight(missing,self.project["id"],self.workspace / "report.json")
        self.assertFalse(missing.exists())
        with self.assertRaises(ValueError):
            run_preflight(self.workspace,self.project["id"],self.project_dir / "report.json")
        self.assertFalse((self.project_dir / "report.json").exists())

    def test_cli_named_arguments_export_a_new_readonly_report(self):
        output = self.workspace / "cli-report.json"
        before = snapshot(self.project_dir)
        with patch.object(sys,"argv",["preflight_broadcast.py","--workspace",str(self.workspace),"--project",self.project["id"],"--output",str(output)]), \
             patch("sys.stdout") as stdout:
            main()
        report = json.loads(output.read_text())
        self.assertEqual(report["schema"],"courtlens-broadcast-preflight/1")
        self.assertEqual(report["projectRevision"],self.project["revision"])
        self.assertTrue(stdout.write.called)
        self.assertEqual(before,snapshot(self.project_dir))


if __name__ == "__main__":
    unittest.main()
