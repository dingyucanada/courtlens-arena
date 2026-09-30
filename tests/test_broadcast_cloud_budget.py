import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from core.broadcast.cloud_worker import BUSINESS_WAIT_SECONDS, run
from core.broadcast.common import BroadcastError


class BroadcastCloudBudgetTest(unittest.TestCase):
    def test_bounded_business_wait_has_room_for_encoding_and_three_sentences(self):
        self.assertEqual(BUSINESS_WAIT_SECONDS,600)
        with tempfile.TemporaryDirectory() as folder:
            thread=MagicMock()
            thread.is_alive.return_value=False
            service=MagicMock()
            service.store.project_dir.return_value=Path(folder)/('p'*32)
            service.start_job.return_value={'id':'job'}
            service._threads={'job':thread}
            service.job.return_value={'type':'analyze','status':'succeeded'}
            with patch('core.broadcast.cloud_worker.BroadcastService',return_value=service):
                result=run({'projectId':'p'*32,'expectedRevision':1,'jobType':'analyze','options':{}},folder)
            thread.join.assert_called_once_with(timeout=600)
            self.assertEqual(result['job']['status'],'succeeded')

    def test_expired_budget_cancels_and_never_returns_partial_output(self):
        with tempfile.TemporaryDirectory() as folder:
            thread=MagicMock()
            thread.is_alive.return_value=True
            service=MagicMock()
            service.store.project_dir.return_value=Path(folder)/('p'*32)
            service.start_job.return_value={'id':'job'}
            service._threads={'job':thread}
            with patch('core.broadcast.cloud_worker.BroadcastService',return_value=service), self.assertRaisesRegex(BroadcastError,'600秒'):
                run({'projectId':'p'*32,'expectedRevision':1,'jobType':'render','options':{}},folder)
            service.cancel.assert_called_once_with('job')
            service.release.assert_not_called()
