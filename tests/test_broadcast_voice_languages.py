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

    def test_three_stepfun_routes_use_instruction_not_unsupported_voice_label(self):
        base={"COURTLENS_STEPFUN_API_KEY":"test","COURTLENS_STEPFUN_MODEL":"stepaudio-2.5-tts",
              "COURTLENS_STEPFUN_API_VARIANT":"step-plan","COURTLENS_STEPFUN_LANGUAGES":"zh-CN,en-US,yue-HK",
              "COURTLENS_STEPFUN_VOICE_ID":"boyinnansheng","COURTLENS_STEPFUN_VOICE_ID_EN":"vibrant-youth",
              "COURTLENS_STEPFUN_VOICE_ID_YUE":"shuangkuainansheng"}
        with patch.dict(os.environ,base,clear=True),patch.object(voice,"_post_audio",return_value=("audio/mpeg",b"ID3original")) as post:
            for language in voice.STEPFUN_VOICE_KEYS:
                selected=voice.configured_voice("stepfun",language=language)
                voice._external_audio("stepfun","Original action narration",selected,language)
                url,token,payload,limit=post.call_args.args
                self.assertEqual(url,voice.STEPFUN_ENDPOINTS["step-plan"])
                self.assertEqual(payload["voice"],selected)
                self.assertNotIn("voice_label",payload)
                self.assertLessEqual(len(payload["instruction"]),200)
                self.assertEqual(payload["instruction"],voice.LIVE_INSTRUCTIONS[language])

    def test_changing_any_language_voice_invalidates_provider_receipt(self):
        from core.broadcast.providers import voice_fingerprint
        with patch.dict(os.environ,{'COURTLENS_STEPFUN_MODEL':'stepaudio-2.5-tts'},clear=True):
            before=voice_fingerprint('stepfun')
            for setting in ('COURTLENS_STEPFUN_VOICE_ID_EN','COURTLENS_STEPFUN_VOICE_ID_YUE','COURTLENS_STEPFUN_LANGUAGES'):
                with patch.dict(os.environ,{setting:'changed'}):self.assertNotEqual(voice_fingerprint('stepfun'),before)

    def test_cloud_capabilities_keep_unconfigured_languages_silent(self):
        rows = {row["id"]: row for row in capability_styles(cloud_modes={"stepfun", "polly"})}
        self.assertEqual(rows["zh-analysis"]["voiceModes"], ["silent", "stepfun", "polly"])
        self.assertEqual(rows["en-live"]["voiceModes"], ["silent"])
        self.assertEqual(rows["yue-live"]["voiceModes"], ["silent"])


if __name__ == "__main__":
    unittest.main()
