import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.launch import load_local_config


class LocalConfigTests(unittest.TestCase):
    def config(self, contents):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / 'local.env'
        path.write_text(contents)
        return path

    def test_explicit_environment_wins_and_shell_text_is_not_executed(self):
        with patch.dict(os.environ, {'COURTLENS_STEPFUN_MODEL': 'deployed-model'}, clear=True):
            path = self.config('COURTLENS_STEPFUN_MODEL=file-model\nCOURTLENS_STEPFUN_VOICE_ID="$(do-not-execute)"\n')
            load_local_config(path)
            self.assertEqual(os.environ['COURTLENS_STEPFUN_MODEL'], 'deployed-model')
            self.assertEqual(os.environ['COURTLENS_STEPFUN_VOICE_ID'], '$(do-not-execute)')

    def test_three_voice_configuration_can_start_without_shell_loading(self):
        with patch.dict(os.environ,{},clear=True):
            load_local_config(self.config('COURTLENS_STEPFUN_LANGUAGES=zh-CN,en-US,yue-HK\nCOURTLENS_STEPFUN_VOICE_ID_EN=vibrant-youth\nCOURTLENS_STEPFUN_VOICE_ID_YUE=shuangkuainansheng\n'))
            self.assertEqual(os.environ['COURTLENS_STEPFUN_VOICE_ID_EN'],'vibrant-youth')
            self.assertEqual(os.environ['COURTLENS_STEPFUN_VOICE_ID_YUE'],'shuangkuainansheng')

    def test_bad_setting_is_atomic_and_does_not_echo_secret(self):
        with patch.dict(os.environ, {}, clear=True):
            path = self.config('COURTLENS_STEPFUN_API_KEY=test-secret\nPATH=malicious\n')
            with self.assertRaises(ValueError) as caught:
                load_local_config(path)
            self.assertNotIn('test-secret', str(caught.exception))
            self.assertNotIn('COURTLENS_STEPFUN_API_KEY', os.environ)

    def test_duplicates_are_rejected(self):
        with patch.dict(os.environ, {}, clear=True):
            path = self.config('COURTLENS_STEPFUN_MODEL=one\nCOURTLENS_STEPFUN_MODEL=two\n')
            with self.assertRaises(ValueError):
                load_local_config(path)
            self.assertEqual(dict(os.environ), {})

    def test_oversize_config_rejected(self):
        with self.assertRaises(ValueError):
            load_local_config(self.config('#' * 65537))
