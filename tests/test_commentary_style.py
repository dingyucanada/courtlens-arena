import json
import unittest

from core.broadcast.commentary_style import capability_styles, resolve_style
from core.broadcast.common import BroadcastError
from core.broadcast.providers.story_model import normalize_proposal, story_prompt
from core.broadcast.validation import grounded_wording


class CommentaryStyleTest(unittest.TestCase):
    def test_profiles_and_default_are_explicit(self):
        self.assertEqual(resolve_style()["id"], "zh-analysis")
        self.assertEqual({x["id"] for x in capability_styles()}, {"zh-analysis", "en-live", "yue-live"})
        with self.assertRaises(BroadcastError):
            resolve_style("unknown")

    def test_prompt_uses_selected_original_rules_and_only_accepted_actors(self):
        project = {"id":"c"*32,"revision":1,"media":{"duration":8},"observations":[{"id":"a"*32,"type":"other","start":0,"end":1,"anchorTime":None,"segmentId":"b"*32,"description":"A player moves left.","playerIds":[],"frameIds":[],"review":{"status":"accepted"}}],"bindings":[],"metrics":None,"context":{"roster":[]}}
        prompt = story_prompt(project, "fan", {}, "en-live")
        self.assertIn("original English play-by-play", prompt)
        self.assertIn('"commentaryStyle":"en-live"', prompt)
        self.assertNotIn('"tacticCandidates"', prompt)

    def test_model_proposal_errors_distinguish_count_and_fields(self):
        project = {"media":{"duration":8}}
        with self.assertRaisesRegex(BroadcastError, "1–3"):
            normalize_proposal(project,"fan",json.dumps({"title":"x","beats":[{}]*4}),{},"en-live")
        with self.assertRaisesRegex(BroadcastError, "顶层"):
            normalize_proposal(project,"fan",json.dumps({"label":"x","beats":[{}]}),{},"en-live")
        with self.assertRaisesRegex(BroadcastError, "节点字段"):
            normalize_proposal(project,"fan",json.dumps({"title":"x","beats":[{}]}),{},"en-live")

    def test_english_and_cantonese_result_claims_require_result_evidence(self):
        shot = [{"type":"shot","playerIds":[],"description":"A shot is released."}]
        result = [{"type":"result","playerIds":[],"description":"The shot goes in."}]
        claims = ["He scores!", "It is good!", "It's good!", "It’s good!", "He lays it in.", "He might score.", "射中！", "入咗！", "中咗！", "球進了！"]
        for claim in claims:
            with self.subTest(claim=claim):
                with self.assertRaises(BroadcastError):
                    grounded_wording(claim, shot, [])
                grounded_wording(claim, result, [])

    def test_approved_jersey_spelling_can_be_cantonese_or_english(self):
        person = "p" * 32
        evidence = [{"type":"movement","playerIds":[person],"description":"白衣25号切入。"}]
        roster = [{"id":person,"jersey":25}]
        grounded_wording("25號沿底線切入", evidence, roster)
        grounded_wording("#25 cuts baseline", evidence, roster)
        grounded_wording("No. 25 cuts baseline", evidence, roster)
        with self.assertRaises(BroadcastError):
            grounded_wording("#26 cuts baseline", evidence, roster)

    def test_english_metric_words_require_source_but_ordinary_play_words_pass(self):
        evidence = [{"type":"movement","playerIds":[],"description":"The player moves."}]
        for text in ("eighty percent", "ninety percent chance", "two meters", "three seconds", "five rebounds", "six points"):
            with self.subTest(text=text), self.assertRaises(BroadcastError):
                grounded_wording(text, evidence, [])
        grounded_wording("one more pass", evidence, [])
        grounded_wording("a three-pointer develops", evidence, [])


if __name__ == "__main__":
    unittest.main()
