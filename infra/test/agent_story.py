"""AgentCore story prompt is evidence-only and bounded."""
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.update(INPUT_BUCKET="private", MODEL_ID="fixture-model")
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
fake_boto = types.ModuleType("boto3")
fake_boto.client = lambda name, **kwargs: object()
sys.modules.setdefault("boto3", fake_boto)
fake_botocore = types.ModuleType("botocore")
fake_config = types.ModuleType("botocore.config")
fake_config.Config = lambda **kwargs: object()
sys.modules.setdefault("botocore", fake_botocore)
sys.modules.setdefault("botocore.config", fake_config)

from cloud.agent import main  # noqa: E402


class AgentStory(unittest.TestCase):
    def test_story_invocation_uses_reviewed_evidence_without_video(self):
        payload = {"kind": "story-draft", "projectId": "a" * 32, "mediaSha256": "b" * 64,
                   "projectContentHash": "c" * 64, "inputRevision": 4,
                   "evidence": {"audience": "fan", "sourceRange": {"start": 0, "end": 10},
                                "observations": [{"id": "ob-1", "description": "已确认的传球"}],
                                "bindings": [], "metricHandles": []}}
        raw = '{"title":"一次传球","beats":[{}]}'
        with patch.object(main, "BEDROCK") as bedrock:
            bedrock.converse.return_value = {"output": {"message": {"content": [{"text": raw}]}}, "usage": {"inputTokens": 5}}
            result = main.propose(payload)
        self.assertEqual(result["rawProposal"], raw)
        request = bedrock.converse.call_args.kwargs
        self.assertNotIn("video", str(request))
        self.assertIn("已确认的传球", request["messages"][0]["content"][0]["text"])
        self.assertEqual(result["mediaSha256"], "b" * 64)


if __name__ == "__main__":
    unittest.main()
