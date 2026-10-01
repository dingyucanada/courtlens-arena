"""Adversarial offline delivery evidence tests; fixtures are never cloud acceptance."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.contest_delivery import FACTS, SCHEMA, cloudfront_url, inspect_delivery
from tools.preflight_contest_delivery import run_delivery


class ContestDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.version = {"gitCommit": "a" * 40, "buildId": "offline-fixture-1"}
        self.config = {"teamAccountId": "123456789012", "allowedRegion": "us-east-1",
                       "portalConfirmedAgentService": "bedrock-agentcore", "portalConfirmedModelId": "exact-text-model-id",
                       "portalEvidence": "portal-source-test-fixture", "contestConfigConfirmed": True,
                       "modelResourceArn": "arn:aws:bedrock:us-east-1::foundation-model/exact-text-model-id"}
        artifact = self.root / "fixture-evidence.txt"
        artifact.write_text("Synthetic evidence for contract testing only; not a real deployment.")
        attachment = {"artifact": artifact.name, "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                      "capturedAt": "2026-10-01T12:00:00+08:00"}
        self.repo = "https://github.com/fixture/courtlens"
        facts = {key: {"status": "observed", "kind": kind, "version": dict(self.version),
                       "accountId": self.config["teamAccountId"], "region": self.config["allowedRegion"],
                       "evidence": dict(attachment)} for key, (_, kind, _) in FACTS.items()}
        facts["portal-requirements"].update(agentService="bedrock-agentcore", modelId="exact-text-model-id")
        facts["private-repository"].update(repositoryUrl=self.repo, visibility="private")
        facts["portal-binding"].update(repositoryUrl=self.repo, bound=True)
        facts["cdk-deployment"].update(tool="aws-cdk", stackStatus="CREATE_COMPLETE", runtimeDeployment=True)
        facts["cloudfront"].update(url="https://d123abc.cloudfront.net/broadcast/", distributionId="E123ABC",
                                   browserOpened=True, filmPlayed=True)
        facts["agent-service"].update(agentService="bedrock-agentcore", invocationSucceeded=True,
                                     runtimeArn="arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/fixture-test")
        facts["model-authorization"].update(modelId="exact-text-model-id", modelResourceArn=self.config["modelResourceArn"],
                                            invocationSucceeded=True, successfulInputModalities=["text"])
        self.packet = {"schema": SCHEMA, "repositoryUrl": self.repo, "facts": facts}

    def report(self):
        return inspect_delivery(self.config, self.packet, self.root, expected_version=self.version)

    def checks(self):
        return {r["id"]: r for r in self.report()["checks"]}

    def test_no_evidence_all_remote_gates_independently_unknown(self):
        self.packet["facts"] = {}
        checks = self.checks()
        self.assertEqual(checks["deployment-config"]["status"], "pass")
        self.assertTrue(all(checks[key]["status"] == "unknown" for key in FACTS))
        self.assertEqual(len(self.report()["handoff"]["tasks"]), len(FACTS))

    def test_consistent_recorded_evidence_never_certifies_cloud_or_score(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError("offline")), \
             patch("subprocess.run", side_effect=AssertionError("no subprocess")):
            report = self.report()
        self.assertTrue(report["recordedEvidenceComplete"])
        self.assertFalse(report["formalQualificationCertified"])
        self.assertFalse(report["cloudRuntimeIndependentlyVerified"])
        self.assertNotIn("score", report)
        self.assertEqual(self.checks()["model-authorization"]["successfulInputModalities"], ["text"])

    def test_repo_private_and_portal_binding_are_independent(self):
        self.packet["facts"]["portal-binding"]["status"] = "unknown"
        self.assertEqual(self.checks()["private-repository"]["status"], "pass")
        self.assertEqual(self.checks()["portal-binding"]["status"], "unknown")
        self.packet["facts"]["private-repository"]["visibility"] = "public"
        self.assertEqual(self.checks()["private-repository"]["status"], "fail")

    def test_portal_binding_wrong_repo_is_refused(self):
        self.packet["facts"]["portal-binding"]["repositoryUrl"] = "https://github.com/fixture/wrong"
        self.assertEqual(self.checks()["portal-binding"]["status"], "fail")

    def test_stale_commit_or_build_cannot_authorize_current_delivery(self):
        for field, wrong in (("gitCommit", "b" * 40), ("buildId", "old-build")):
            with self.subTest(field=field):
                self.packet["facts"]["cloudfront"]["version"] = dict(self.version, **{field: wrong})
                self.assertEqual(self.checks()["cloudfront"]["status"], "fail")

    def test_hash_tampering_and_missing_attachments_are_refused(self):
        (self.root / "fixture-evidence.txt").write_text("tampered")
        self.assertTrue(all(self.checks()[key]["status"] == "fail" for key in FACTS))
        (self.root / "fixture-evidence.txt").unlink()
        self.assertEqual(self.checks()["cloudfront"]["status"], "fail")

    def test_symlink_traversal_and_unzoned_timestamp_are_refused(self):
        link = self.root / "link.txt"
        link.symlink_to(self.root / "fixture-evidence.txt")
        for changes in ({"artifact": "link.txt"}, {"artifact": "../fixture-evidence.txt"},
                        {"artifact": "/tmp/evidence.txt"}, {"capturedAt": "2026-10-01T12:00:00"}):
            with self.subTest(changes=changes):
                fact = self.packet["facts"]["cloudfront"]
                original = copy.deepcopy(fact["evidence"])
                fact["evidence"].update(changes)
                self.assertEqual(self.checks()["cloudfront"]["status"], "fail")
                fact["evidence"] = original

    def test_account_and_region_mismatches_are_separate(self):
        self.packet["facts"]["aws-account"]["accountId"] = "987654321098"
        self.assertEqual(self.checks()["aws-account"]["status"], "fail")
        self.assertEqual(self.checks()["aws-region"]["status"], "pass")
        self.packet["facts"]["aws-region"]["region"] = "us-west-2"
        self.assertEqual(self.checks()["aws-region"]["status"], "fail")

    def test_synth_or_simulated_agent_never_substitutes_for_runtime(self):
        self.packet["facts"]["cdk-deployment"]["kind"] = "cdk-synth"
        self.packet["facts"]["agent-service"]["invocationSucceeded"] = False
        self.assertEqual(self.checks()["cdk-deployment"]["status"], "fail")
        self.assertEqual(self.checks()["agent-service"]["status"], "fail")

    def test_unknown_model_modality_not_guessed_from_235b_name(self):
        fact = self.packet["facts"]["model-authorization"]
        for modalities in (None, [], ["unknown"], ["235B-video"], ["text", "text"]):
            with self.subTest(modalities=modalities):
                fact["successfulInputModalities"] = modalities
                self.assertEqual(self.checks()["model-authorization"]["status"], "fail")
        fact["successfulInputModalities"] = ["text"]
        self.config["portalConfirmedModelId"] = "Qwen-235B-transcription-unconfirmed"
        self.assertEqual(self.checks()["model-authorization"]["status"], "fail")

    def test_fixture_config_does_not_turn_real_sounding_evidence_into_pass(self):
        self.config["fixtureOnly"] = True
        checks = self.checks()
        self.assertEqual(checks["deployment-config"]["status"], "fail")
        for key in ("aws-account", "aws-region", "cdk-deployment", "agent-service", "cloudfront", "model-authorization"):
            self.assertEqual(checks[key]["status"], "unknown")

    def test_portal_other_service_requires_real_implementation_change(self):
        self.config["portalConfirmedAgentService"] = "unconfirmed-aws-service"
        self.assertEqual(self.checks()["deployment-config"]["status"], "fail")
        self.assertEqual(self.checks()["agent-service"]["status"], "unknown")

    def test_native_cloudfront_url_validation(self):
        self.assertTrue(cloudfront_url("https://d123abc.cloudfront.net/broadcast/"))
        for value in ("http://d123abc.cloudfront.net/", "https://d123abc.cloudfront.net.evil.example/",
                      "https://cloudfront.net/", "https://1.2.3.4/", "https://alb.amazonaws.com/",
                      "https://user:pass@d123abc.cloudfront.net/", "https://d123abc.cloudfront.net:8080/",
                      "https://d123abc.cloudfront.net/?token=secret", "https://d123abc.cloudfront.net/#fragment",
                      "https://d123abc.cloudfront.net/\n", "https://d123abc.cloudfront.net\\@evil.example/"):
            with self.subTest(value=value):
                self.assertFalse(cloudfront_url(value))

    def test_cli_creates_report_without_mutation_or_secret_echo(self):
        config_file, packet_file = self.root / "config.json", self.root / "packet.json"
        self.config["unusedSecretForLeakTest"] = "do-not-echo-me"
        config_file.write_text(json.dumps(self.config))
        packet_file.write_text(json.dumps(self.packet))
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        output = self.root / "report.json"
        report = run_delivery(config_file, packet_file, output, git_commit=self.version["gitCommit"], build_id=self.version["buildId"])
        self.assertNotIn("do-not-echo-me", output.read_text())
        self.assertFalse(report["offline"]["awsRequests"])
        for name, raw in before.items():
            self.assertEqual((self.root / name).read_bytes(), raw)
        with self.assertRaises(FileExistsError):
            run_delivery(config_file, packet_file, output, git_commit=self.version["gitCommit"], build_id=self.version["buildId"])

    def test_invalid_expected_version_refused(self):
        with self.assertRaises(ValueError):
            inspect_delivery(self.config, self.packet, self.root, expected_version={"gitCommit": "a" * 7, "buildId": "fixture"})


if __name__ == "__main__":
    unittest.main()
