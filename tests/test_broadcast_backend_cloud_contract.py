"""The cloud capability response must satisfy the same public contract as local."""
import importlib
import json
import os
import unittest
from unittest.mock import patch

import boto3

from core.broadcast.schema import validate


class CloudCapabilityContractTest(unittest.TestCase):
    def test_agentcore_declares_both_bounded_video_and_actual_frame_modes(self):
        settings = {"TABLE_NAME": "fixture", "INPUT_BUCKET": "fixture", "RELEASE_BUCKET": "fixture", "AWS_REGION": "us-east-1"}
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
