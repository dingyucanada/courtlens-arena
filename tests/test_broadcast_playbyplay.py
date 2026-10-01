import copy
import json
import unittest

from core.broadcast.common import BroadcastError
from core.broadcast.playbyplay import available_at, draft_cues, validate_cues
from core.broadcast.providers.story_model import normalize_proposal, story_prompt
from core.broadcast.schema import validate as validate_shape
from core.broadcast.validation import content_hash, story as validate_story


def observation(oid="move", kind="movement", start=0, end=1, description="持球人沿边线移动。"):
    return {"id": oid, "type": kind, "start": start, "end": end, "anchorTime": None,
            "segmentId": "segment", "description": description, "playerIds": [], "unknownActors": [],
            "frameIds": [], "source": {"kind": "manual", "runId": None, "recordId": None},
            "confidence": None, "review": {"status": "accepted", "actor": "editor", "at": "2026-10-01", "reason": None}, "geometry": None}


def project(language="zh-CN"):
    return {"id": "project", "revision": 1, "media": {"duration": 20}, "context": {"roster": []}, "observations": [observation()],
            "bindings": [], "metrics": None,
            "story": {"schema": "courtlens-broadcast-story/1", "title": "动作", "audience": "fan",
                      "language": language, "commentaryStyle": "analysis", "sourceRange": {"start": 0, "end": 20},
                      "beats": [{"id": "beat", "label": "移动", "sourceStart": 1, "sourceEnd": 3, "anchorTime": 1,
                                 "text": "持球人沿边线移动。", "observationIds": ["move"], "bindingIds": [],
                                 "explanationKind": "visible-fact", "metricRecordId": None, "secondaryLabel": None, "annotation": None}]}}


def cue(text="持球人向左移动。", start=1, end=3, refs=None, language="zh-CN", cid="cue"):
    return {"id": cid, "sourceStart": start, "sourceEnd": end, "text": text,
            "observationIds": ["move"] if refs is None else refs, "language": language}


