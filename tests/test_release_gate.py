"""Prevent publication when results belong to another or failed commit."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('release_gate', Path(__file__).resolve().parents[1] / '.github/scripts/verify_product_checks.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReleaseGateTests(unittest.TestCase):
    def run_record(self, **changes):
        return dict(head_sha='a'*40, event='push', status='completed', conclusion='success', run_number=1, **changes)

    def test_same_commit_must_succeed(self):
        self.assertEqual(gate.verdict([self.run_record()], 'a'*40), 'success')
        self.assertEqual(gate.verdict([self.run_record()], 'b'*40), 'wait')

    def test_failed_check_blocks_publication(self):
        run = self.run_record(); run['conclusion'] = 'failure'
        self.assertEqual(gate.verdict([run], 'a'*40), 'failed')

    def test_newer_running_check_is_not_bypassed(self):
        new = self.run_record(); new.update(run_number=2, status='in_progress', conclusion=None)
        self.assertEqual(gate.verdict([self.run_record(), new], 'a'*40), 'wait')

    def test_other_event_cannot_approve_publication(self):
        run = self.run_record(); run['event'] = 'pull_request'
        self.assertEqual(gate.verdict([run], 'a'*40), 'wait')
