"""Offline advice, official placeholders and real-render tempo safety."""
import copy
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.commentary_rehearsal import analyze, count_text
from core.broadcast.providers import voice
from core.broadcast.validation import NODE


def story(text="持球人向前移动。", language="zh-CN", start=2, end=6):
    return {"schema": "courtlens-broadcast-story/1", "title": "离线彩排", "audience": "fan",
            "commentaryStyle": "analysis", "language": language, "sourceRange": {"start": 1, "end": 10},
            "beats": [{"id": "b1", "label": "移动", "sourceStart": start, "sourceEnd": end, "anchorTime": start,
                       "observationIds": ["o1"], "bindingIds": [], "text": text,
                       "explanationKind": "visible-fact", "metricRecordId": None, "secondaryLabel": None, "annotation": None}]}


def metric_project(kind="official"):
    s = story("本次指标 {{metric:r-event}}", end=4)
    s["beats"][0].update(metricRecordId="r-event", bindingIds=["bind1"], explanationKind="data-fact")
    observation = {"id":"o1", "type":"movement", "start":1, "end":1.5, "anchorTime":None,
                   "segmentId":"s1", "description":"人物移动", "playerIds":[], "unknownActors":["人物"], "frameIds":[],
                   "source":{"kind":"manual", "runId":None, "recordId":None}, "confidence":None,
                   "review":{"status":"accepted", "actor":"fixture", "reason":"fixture", "at":"2026-10-01T00:00:00Z"}, "geometry":None}
    bundle = {"schema":"courtlens-metrics/2", "dictionary":{"id":"test", "version":"1",
              "provenance":{"kind":kind, "source":"declared fixture; not authenticated"},
              "metrics":{"event":{"version":"1", "label":"指标", "role":"gravity",
              "semantics":"provider_on_ball_gravity_index", "unit":"index", "definition":"测试指标",
              "granularity":"event", "ballState":"on-ball"}}}, "bindings":{},
              "plays":[{"id":"play1", "gameId":"g1", "start":0, "end":10}],
              "records":[{"id":"r-event", "metricId":"event", "value":1.8,
              "scope":{"granularity":"event", "playId":"play1", "eventId":"e1"},
              "time":{"timeBase":"video", "observedAt":1, "availableAt":1, "validFrom":1, "validTo":6}}]}
    binding = {"id":"bind1", "observationId":"o1", "officialEventId":"e1", "shotId":None, "gameId":"g1",
               "playerId":None, "metricRecordIds":["r-event"], "timeMapping":{"source":"video", "videoTime":1.2,
               "period":None, "clock":None, "mappingEvidenceIds":[]}, "status":"confirmed", "reason":"fixture",
               "confirmedBy":"fixture", "confirmedAt":"2026-10-01T00:00:00Z"}
    return {"story":s, "media":{"duration":10}, "context":{"gameId":"g1", "roster":[], "offenseTeamId":None,
            "seasonId":None}, "observations":[observation], "bindings":[binding], "metrics":bundle}


def manifest(s, duration=.9, tempo=1, start=1, tail=False):
    return {"story":copy.deepcopy(s), "voiceReport":{"language":s["language"], "provider":"offline-test",
            "cues":[{"beatId":"b1", "outputStart":start, "speechDuration":duration, "tempo":tempo, "tailTruncated":tail}]}}


