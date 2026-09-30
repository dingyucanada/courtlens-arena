"""Evidence admission failures matter more than the number of detected people."""
import copy
import json
import unittest

from core.broadcast.vision_readiness import assess, resolve_identity


DATE = "2025-01-01"
ROSTER = [{"id": "p2", "name": "Visible Player", "teamId": "DAL", "jersey": "2", "validOn": DATE, "source": "same-game-record"}]
MAPPING = {"white": {"teamId": "DAL", "confirmed": True, "source": "reviewed-scoreboard", "validOn": DATE}}


def reading(fid="f1", t=1, jersey="2", **extra):
    return dict({"runId": "r1", "segmentId": "s1", "trackId": "track-7", "frameId": fid,
                 "frameTime": t, "teamColorGroup": "white", "quality": "high", "jerseyText": jersey, "jerseyScore": .95}, **extra)


def candidate(readings=None, roster=None, mapping=None, **kwargs):
    return resolve_identity(ROSTER if roster is None else roster,
                            [reading(), reading("f2", 1.1)] if readings is None else readings,
                            MAPPING if mapping is None else mapping, game_date=DATE,
                            segment_id="s1", track_id="track-7", **kwargs)


def project():
    return {"id": "project", "revision": 4, "media": {"duration": 48, "sha256": "media"},
            "context": {"gameDate": DATE, "roster": copy.deepcopy(ROSTER)}, "observations": [
                {"id": "o1", "type": "shot", "start": 1, "end": 1.5, "anchorTime": 1.1,
                 "segmentId": "s1", "playerIds": ["p2"], "unknownActors": [], "frameIds": ["f1", "f2"],
                 "source": {"kind": "manual", "runId": None}, "review": {"status": "accepted"}}]}


def run():
    return {"mediaSha256": "media", "trustedExecution": True,
            "providerRun": {"id": "r1", "mode": "cv-executed", "provider": "real-detector", "requestHash": "request", "responseHash": "response"},
            "cvEvidence": {"samples": [
                {"frameTime": t, "segmentId": "s1", "objects": [{"trackId": "track-7", "classId": "player", "teamColorGroup": "white",
                                                                             "jerseyText": None, "jerseyScore": None}]}
                for t in [1, 1.1]], "diagnostics": {"unsupportedTasks": ["jersey", "action-recognition"]}}}


class IdentityEvidenceTests(unittest.TestCase):
    def test_dated_roster_and_two_readable_frames_propose_but_never_accept(self):
        result = candidate()
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["playerId"], "p2")
        self.assertTrue(result["reviewRequired"])
        self.assertNotIn("confidence", result)
        self.assertEqual(result["rosterEvidence"]["validOn"], DATE)

    def test_same_frame_duplicates_cannot_vote_twice(self):
        for rows in ([reading(), reading("f1", 1.1)], [reading(), reading("f2", 1)]):
            result = candidate(rows)
            self.assertEqual(result["status"], "unknown")
            self.assertIn("insufficient_distinct_readable_frames", result["reasons"])

    def test_low_quality_and_missing_quality_remain_unknown(self):
        for quality in ("low", None):
            rows = [reading(quality=quality), reading("f2", 1.1, quality=quality)]
            self.assertEqual(candidate(rows)["status"], "unknown")

    def test_team_color_or_track_name_does_not_create_identity(self):
        for mapping in ({}, {"white": "DAL"}, {"white": {"teamId": "DAL", "source": "model", "confirmed": False}}):
            self.assertIn("team_mapping_unconfirmed", candidate(mapping=mapping)["reasons"])

    def test_team_conflict_and_jersey_conflict_remain_unknown(self):
        teams = candidate([reading(), reading("f2", 1.1, teamColorGroup="red")])
        jerseys = candidate([reading(), reading("f2", 1.1, "25")])
        self.assertIn("contradictory_team_evidence", teams["reasons"])
        self.assertIn("contradictory_jersey_evidence", jerseys["reasons"])
        self.assertIsNone(jerseys["playerId"])

    def test_multiple_plausible_ocr_candidates_remain_unknown(self):
        rows = [reading(candidates=[{"text": "2", "score": .95}, {"text": "7", "score": .91}]), reading("f2", 1.1)]
        self.assertIn("ambiguous_jersey_reading", candidate(rows)["reasons"])

    def test_track_reappearing_after_cut_cannot_pool_identity(self):
        result = candidate([reading(), reading("f2", 1.1, segmentId="s2")])
        self.assertEqual(result["reasons"], ["cross_segment_identity_evidence"])

    def test_same_jersey_on_roster_twice_is_ambiguous(self):
        second = dict(ROSTER[0], id="other-player")
        self.assertIn("roster_identity_ambiguous", candidate(roster=ROSTER + [second])["reasons"])

    def test_stale_roster_and_missing_source_never_resolve(self):
        for player in (dict(ROSTER[0], validOn="2024-01-01"), dict(ROSTER[0], source=None)):
            self.assertIn("roster_date_or_source_unverified", candidate(roster=[player])["reasons"])

    def test_zero_and_double_zero_are_distinct(self):
        roster = [dict(ROSTER[0], id="zero", jersey="0"), dict(ROSTER[0], id="double-zero", jersey="00")]
        self.assertEqual(candidate([reading(jersey="00"), reading("f2", 1.1, "00")], roster=roster)["playerId"], "double-zero")


