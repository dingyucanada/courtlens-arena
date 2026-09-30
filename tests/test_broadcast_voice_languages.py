import os
import unittest
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.commentary_style import capability_styles
from core.broadcast.providers import voice


class BroadcastVoiceLanguageTest(unittest.TestCase):
    def test_local_voice_is_selected_by_story_language(self):
        self.assertEqual(voice.configured_voice("local-tts", language="zh-CN"), "Tingting")
        self.assertEqual(voice.configured_voice("local-tts", language="en-US"), "Samantha")
        self.assertEqual(voice.configured_voice("local-tts", language="yue-HK"), "Sinji")
        with self.assertRaises(BroadcastError):
            voice.configured_voice("local-tts", "Tingting", "yue-HK")

    def test_minimax_requires_a_language_specific_voice(self):
        base = {"COURTLENS_MINIMAX_API_KEY": "test", "COURTLENS_MINIMAX_MODEL": "speech-2.8-hd",
                "COURTLENS_MINIMAX_VOICE_ID": "Chinese (Mandarin)_News_Anchor"}
        with patch.dict(os.environ, base, clear=True):
            with self.assertRaises(BroadcastError):
                voice.configured_voice("minimax", language="yue-HK")
            with self.assertRaises(BroadcastError):
                voice.configured_voice("minimax", language="en-US")
        with patch.dict(os.environ, {**base, "COURTLENS_MINIMAX_VOICE_ID_EN": "English_expressive_narrator",
                                     "COURTLENS_MINIMAX_VOICE_ID_YUE": "Cantonese_ProfessionalHost (M)"}, clear=True):
            self.assertEqual(voice.configured_voice("minimax", language="en-US"), "English_expressive_narrator")
            self.assertEqual(voice.configured_voice("minimax", language="yue-HK"), "Cantonese_ProfessionalHost (M)")

    def test_stepfun_and_polly_do_not_impersonate_english_or_cantonese(self):
        with patch.dict(os.environ, {"COURTLENS_STEPFUN_API_KEY": "test", "COURTLENS_STEPFUN_MODEL": "stepaudio-2.5-tts",
                                     "COURTLENS_STEPFUN_VOICE_ID": "elegantgentle-female"}, clear=True):
            for mode in ("stepfun", "polly"):
                for language in ("en-US", "yue-HK"):
                    with self.subTest(mode=mode, language=language), self.assertRaises(BroadcastError):
                        voice.configured_voice(mode, language=language)

    def test_cloud_capabilities_keep_unconfigured_languages_silent(self):
        rows = {row["id"]: row for row in capability_styles(cloud_modes={"stepfun", "polly"})}
        self.assertEqual(rows["zh-analysis"]["voiceModes"], ["silent", "stepfun", "polly"])
        self.assertEqual(rows["en-live"]["voiceModes"], ["silent"])
        self.assertEqual(rows["yue-live"]["voiceModes"], ["silent"])


if __name__ == "__main__":
    unittest.main()