class CommentaryRehearsalTest(unittest.TestCase):
    def test_real_project_audio_is_bound_to_source_media_hash(self):
        s = story()
        project = {"story": s, "media": {"duration": 10, "sha256": "a" * 64}}
        audio = manifest(s)
        self.assertFalse(analyze(project, manifest=audio)["summary"]["timingAccepted"])
        audio["source"] = {"mediaSha256": "b" * 64}
        self.assertFalse(analyze(project, manifest=audio)["summary"]["timingAccepted"])
        audio["source"]["mediaSha256"] = "a" * 64
        self.assertTrue(analyze(project, manifest=audio)["summary"]["timingAccepted"])

    def test_measured_metric_audio_requires_current_compiled_value_and_unit(self):
        if not NODE:
            self.skipTest("Node required for canonical metric validation")
        p = metric_project()
        audio = manifest(p["story"], start=1)
        audio["compiledBeats"] = [{"beatId": "b1", "compiledText": "本次指标 1.8 index"}]
        self.assertTrue(analyze(p, manifest=audio)["summary"]["timingAccepted"])
        for updated in ("value", "unit", "missing_compilation"):
            current, supplied = copy.deepcopy(p), copy.deepcopy(audio)
            if updated == "value":
                current["metrics"]["records"][0]["value"] = 1800000
            elif updated == "unit":
                current["metrics"]["dictionary"]["metrics"]["event"]["unit"] = "other-index"
            else:
                supplied.pop("compiledBeats")
            report = analyze(current, manifest=supplied)
            self.assertFalse(report["summary"]["timingAccepted"], updated)
            self.assertFalse(report["beats"][0]["measuredAudio"]["reportMatchesStory"], updated)

    def test_preflight_uses_record_entry_bundle_dictionary_provenance_order(self):
        from core.broadcast.preflight import inspect_project
        p = metric_project()
        p.update(id="fixture", revision=0, review=None)
        p["media"].update(sha256="a" * 64, width=320, height=180)
        def check(project):
            return next(c for c in inspect_project(project, [], [], {})["checks"] if c["id"] == "metric-gravity")["status"]
        self.assertEqual(check(p), "pass")
        definition = p["metrics"]["dictionary"]["metrics"]["event"]
        definition["provenance"] = {"kind": "synthetic", "source": "entry fixture"}
        self.assertEqual(check(p), "unknown")
        p["metrics"]["records"][0]["provenance"] = {"kind": "official", "source": "record fixture"}
        self.assertEqual(check(p), "pass")
        p["metrics"]["records"][0].pop("provenance")
        definition["provenance"]["kind"] = "official"
        p["metrics"]["dictionary"]["provenance"]["kind"] = "synthetic"
        self.assertEqual(check(p), "pass")

    def codes(self, report):
        return {row["code"] for row in report["issues"]}

    def test_short_story_is_readonly_advice_not_voice_acceptance(self):
        s = story()
        p = {"story":s, "review":{"contentHash":"keep-reviewed-hash", "result":"approved"}}
        before = copy.deepcopy(p)
        with patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")), \
             patch("subprocess.run", side_effect=AssertionError("audio forbidden")):
            report = analyze(p)
        self.assertEqual(p, before)
        self.assertEqual(report["storyHash"], analyze(p)["storyHash"])
        self.assertTrue(report["readOnly"])
        self.assertFalse(report["externalTransmission"])
        self.assertFalse(report["summary"]["timingAccepted"])
        self.assertFalse(report["summary"]["naturalnessValidated"])
        self.assertEqual(report["beats"][0]["estimate"]["basis"], "heuristic-not-measured")
        self.assertEqual(report["beats"][0]["cue"]["outputStart"], 1)
        self.assertEqual(report["beats"][0]["cue"]["availableSeconds"], 3.92)

    def test_overlong_chinese_and_english_use_different_units(self):
        for text, language, count_key in [("持球人沿底线移动。" * 8, "zh-CN", "cjkCharacters"),
                                          ("The ball handler moves toward the basket. " * 8, "en-US", "latinWords")]:
            with self.subTest(language=language):
                report = analyze(story(text, language, end=3))
                row = report["beats"][0]
                self.assertGreater(row["counts"][count_key], 50)
                self.assertIn("estimated_pacing_overflow", self.codes(report))
                self.assertFalse(row["estimate"]["fitsAtMaxTempo"])
                self.assertGreater(row["estimate"]["requiredTempo"], 1.15)
        counts = count_text("O'Neal cuts, then pick-and-roll. xFG 42.0%")
        self.assertEqual(counts["latinWords"], 5)
        self.assertEqual(counts["cjkCharacters"], 0)
        self.assertEqual(counts["numericTokens"], 1)
        self.assertEqual(counts["punctuation"], 2)

    def test_cantonese_glossary_does_not_claim_listened_naturalness(self):
        report = analyze(story("佢借掩護走到弱邊。", "yue-HK"))
        terms = {row["id"]:row for row in report["beats"][0]["glossary"]}
        self.assertEqual(terms["screen"]["readingAid"], "jim2 wu6")
        self.assertEqual(terms["weak-side"]["terms"]["en-US"], "weak side")
        self.assertFalse(report["summary"]["naturalnessValidated"])

    def test_zero_nonfinite_negative_and_out_of_range_cues_are_json_safe(self):
        for start, end in [(2,2), (3,2), (float("nan"),4), (2,float("inf")), (-1,3), (2,11), (True,4)]:
            with self.subTest(start=start, end=end):
                report = analyze(story(start=start, end=end))
                self.assertIn("cue_invalid", self.codes(report))
                self.assertIsNone(report["beats"][0]["estimate"]["requiredTempo"])
                json.dumps(report, allow_nan=False)

    def test_too_short_and_overlapping_windows_have_no_success(self):
        tiny = analyze(story(start=2, end=2.08))
        self.assertIn("cue_too_short", self.codes(tiny))
        self.assertIsNone(tiny["beats"][0]["estimate"]["requiredTempo"])
        s = story()
        s["beats"].append({**s["beats"][0], "id":"b2", "sourceStart":4, "sourceEnd":8})
        report = analyze(s)
        self.assertIn("cue_overlap", self.codes(report))
        self.assertFalse(report["beats"][1]["cue"]["valid"])

    def test_trim_cannot_exceed_actual_media_duration(self):
        report = analyze({"story":story(), "media":{"duration":5}})
        self.assertIn("source_range_invalid", self.codes(report))
        self.assertFalse(report["beats"][0]["cue"]["valid"])

    def test_unknown_player_requires_roster_and_listening(self):
        s = story("New Player 向底线移动。")
        player = {"id":"p1", "name":"New Player", "source":"dated-roster"}
        report = analyze(s, roster=[player])
        self.assertIn("player_pronunciation_unknown", self.codes(report))
        self.assertIsNone(report["beats"][0]["pronunciations"][0]["readingAid"])
        player["pronunciation"] = {"zh-CN":"人工核对姓名读法", "sourceRef":"dated-roster/pronunciation", "reviewed":True}
        report = analyze(s, roster=[player])
        self.assertNotIn("player_pronunciation_unknown", self.codes(report))
        self.assertTrue(report["beats"][0]["pronunciations"][0]["listenRequired"])

    def test_no_celebrity_voice_or_cloning_is_created(self):
        p = {"story":story(), "voiceId":"Mike Breen", "voiceClone":"celebrity-sample.mp3"}
        with patch.object(voice, "synthesize", side_effect=AssertionError("must not synthesize")):
            report = analyze(p)
        self.assertNotIn("voiceId", report)
        self.assertTrue(any("克隆" in x for x in report["limitations"]))
        with self.assertRaises(BroadcastError):
            voice.configured_voice("local-tts", requested="Mike Breen", language="en-US")

    def test_placeholder_is_never_counted_as_real_number(self):
        s = story("{{metric:r12345}}")
        report = analyze(s)
        row = report["beats"][0]
        self.assertEqual(row["counts"]["numericTokens"], 0)
        self.assertEqual(row["counts"]["latinWords"], 0)
        self.assertEqual(row["estimate"]["durationSeconds"], 0)
        self.assertFalse(row["estimate"]["complete"])
        self.assertIn("metric_placeholder_unresolved", self.codes(report))
        self.assertEqual(row["text"], "{{metric:r12345}}")

    @unittest.skipIf(NODE is None, "existing metric validator requires Node")
    def test_validated_bound_official_metric_resolves_without_mutation(self):
        p = metric_project()
        original = copy.deepcopy(p)
        report = analyze(p)
        row = report["beats"][0]
        self.assertEqual(p, original)
        self.assertEqual(row["text"], "本次指标 1.8 index")
        self.assertEqual(row["counts"]["numericTokens"], 1)
        self.assertEqual(row["counts"]["unresolvedMetrics"], 0)
        self.assertFalse(row["metrics"][0]["sourceAuthenticated"])

    @unittest.skipIf(NODE is None, "existing metric validator requires Node")
    def test_probability_format_preserves_zero_and_does_not_invert_xfg(self):
        for value, expected in [(0, "0.0%"), (.42, "42.0%")]:
            p = metric_project()
            entry = p["metrics"]["dictionary"]["metrics"]["event"]
            entry.update(role="difficulty", semantics="official_xfg", unit="probability")
            p["metrics"]["records"][0]["value"] = value
            with self.subTest(value=value):
                row = analyze(p)["beats"][0]
                self.assertEqual(row["metrics"][0]["display"], expected)
                self.assertEqual(row["counts"]["numericTokens"], 1)
                self.assertEqual(p["metrics"]["records"][0]["value"], value)

    @unittest.skipIf(NODE is None, "existing metric validator requires Node")
    def test_synthetic_missing_binding_wrong_event_late_and_bad_dictionary_do_not_resolve(self):
        for change in ("synthetic", "binding", "event", "time", "dictionary"):
            p = metric_project()
            if change == "synthetic": p["metrics"]["dictionary"]["provenance"]["kind"] = "synthetic"
            if change == "binding": p["bindings"][0]["status"] = "proposed"
            if change == "event": p["bindings"][0]["officialEventId"] = "other-event"
            if change == "time": p["metrics"]["records"][0]["time"]["availableAt"] = 3
            if change == "dictionary": p["metrics"]["records"][0]["unit"] = "percent"
            with self.subTest(change=change):
                report = analyze(p)
                self.assertEqual(report["beats"][0]["counts"]["numericTokens"], 0)
                self.assertIn("metric_placeholder_unresolved", self.codes(report))

    def test_measured_manifest_is_distinct_and_rejects_stale_story(self):
        s = story()
        m = manifest(s)
        report = analyze(s, manifest=m)
        self.assertTrue(report["summary"]["timingAccepted"])
        self.assertEqual(report["beats"][0]["measuredAudio"]["basis"], "manifest-measurement")
        self.assertFalse(report["summary"]["naturalnessValidated"])
        s["beats"][0]["text"] = "改过的解说。"
        report = analyze(s, manifest=m)
        self.assertIn("measured_story_mismatch", self.codes(report))
        self.assertFalse(report["summary"]["timingAccepted"])

    def test_measured_overflow_tempo_truncation_and_nan_are_rejected(self):
        s = story()
        for kw, code in [({"duration":4.1}, "measured_cue_overflow"), ({"tempo":1.7}, "measured_tempo_excessive"),
                         ({"tail":True}, "measured_tail_truncated_or_unknown"), ({"tail":None}, "measured_tail_truncated_or_unknown"),
                         ({"duration":math.nan}, "measured_audio_invalid"), ({"start":2}, "measured_cue_overflow")]:
            with self.subTest(kw=kw):
                report = analyze(s, manifest=manifest(s, **kw))
                self.assertIn(code, self.codes(report))
                self.assertFalse(report["summary"]["timingAccepted"])
                json.dumps(report, allow_nan=False)

    def test_manifest_missing_audio_and_duplicate_cue_cannot_accept(self):
        s = story()
        self.assertIn("measured_audio_missing", self.codes(analyze(s, manifest={"story":s})))
        m = manifest(s)
        m["voiceReport"]["cues"] *= 2
        report = analyze(s, manifest=m)
        self.assertIn("measured_cue_missing_or_duplicate", self.codes(report))
        self.assertFalse(report["summary"]["timingAccepted"])

    def test_actual_renderer_refuses_above_115_percent_before_time_stretch(self):
        # The provider and ffprobe are stubbed; no service request or truncating
        # command is made. Real WAV duration measurement remains in voice.py.
        for raw_duration in (1.151, 1.7):
            with self.subTest(raw_duration=raw_duration), tempfile.TemporaryDirectory() as tmp:
                film = Path(tmp) / "film.mp4"
                film.write_bytes(b"original")
                calls = []
                def run(args, timeout=30):
                    calls.append(args)
                    return str(raw_duration).encode()
                beats = [{"beatId":"b1", "outputStart":0, "outputEnd":1.08, "compiledText":"短句"}]
                with patch.object(voice, "configured_voice", return_value="test-voice"), \
                     patch.object(voice, "_external_audio", return_value=b"ID3offline"), patch.object(voice, "_run", side_effect=run):
                    with self.assertRaises(BroadcastError) as error:
                        voice.synthesize(film, beats, tmp, 2, mode="stepfun")
                self.assertEqual(error.exception.code, "voice_overflow")
                self.assertEqual(len(calls), 1)
                self.assertEqual(film.read_bytes(), b"original")
                self.assertFalse((Path(tmp) / "narration.wav").exists())


if __name__ == "__main__":
    unittest.main()
