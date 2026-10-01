"""The cloud capability response must satisfy the same public contract as local."""
import importlib
import json
import os
import unittest
from unittest.mock import patch

import boto3

from core.broadcast.schema import validate


class CloudCapabilityContractTest(unittest.TestCase):
    def test_story_containers_copy_the_pinned_runtime_catalogues(self):
        from pathlib import Path
        root = Path(__file__).resolve().parents[1]
        for container in ("agent", "render", "api"):
            dockerfile = (root / "cloud" / container / "Dockerfile").read_text()
            for catalogue in ("commentary-styles.v1.json", "basketball-tactics.v1.json", "broadcast-pronunciation.v1.json"):
                self.assertIn("COPY data/" + catalogue, dockerfile)
        # The agent's story path only calls resolve_style/converse. The renderer
        # performs JSON Schema validation and must carry contracts/tools/Node.
        renderer = (root / "cloud/render/Dockerfile").read_text()
        self.assertIn("COPY contracts ./contracts", renderer)
        self.assertIn("COPY tools ./tools", renderer)

    def test_agentcore_declares_both_bounded_video_and_actual_frame_modes(self):
        settings = {"TABLE_NAME": "fixture", "INPUT_BUCKET": "fixture", "RELEASE_BUCKET": "fixture", "AWS_REGION": "us-east-1", "MODEL_ID": "fixture-model", "COURTLENS_BEDROCK_MODALITIES": "text,image,video", "COURTLENS_BEDROCK_TOOLS": "1"}
        with patch.dict(os.environ, settings), patch.object(boto3, "client", return_value=object()):
            api = importlib.reload(importlib.import_module("cloud.api.api"))
            result = api.handler({"httpMethod": "GET", "path": "/api/broadcast/v1/capabilities",
                                  "requestContext": {"authorizer": {"claims": {"sub": "fixture-owner"}}}}, None)
        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])["data"]
        validate(body, "capabilities")
        agent = next(row for row in body["providers"] if row["id"] == "agentcore-proposal")
        self.assertEqual(agent["modalities"], ["video", "image", "text"])
        self.assertFalse(agent["verified"])
        self.assertEqual(body["upload"], {"mode": "signed-async", "maxBytes": 256 * 1024 * 1024})


if __name__ == "__main__":
    unittest.main()
