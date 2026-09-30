"""Source binding and review boundaries for the optional basketball CV command."""

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from core.broadcast.common import BroadcastError
from core.broadcast.providers.cv_command import normalize, validate_result


ROOT = Path(__file__).resolve().parent.parent


class BasketballCVContractTest(unittest.TestCase):
    def test_capabilities_are_offline_and_do_not_claim_unsupported_tasks(self):
        env = {**os.environ, "COURTLENS_CV_BACKEND": "basketball"}
        result = subprocess.run([sys.executable, str(ROOT / "tools" / "cv_rfdetr.py"), "--capabilities"],
                                check=True, capture_output=True, env=env, timeout=3)
        capabilities = json.loads(result.stdout)
        self.assertEqual(capabilities["schema"], "courtlens-cv-capabilities/1")
        self.assertEqual(capabilities["providerId"], "hf-rfdetr-basketball-bytetrack")
        self.assertEqual(capabilities["tasks"], ["detect", "track"])
        self.assertNotIn("jersey", capabilities["tasks"])
        if capabilities["available"]:
            self.assertTrue(capabilities["model"]["weightsPresent"])

    def test_result_rejects_wrong_source_and_normalizes_only_unreviewed_unknown_track(self):
        source_hash = "a" * 64
        project = {"media": {"sha256": source_hash, "duration": 5}, "context": {"roster": []}}
        result = {
            "schema": "courtlens-cv-result/1", "mediaSha256": source_hash,
            "provider": {"id": "hf-rfdetr-basketball-bytetrack", "version": "1+46c3308", "weightsSha256": "b" * 64},
            "samples": [{"frameTime": 1.0, "segmentId": "s1", "objects": [{
                "trackId": "s1-t1", "classId": "player", "score": .86,
                "bbox": [.2, .2, .1, .3], "jerseyText": None, "jerseyScore": None,
                "teamColorGroup": "visual-color-a", "keypoints": []}]}],
            "events": [{"type": "other", "start": 1.0, "end": 1.5, "confidence": .86,
                        "trackIds": ["s1-t1"], "description": "检测到球员候选轨迹；姓名和动作待人工确认"}],
            "diagnostics": {"framesProcessed": 1, "elapsedMs": 10},
        }
        validate_result(result, project, {"start": 0, "end": 2})
        observation = normalize(result, project, "run1", "cv-executed")[0]
        self.assertEqual(observation["playerIds"], [])
        self.assertEqual(observation["unknownActors"], ["s1-t1"])
        self.assertEqual(observation["review"]["status"], "unreviewed")
        self.assertIsNone(observation["geometry"])
        self.assertEqual(observation["source"], {"kind": "cv", "runId": "run1", "recordId": None})
        result["mediaSha256"] = "c" * 64
        with self.assertRaises(BroadcastError) as raised:
            validate_result(result, project, {"start": 0, "end": 2})
        self.assertEqual(raised.exception.code, "media_mismatch")


if __name__ == "__main__":
    unittest.main()
