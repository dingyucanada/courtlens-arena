"""Tactic lookup uses dated sources and only past, reviewed visual evidence."""
import tempfile
import unittest
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.routes import BroadcastRoutes
from core.broadcast.tactics import catalogue, retrieve


def observation(oid, kind, description, start=1, end=2, segment="shot-a", status="accepted", frame_id=None):
    return {"id": oid, "type": kind, "start": start, "end": end, "segmentId": segment,
            "description": description, "frameIds": [frame_id or oid], "review": {"status": status}}


def project(rows=None, date="2025-01-01", season="2024-25"):
    return {"id": "p" * 32, "revision": 3, "media": {"duration": 48},
            "context": {"gameDate": date, "seasonId": season, "offenseTeamId": "DAL",
                        "roster": [{"teamId": "DAL"}, {"teamId": "HOU"}],
                        "playByPlay": {"entries": [{"text": "Player makes pick and roll"}]}},
            "observations": rows or []}


class TacticLookupTest(unittest.TestCase):
    def test_catalogue_has_sourced_conditional_concepts(self):
        entries = catalogue()["catalogue"]
        self.assertEqual(len(entries), 10)
        self.assertTrue(all(item["sources"] and item["conditionalCommentary"].startswith("如果") for item in entries))

    def test_basic_screen_cannot_be_promoted_to_pick_and_roll(self):
        rows = [observation("screen", "screen", "红28为持球人设置掩护", 1, 2)]
        result = retrieve(project(rows), {"screen": 2}, 2)
        found = {item["id"]: item for item in result["candidates"]}
        self.assertEqual(found["screen"]["match"], "rule-candidate")
        self.assertEqual(found["pick-and-roll"]["match"], "needs-evidence")
        self.assertIn("掩护者顺下", found["pick-and-roll"]["missingCues"])
        self.assertNotIn("pick-and-roll", [row["id"] for row in retrieve(project(rows), {"screen": 2}, 1.9)["candidates"]])

    def test_same_segment_roll_can_match_but_other_shot_cannot(self):
        rows = [observation("screen", "screen", "队友给持球者设置掩护", 1, 2),
                observation("roll", "movement", "掩护人顺下切向篮下", 3, 4)]
        frames = {"screen": 2, "roll": 4}
        supported = {item["id"]: item for item in retrieve(project(rows), frames, 4)["candidates"]}
        self.assertEqual(supported["pick-and-roll"]["match"], "rule-candidate")
        self.assertEqual(supported["pick-and-roll"]["observationIds"], ["screen", "roll"])
        rows[1]["segmentId"] = "shot-b"
        split = {item["id"]: item for item in retrieve(project(rows), frames, 4)["candidates"]}
        self.assertEqual(split["pick-and-roll"]["match"], "needs-evidence")
        rows[1]["segmentId"] = "shot-a"
        rows[1]["start"], rows[1]["end"] = 15, 16
        self.assertEqual({item["id"]: item for item in retrieve(project(rows), {"screen": 2, "roll": 16}, 16)["candidates"]}["pick-and-roll"]["match"], "needs-evidence")

    def test_negation_reverse_order_and_explicit_actor_conflict_never_complete_roll(self):
        scenarios = [
            (observation("screen", "screen", "红队给持球人设置掩护", 1, 2),
             observation("roll", "movement", "没有看到掩护者顺下", 3, 4)),
            (observation("screen", "screen", "给持球人设置掩护", 3, 4),
             observation("roll", "movement", "掩护者顺下", 1, 2)),
            (observation("screen", "screen", "红队28号为持球人设置掩护", 1, 2),
             observation("roll", "movement", "红队5号掩护者顺下", 3, 4)),
            (observation("screen", "screen", "给持球人设置掩护", 1, 2),
             observation("roll", "movement", "screener did not roll", 3, 4)),
        ]
        for screen, roll in scenarios:
            with self.subTest(roll=roll["description"]):
                found = {item["id"]: item for item in retrieve(project([screen, roll]),
                    {"screen": screen["end"], "roll": roll["end"]}, 4)["candidates"]}
                self.assertEqual(found["pick-and-roll"]["match"], "needs-evidence")

    def test_never_use_future_frames_unreviewed_or_pbp_outcomes(self):
        rows = [observation("screen", "screen", "为持球者掩护", 1, 2),
                observation("roll", "movement", "掩护人顺下", 3, 4, status="unreviewed"),
                observation("pbp", "result", "ESPN says pick and roll made", 5, 6)]
        found = {item["id"]: item for item in retrieve(project(rows), {"screen": 2, "roll": 4, "pbp": 6}, 10)["candidates"]}
        self.assertEqual(found["pick-and-roll"]["match"], "needs-evidence")
        self.assertNotIn("pbp", found["pick-and-roll"]["observationIds"])
        rows[1]["review"]["status"] = "accepted"
        self.assertEqual(retrieve(project(rows), {"screen": 2, "roll": 11, "pbp": 6}, 10)["candidates"][0]["id"], "screen")

    def test_dated_team_context_is_separate_from_evidence(self):
        on_date = retrieve(project(), {}, 0)
        self.assertEqual({item["teamId"] for item in on_date["teamContext"]}, {"DAL", "HOU"})
        self.assertEqual(on_date["candidates"], [])
        self.assertEqual(retrieve(project(date=None), {}, 0)["teamContext"], [])
        self.assertEqual(retrieve(project(date="2024-12-01"), {}, 0)["teamContext"], [])
        self.assertEqual(retrieve(project(date="2026-01-01", season="2025-26"), {}, 0)["teamContext"], [])

    def test_get_route_rejects_bad_time_and_returns_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            routes = BroadcastRoutes(root)
            p = project([observation("screen", "screen", "队友为持球者掩护")])
            with patch.object(routes.service, "get", return_value=p), patch.object(routes.service, "_frame_times", return_value={"screen": 2}):
                status, result = routes.dispatch_json("GET", "/api/broadcast/v1/tactics?projectId=" + p["id"] + "&at=2&q=挡拆")
                self.assertEqual(status, 200)
                self.assertEqual(result["projectRevision"], 3)
                self.assertIn("pick-and-roll", {row["id"] for row in result["candidates"]})
                for bad in ("nan", "49", "banana"):
                    with self.assertRaises(BroadcastError):
                        routes.dispatch_json("GET", "/api/broadcast/v1/tactics?projectId=" + p["id"] + "&at=" + bad)


if __name__ == "__main__":
    unittest.main()
