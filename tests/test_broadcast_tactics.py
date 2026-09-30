"""Tactic lookup uses dated sources and only past, reviewed visual evidence."""
import json
import tempfile
import unittest
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.routes import BroadcastRoutes
from core.broadcast.tactics import catalogue, retrieve, draft_context
from core.broadcast.providers.story_model import normalize_proposal, story_prompt
from core.broadcast.validation import story as validate_story


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

    def test_multilingual_term_lookup_and_sourced_draft_context(self):
        rows = [observation("screen", "screen", "队友给持球者设置掩护", 1, 2),
                observation("roll", "movement", "掩护人顺下切向篮下", 3, 4),
                observation("future", "movement", "防守者后来换防", 8, 9, status="unreviewed")]
        for row in rows:
            row.update(anchorTime=None, playerIds=[], unknownActors=[])
        p = project(rows)
        p.update(bindings=[], metrics=None)
        p["context"]["roster"] = []
        frames = {"screen": 2, "roll": 4, "future": 9}
        self.assertEqual([row["id"] for row in retrieve(p, frames, 4, "pick-and-roll")["catalogue"]], ["pick-and-roll"])
        context = draft_context(p, frames, [{"id": "screen", "earliestCueStart": 2}, {"id": "roll", "earliestCueStart": 4}])
        first = {row["id"]: row for row in context[0]["candidates"]}
        second = {row["id"]: row for row in context[1]["candidates"]}
        self.assertEqual(first["pick-and-roll"]["match"], "needs-evidence")
        self.assertEqual(second["pick-and-roll"]["match"], "rule-candidate")
        self.assertEqual(second["pick-and-roll"]["observationIds"], ["screen", "roll"])
        self.assertTrue(second["pick-and-roll"]["sources"][0]["url"].startswith("https://"))
        self.assertNotIn("future", json.dumps(context, ensure_ascii=False))
        prompt = story_prompt(p, "pro", frames)
        evidence = json.loads(prompt.split("输入JSON：", 1)[1])
        self.assertEqual(evidence["tacticKnowledge"], context)
        self.assertIn("术语来源，不证明本片", prompt)

    def test_named_play_requires_complete_cited_prior_visual_cues(self):
        screen = observation("screen", "screen", "队友给持球者设置掩护", 1, 2)
        roll = observation("roll", "movement", "掩护人顺下切向篮下", 3, 4)
        p = project([screen, roll])
        p.update(bindings=[], metrics=None)
        beat = {"label": "战术候选", "sourceStart": 4, "sourceEnd": 7, "anchorTime": 4,
                "observationIds": ["screen", "roll"], "bindingIds": [], "text": "如果是挡拆顺下，篮下可能出现机会。",
                "explanationKind": "interpretation", "metricRecordId": None, "secondaryLabel": None, "annotation": None}
        frames = {"screen": 2, "roll": 4}
        raw = lambda: json.dumps({"title": "片段", "beats": [beat]}, ensure_ascii=False)
        p["context"]["roster"] = []
        for row in p["observations"]:
            row.update(anchorTime=None, playerIds=[], unknownActors=[], source={"kind": "manual"},
                       review={"status": "accepted", "actor": "tester", "at": "2026-09-30"})
        self.assertEqual(normalize_proposal(p, "pro", raw(), frames)["beats"][0]["text"], beat["text"])
        beat["observationIds"] = ["screen"]
        with self.assertRaises(BroadcastError):
            normalize_proposal(p, "pro", raw(), frames)
        beat["observationIds"] = ["screen", "roll"]
        beat["sourceStart"] = 2
        with self.assertRaises(BroadcastError):
            normalize_proposal(p, "pro", raw(), frames)
        beat["sourceStart"] = 4
        beat["explanationKind"] = "visible-fact"
        with self.assertRaises(BroadcastError):
            normalize_proposal(p, "pro", raw(), frames)

    def _final_project(self, rows, text="球员沿边线移动。", kind="visible-fact"):
        p = project(rows)
        p.update(bindings=[], metrics=None)
        p["context"]["roster"] = []
        for row in rows:
            row.update(anchorTime=None, playerIds=[], unknownActors=[], source={"kind": "manual"},
                       review={"status": "accepted", "actor": "tester", "at": "2026-09-30"})
        p["story"] = {"schema": "courtlens-broadcast-story/1", "title": "测试", "audience": "fan",
            "sourceRange": {"start": 0, "end": 48}, "beats": [{"id": "beat", "label": "动作",
            "sourceStart": 4, "sourceEnd": 8, "anchorTime": 4, "observationIds": [row["id"] for row in rows],
            "bindingIds": [], "text": text, "explanationKind": kind, "metricRecordId": None,
            "secondaryLabel": None, "annotation": None}]}
        return p

    def test_final_story_rejects_named_tactic_bypass_in_each_display_field_and_language(self):
        for field in ("text", "label", "secondaryLabel"):
            for claim in ("这是挡拆顺下。", "這是擋拆順下。", "This is a pick and roll."):
                with self.subTest(field=field, claim=claim):
                    p = self._final_project([observation("move", "movement", "球员沿边线移动。")])
                    p["story"]["beats"][0][field] = claim
                    with self.assertRaises(BroadcastError):
                        validate_story(p, {"move": 2})

    def test_english_negation_cannot_support_conditional_handoff(self):
        for description in ("There was no handoff; the ballhandler kept the ball.",
                            "The passer did not make a handoff.", "A handoff might happen.",
                            "球员并非进行手递手，仍自己持球。",
                            "球員並非進行手遞手，仍自己持球。",
                            "未发生手递手。", "并不进行手递手。"):
            p = self._final_project([observation("pass", "pass", description)], "This may be a handoff.", "interpretation")
            with self.subTest(description=description), self.assertRaises(BroadcastError):
                validate_story(p, {"pass": 2})

    def test_pure_visible_action_paraphrase_uses_complete_prior_cues(self):
        p = self._final_project([observation("screen", "screen", "球员为无球队友设置掩护。")],
                                "球员进行无球掩护。")
        self.assertTrue(validate_story(p, {"screen": 2}))
        p["story"]["beats"][0]["text"] = "球員進行無球掩護。"
        self.assertTrue(validate_story(p, {"screen": 2}))
        with self.assertRaises(BroadcastError):
            validate_story(p, {"screen": 5})
        p = self._final_project([observation("move", "movement", "球员沿边线移动。")])
        self.assertTrue(validate_story(p, {"move": 2}))

    def test_supported_interpretation_requires_conditional_text_and_named_labels(self):
        p = self._final_project([observation("screen", "screen", "给持球人设置掩护。", 1, 2),
                                observation("roll", "movement", "掩护者顺下。", 3, 4)],
                                "如果是挡拆顺下，篮下可能出现机会。", "interpretation")
        frames = {"screen": 2, "roll": 4}
        self.assertTrue(validate_story(p, frames))
        beat = p["story"]["beats"][0]
        beat["label"] = "挡拆顺下"
        with self.assertRaises(BroadcastError):
            validate_story(p, frames)
        beat["label"] = "可能的挡拆顺下"
        self.assertTrue(validate_story(p, frames))
        from core.broadcast.tactics import story_knowledge
        refs = story_knowledge(p, frames, p["story"])
        self.assertEqual(refs[0]["beatId"], "beat")
        self.assertEqual(refs[0]["candidates"][0]["observationIds"], ["screen", "roll"])
        self.assertTrue(refs[0]["candidates"][0]["sources"])
        beat["text"] = "这是挡拆顺下。"
        with self.assertRaises(BroadcastError):
            validate_story(p, frames)

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