class PlayByPlayTest(unittest.TestCase):
    def test_legacy_omission_and_explicit_silence_are_valid(self):
        p = project()
        validate_shape(p["story"], "story")
        validate_story(p, {})
        p["story"]["commentaryCues"] = []
        validate_shape(p["story"], "story")
        validate_story(p, {})

    def test_more_than_three_spoken_events_do_not_expand_visual_beats(self):
        p = project()
        p["observations"] = [observation(f"event{i}", start=i * 3, end=i * 3 + 1) for i in range(5)]
        p["story"]["beats"][0]["observationIds"] = ["event0"]
        p["story"]["commentaryCues"] = [cue(start=i * 3 + 1, end=i * 3 + 2, refs=[f"event{i}"], cid=f"cue{i}") for i in range(5)]
        validate_shape(p["story"], "story")
        validate_story(p, {})
        self.assertEqual(len(p["story"]["beats"]), 1)

    def test_all_three_original_languages_validate_without_metrics(self):
        for language, text in (("zh-CN", "球传到底角。"), ("en-US", "The ball swings to the corner."), ("yue-HK", "傳去底角，接波。")):
            with self.subTest(language=language):
                p = project(language)
                p["story"]["commentaryCues"] = [cue(text, language=language)]
                validate_story(p, {})
                prompt = story_prompt(p, "fan", {}, "analysis", language)
                evidence = json.loads(prompt.split("输入JSON：", 1)[1])
                self.assertEqual(evidence["spokenLane"]["language"], language)
                self.assertNotIn("value", evidence["spokenLane"])

    def test_decoder_float_roundoff_does_not_block_a_valid_frame_grid(self):
        p=project();p['observations'][0]['frameIds']=['f']
        p['story']['commentaryCues']=[cue()]
        validate_cues(p,{'f':1.0000000000000002})
        with self.assertRaises(BroadcastError):validate_cues(p,{'f':1.04})

    def test_future_and_stale_events_cannot_fill_empty_spans(self):
        for start, end in ((.9, 2), (4.01, 6), (19, 21)):
            with self.subTest(start=start), self.assertRaises(BroadcastError):
                p = project()
                p["story"]["commentaryCues"] = [cue(start=start, end=end)]
                validate_cues(p, {})

    def test_anchored_action_waits_for_every_real_frame(self):
        o = observation(kind="pass", end=5)
        o.update(anchorTime=1, frameIds=["frame1", "frame2"])
        self.assertEqual(available_at(o, {"frame1": 1, "frame2": 1.2}), 1.2)
        self.assertEqual(available_at(o, {"frame1": 1}), 5)
        self.assertEqual(available_at(o, None), 5)
        self.assertEqual(available_at(o, {"frame1": 1, "frame2": 6}), 6)
        p = project()
        p["observations"] = [o]
        p["story"]["commentaryCues"] = [cue(start=1, end=2)]
        with self.assertRaises(BroadcastError):
            validate_cues(p, {"frame1": 1, "frame2": 1.2})
        p["story"]["commentaryCues"][0]["sourceStart"] = 1.2
        validate_cues(p, {"frame1": 1, "frame2": 1.2})

    def test_result_cannot_be_announced_at_shot_anchor(self):
        p = project()
        o = observation(kind="result", end=5, description="球进入篮筐。")
        o.update(anchorTime=1, frameIds=["frame"])
        p["observations"] = [o]
        p["story"]["commentaryCues"] = [cue("入咗！", start=1, end=2)]
        with self.assertRaises(BroadcastError):
            validate_cues(p, {"frame": 1})
        p["story"]["commentaryCues"][0].update(sourceStart=5, sourceEnd=6)
        validate_cues(p, {"frame": 1})
        p["observations"][0]["type"] = "shot"
        with self.assertRaises(BroadcastError):
            validate_cues(p, {"frame": 1})

    def test_short_missed_and_english_finish_calls_still_require_result_evidence(self):
        for text in ("没进。", "沒進。", "It's in!", "It drops through."):
            p = project()
            p["story"]["commentaryCues"] = [cue(text)]
            with self.subTest(text=text), self.assertRaises(BroadcastError):
                validate_cues(p, {})

    def test_default_spoken_lane_does_not_read_metrics_or_probability(self):
        for text in ("胜率上升。", "勝率好高。", "Win probability rises.", "xFG improves.", "xFG较低。", "GRAV is high.", "LVG matters.",
                     "命中率百分之八十。", "Eighty percent.", "Eighty per cent.", "{{metric:record}}", "23%", "{{broken"):
            with self.subTest(text=text), self.assertRaises(BroadcastError):
                p = project()
                p["story"]["commentaryCues"] = [cue(text)]
                validate_cues(p, {})

    def test_overlaps_duplicate_ids_wrong_language_and_unreviewed_refs_fail(self):
        invalid = [[cue(), cue(start=2, end=4, cid="next")], [cue(), cue(start=3, end=4)],
                   [cue(language="en-US")], [cue(refs=["unknown"])], [cue(refs=["move", "move"])],
                   [cue(end=10)], [cue(refs=[[]])], [cue(), {**cue(), "voiceClone": "celebrity"}]]
        for cues in invalid:
            with self.subTest(cues=cues), self.assertRaises(BroadcastError):
                p = project()
                p["story"]["commentaryCues"] = cues
                validate_cues(p, {})
        p = project()
        p["observations"][0]["review"]["status"] = "unreviewed"
        p["story"]["commentaryCues"] = [cue()]
        with self.assertRaises(BroadcastError):
            validate_cues(p, {})

    def test_spoken_changes_are_part_of_review_hash(self):
        p = project()
        p["story"]["commentaryCues"] = [cue()]
        before = content_hash(p)
        p["story"]["commentaryCues"][0]["text"] = "持球人停下来。"
        self.assertNotEqual(before, content_hash(p))

    def test_unrelated_roster_name_cannot_enter_spoken_action(self):
        p = project()
        p["context"]["roster"] = [{"id": "unused", "name": "Bench Player"}]
        p["story"]["commentaryCues"] = [cue("Bench Player moves.")]
        with self.assertRaises(BroadcastError):
            validate_cues(p, {})
        p["observations"][0]["playerIds"] = ["unused"]
        validate_cues(p, {})

    def test_named_tactics_cannot_bypass_existing_evidence_gate_in_spoken_lane(self):
        p = project()
        p["story"]["commentaryCues"] = [cue("这是挡拆顺下。")]
        with self.assertRaises(BroadcastError):
            validate_story(p, {})

    def test_result_templates_require_explicit_unambiguous_outcome_in_all_languages(self):
        for description, outcome in (("投篮命中。", "made"), ("投篮未能命中。", "missed"),
                                     ("球进了。", "made"), ("可能投篮命中。", None),
                                     ("投篮未能命中，补篮命中。", None), ("投篮结果待确认。", None)):
            for language in ("zh-CN", "en-US", "yue-HK"):
                with self.subTest(description=description, language=language):
                    p = project(language)
                    p["observations"] = [observation(kind="result", description=description)]
                    rows = draft_cues(p, {}, language)
                    self.assertEqual(bool(rows), outcome is not None)
                    if rows:
                        p["story"]["commentaryCues"] = rows
                        validate_cues(p, {})

    def test_templates_preserve_short_reviewed_text_and_simplify_long_descriptions(self):
        p = project()
        p["observations"] += [observation("long", start=4, end=5, description="这是很长的一段观察，需要先看清比赛中的动作与配合，再决定是否能完整说出来。"),
                              observation("metric", start=8, end=9, description="xFG较低。")]
        rows = draft_cues(p, {})
        self.assertEqual([r["text"] for r in rows], [p["observations"][0]["description"], "球员在跑动。"])
        self.assertEqual(rows[0]["sourceStart"], 1)
        self.assertEqual([r["text"] for r in draft_cues(p, {}, "en-US")], ["A player on the move."] * 2)
        self.assertEqual([r["text"] for r in draft_cues(p, {}, "yue-HK")], ["球員喺度走位。"] * 2)

    def test_model_cues_normalize_and_validate_without_metric_coupling(self):
        p = project()
        b = {k: v for k, v in p["story"]["beats"][0].items() if k != "id"}
        c = {k: v for k, v in cue().items() if k != "id"}
        raw = {"title": "现场", "beats": [b], "commentaryCues": [c]}
        result = normalize_proposal(p, "fan", json.dumps(raw), {}, "analysis", "zh-CN")
        self.assertEqual(result["commentaryCues"][0]["observationIds"], ["move"])
        validate_shape(result, "story")
        raw["commentaryCues"][0]["text"] = "Win probability rises."
        with self.assertRaises(BroadcastError):
            normalize_proposal(p, "fan", json.dumps(raw), {}, "analysis", "zh-CN")


class OutcomeNegationRegression(unittest.TestCase):
    def test_negative_outcome_never_becomes_a_made_basket_in_any_language(self):
        from core.broadcast.playbyplay import _action_text,ACTION_TEXT
        for text in ("投篮未命中。","The shot was not made.","The shot didn't make it.","这个球没有投进。","这个球没投进。"):
            for language in ACTION_TEXT:
                event={"type":"result","description":text,"playerIds":[]}
                self.assertEqual(_action_text(event,[],language),ACTION_TEXT[language]["missed"],(text,language))
        for text in ("The shot was not missed.","并非未命中。","The shot wasn't made.","The shot was never made."):
            self.assertIsNone(_action_text({"type":"result","description":text,"playerIds":[]},[],"zh-CN"))

if __name__ == "__main__":
    unittest.main()