class VisionReadinessTests(unittest.TestCase):
    def codes(self, result):
        return {item["code"] for item in result["reviewQueue"]}

    def test_uses_real_schema_sidecars_without_mutating_review(self):
        p, r = project(), run()
        before = copy.deepcopy((p, r))
        result = assess(p, {"f1": 1, "f2": 1.1}, provider_runs=[r])
        self.assertEqual((p, r), before)
        self.assertEqual(result["counts"]["cvSamples"], 2)
        self.assertIn("identity_unresolved", self.codes(result))
        self.assertFalse(result["accuracyCertified"])
        self.assertFalse(result["automaticAcceptance"])
        json.dumps(result, allow_nan=False)

    def test_two_verified_ocr_frames_can_propose_identity(self):
        result = assess(project(), {"f1": 1, "f2": 1.1}, provider_runs=[run()],
                        ocr_readings=[reading(), reading("f2", 1.1)], confirmed_team_mapping=MAPPING)
        self.assertEqual(result["counts"]["identityCandidates"], 1)
        self.assertEqual(result["identityCandidates"][0]["playerId"], "p2")

    def test_forged_missing_or_wrong_pts_ocr_frame_is_rejected(self):
        for row in (reading("missing", 1.1), reading("f2", 1.3)):
            result = assess(project(), {"f1": 1, "f2": 1.1}, provider_runs=[run()],
                            ocr_readings=[reading(), row], confirmed_team_mapping=MAPPING)
            self.assertEqual(result["counts"]["identityCandidates"], 0)
            self.assertEqual(result["identityCandidates"][0]["reasons"], ["ocr_source_frame_missing_or_mismatched"])

    def test_other_video_frames_and_runs_cannot_support_event(self):
        wrong = dict(run(), mediaSha256="old-video")
        result = assess(project(), {"f1": {"actualTime": 1, "mediaSha256": "old-video"}}, provider_runs=[wrong])
        self.assertIn("source_frames_missing", self.codes(result))
        self.assertIn("provider_media_mismatch", self.codes(result))
        self.assertEqual(result["counts"]["cvSamples"], 0)
        self.assertEqual(result["status"], "blocked")

    def test_ocr_cannot_relabel_existing_detection_team_group(self):
        rows = [reading(teamColorGroup="red"), reading("f2", 1.1, teamColorGroup="red")]
        result = assess(project(), {"f1": 1, "f2": 1.1}, provider_runs=[run()],
                        ocr_readings=rows, confirmed_team_mapping={"red": MAPPING["white"]})
        self.assertEqual(result["counts"]["identityCandidates"], 0)
        self.assertEqual(result["identityCandidates"][0]["reasons"], ["ocr_source_frame_missing_or_mismatched"])

    def test_identity_conflict_with_named_event_is_not_automatically_corrected(self):
        p = project()
        p["observations"][0].update(playerIds=["another"], unknownActors=["track-7"])
        result = assess(p, {"f1": 1, "f2": 1.1}, provider_runs=[run()],
                        ocr_readings=[reading(), reading("f2", 1.1)], confirmed_team_mapping=MAPPING)
        self.assertIn("observation_identity_conflict", self.codes(result))
        self.assertEqual(p["observations"][0]["playerIds"], ["another"])

    def test_invalid_cv_pts_is_blocked_and_output_stays_finite(self):
        r = run()
        r["cvEvidence"]["samples"][0]["frameTime"] = float("nan")
        result = assess(project(), {"f1": 1, "f2": 1.1}, provider_runs=[r])
        self.assertIn("cv_sample_timing_invalid", self.codes(result))
        json.dumps(result, allow_nan=False)

    def test_imported_run_does_not_claim_real_execution(self):
        imported = dict(run(), trustedExecution=False)
        imported["providerRun"] = dict(imported["providerRun"], mode="cv-imported")
        result = assess(project(), {"f1": 1, "f2": 1.1}, provider_runs=[imported])
        self.assertIn("visual_execution_missing", self.codes(result))
        self.assertIn("provider_execution_unverified", self.codes(result))

    def test_sparse_detection_does_not_certify_actions_or_identity(self):
        r = run()
        r["cvEvidence"]["samples"] = r["cvEvidence"]["samples"][:1]
        result = assess(project(), {"f1": 1, "f2": 1.1}, provider_runs=[r])
        self.assertIn("single_frame_track", self.codes(result))
        self.assertEqual(result["counts"]["identityCandidates"], 0)
        self.assertIn("action-recognition", result["providerRuns"][0]["unsupportedTasks"])

    def test_reused_track_ids_across_cuts_are_explicitly_flagged(self):
        r = run()
        r["cvEvidence"]["samples"][1]["segmentId"] = "s2"
        result = assess(project(), {"f1": 1, "f2": 1.1}, provider_runs=[r])
        self.assertIn("track_reused_across_segments", self.codes(result))
        self.assertEqual(result["counts"]["tracks"], 2)

    def test_stale_named_roster_and_missing_frame_block_even_accepted_event(self):
        p = project()
        p["context"]["roster"][0]["validOn"] = "2024-01-01"
        p["observations"][0]["frameIds"] = ["deleted"]
        result = assess(p, {}, provider_runs=[run()])
        self.assertIn("source_frames_missing", self.codes(result))
        self.assertIn("observation_roster_unverified", self.codes(result))

    def test_unreviewed_model_event_never_becomes_accepted(self):
        p = project()
        p["observations"][0].update(source={"kind": "model", "runId": "missing"}, review={"status": "unreviewed"})
        result = assess(p, {"f1": 1, "f2": 1.1}, provider_runs=[run()])
        self.assertIn("observation_review_required", self.codes(result))
        self.assertIn("observation_run_unverified", self.codes(result))
        self.assertEqual(p["observations"][0]["review"]["status"], "unreviewed")

    def test_single_frame_result_and_outside_anchor_need_reinspection(self):
        p = project()
        p["observations"][0].update(type="result", frameIds=["f1"], anchorTime=1.5)
        result = assess(p, {"f1": 1}, provider_runs=[run()])
        self.assertIn("event_context_insufficient", self.codes(result))
        self.assertIn("event_anchor_needs_frame_review", self.codes(result))

    def test_reinspection_is_bounded_with_many_bad_observations(self):
        p = project()
        p["observations"] = [dict(p["observations"][0], id=f"o{i}", start=i * 5, end=i * 5 + 2, anchorTime=i * 5 + 1, frameIds=[]) for i in range(9)]
        result = assess(p, {}, provider_runs=[run()])
        self.assertEqual(len(result["reinspectionWindows"]), 2)
        for window in result["reinspectionWindows"]:
            self.assertLessEqual(window["end"] - window["start"], 4)
            self.assertGreaterEqual(window["start"], 0)
            self.assertLessEqual(window["end"], 48)

    def test_rejected_bad_observation_is_excluded(self):
        p = project()
        p["observations"][0].update(start=-1, frameIds=["deleted"], review={"status": "rejected"})
        result = assess(p, {}, provider_runs=[])
        self.assertNotIn("event_timing_invalid", self.codes(result))
        self.assertIn("events_missing", self.codes(result))

    def test_accepted_manual_event_does_not_certify_missing_model(self):
        result = assess(project(), {"f1": 1, "f2": 1.1})
        self.assertIn("visual_execution_missing", self.codes(result))
        self.assertFalse(result["accuracyCertified"])


if __name__ == "__main__":
    unittest.main()
