import json
import tempfile
import unittest
from pathlib import Path

from tools.evaluate_broadcast_blind import evaluate, load_inputs


class BlindEvaluationTest(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 64
        self.gold = {"schema": "courtlens-blind-gold/1", "mediaSha256": self.sha,
                     "sceneCuts": [5.0], "events": [
                         {"id": "e1", "anchorTime": 2.0, "type": "pass", "playerId": "p1", "evidence": "source frames + independent play record"},
                         {"id": "e2", "anchorTime": 7.0, "type": "shot", "playerId": "p2", "evidence": "source frames + independent play record"}]}
        self.project = {"schema": "courtlens-broadcast/1", "media": {"sha256": self.sha, "duration": 10.0},
                        "observations": [
                            {"id": "o1", "type": "pass", "start": 1.8, "end": 2.2, "anchorTime": 2.1,
                             "playerIds": ["p1"], "source": {"kind": "model"}},
                            {"id": "o2", "type": "result", "start": 6.8, "end": 7.2, "anchorTime": 7.1,
                             "playerIds": ["wrong"], "source": {"kind": "model"}},
                            {"id": "o3", "type": "shot", "start": 4.7, "end": 5.3, "anchorTime": None,
                             "playerIds": [], "source": {"kind": "model"}},
                            {"id": "track", "type": "other", "start": 1.9, "end": 2.1, "anchorTime": None,
                             "playerIds": [], "source": {"kind": "cv"}}]}

    def test_mixed_errors_and_cv_exclusion_are_counted_without_claiming_outcomes(self):
        result = evaluate(self.gold, self.project, tolerance=.5, min_gold=2)
        self.assertEqual(result["counts"]["matched"], 2)
        self.assertEqual(result["counts"]["unmatchedCandidates"], 1)
        self.assertEqual(result["counts"]["actionCorrect"], 1)
        self.assertEqual(result["counts"]["identityIncorrect"], 1)
        self.assertEqual(result["counts"]["crossCutCandidates"], 1)
        self.assertEqual(result["recall"], 1.0)
        self.assertEqual(result["precision"], .6667)
        self.assertNotIn("outcomeCorrect", result["counts"])

    def test_exact_video_hash_is_required_before_scoring(self):
        with tempfile.TemporaryDirectory() as tmp:
            gold_path, project_path = Path(tmp) / "gold.json", Path(tmp) / "project.json"
            gold_path.write_text(json.dumps(self.gold), encoding="utf-8")
            project_path.write_text(json.dumps({**self.project, "media": {"sha256": "b" * 64, "duration": 10}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "exact video SHA-256"):
                load_inputs(gold_path, project_path)

    def test_incomplete_gold_is_visible(self):
        result = evaluate(self.gold, self.project, min_gold=10)
        self.assertFalse(result["goldComplete"])
        self.assertEqual(result["minimumGoldEvents"], 10)

    def test_primary_identity_must_be_first_claimed_player(self):
        self.project["observations"][0]["playerIds"] = ["wrong", "p1"]
        result = evaluate(self.gold, self.project, min_gold=2)
        self.assertEqual(result["counts"]["identityCorrect"], 0)
        self.assertEqual(result["counts"]["identityIncorrect"], 2)


if __name__ == "__main__":
    unittest.main()
