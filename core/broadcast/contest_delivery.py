"""Offline contest delivery evidence audit; never certifies cloud qualification.

This supplements, rather than replaces, the saved-project production preflight.
No network, credentials, provider execution, subprocesses or deployment occur.
"""
import hashlib
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit


SCHEMA = "courtlens-contest-delivery-input/1"
FACTS = {
    "portal-requirements": ("Portal 正式要求", "portal-requirements", "取得 Portal 原文，核对账号、区域、Agent 服务及精确模型 ID。"),
    "private-repository": ("私有 GitHub 仓库", "github-repository", "保存 GitHub 仓库可见性及 commit 的证据；package.json private 不证明仓库私有。"),
    "portal-binding": ("Portal 仓库绑定", "portal-binding", "在 Portal 核对实际授权并绑定的仓库 URL。"),
    "aws-account": ("实际 AWS 账号", "aws-caller-identity", "在获准环境读取调用身份，核对赛方 12 位账号。"),
    "aws-region": ("部署区域", "aws-deployment-region", "记录真实资源所在区域并与 Portal 区域比较。"),
    "cdk-deployment": ("CDK 实际部署", "cdk-deployment", "保存真实 CDK 部署与 CloudFormation 完成记录；synth 仅属本地模板检查。"),
    "cloudfront": ("CloudFront 交付", "cloudfront-browser", "保存真实 distribution 与 HTTPS 页面/影片浏览验收，核对发布版本。"),
    "agent-service": ("指定 Agent 实际运行", "agent-runtime", "按 Portal 指定服务部署并保存一次真实调用证据。"),
    "model-authorization": ("精确模型与模态授权", "model-invocation", "按 Portal 精确模型 ID 真实调用，记录成功输入模态；不要从 235B 名称推断视频支持。"),
}


def cloudfront_url(value):
    """Accept a native CloudFront HTTPS hostname, never fetch it."""
    if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value:
        return False
    try:
        parts = urlsplit(value)
        return (parts.scheme == "https" and parts.username is None and parts.password is None
                and parts.port in (None, 443) and not parts.query and not parts.fragment
                and bool(re.fullmatch(r"[a-z0-9]{1,63}\.cloudfront\.net", parts.hostname or "")))
    except ValueError:
        return False


def github_url(value):
    if not isinstance(value, str):
        return False
    return bool(re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value))


def _known(value):
    return isinstance(value, str) and bool(value.strip()) and not value.startswith("REPLACE_")


def _version(value):
    return (isinstance(value, dict) and bool(re.fullmatch(r"[0-9a-f]{40}", str(value.get("gitCommit", ""))))
            and bool(re.fullmatch(r"[A-Za-z0-9._-]{1,100}", str(value.get("buildId", "")))))


def _attachment(evidence, root):
    """Hash one regular local attachment, with symlinks and traversal refused."""
    if not isinstance(evidence, dict):
        raise ValueError("missing evidence attachment")
    name, digest, captured = evidence.get("artifact"), evidence.get("sha256"), evidence.get("capturedAt")
    if not isinstance(name, str) or not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("artifact must be a relative local file inside evidence root")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("attachment requires exact SHA-256")
    try:
        stamp = datetime.fromisoformat(captured.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError()
    except (AttributeError, TypeError, ValueError):
        raise ValueError("capturedAt requires timezone-aware ISO timestamp") from None
    target = root / name
    node = root
    for component in Path(name).parts:
        node = node / component
        if node.is_symlink():
            raise ValueError("symlink evidence refused")
    if not target.resolve().is_relative_to(root.resolve()) or not target.is_file():
        raise ValueError("evidence attachment missing or outside root")
    if target.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("evidence attachment exceeds 16 MiB")
    actual = hashlib.sha256(target.read_bytes()).hexdigest()
    if actual != digest:
        raise ValueError("evidence attachment SHA-256 mismatch")
    return {"artifact": name, "sha256": actual, "capturedAt": captured}


def inspect_delivery(config, packet, evidence_root, *, expected_version):
    """Validate evidence contracts, keeping remote truth explicitly unverified.

    ``pass`` means attached evidence is internally consistent. All remote facts
    remain operator-recorded assertions until independently verified online.
    """
    if not isinstance(config, dict) or not isinstance(packet, dict) or packet.get("schema") != SCHEMA:
        raise ValueError("Expected deployment config and contest-delivery-input/1 packet")
    if not _version(expected_version):
        raise ValueError("Expected version requires a 40-character commit and explicit build ID")
    if not isinstance(packet.get("facts", {}), dict):
        raise ValueError("facts must be an object")
    root = Path(evidence_root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("Evidence root must be an existing regular directory")
    checks = []
    fields = ("teamAccountId", "allowedRegion", "portalConfirmedAgentService", "portalConfirmedModelId", "modelResourceArn")
    complete = all(_known(config.get(key)) for key in fields)
    if config.get("fixtureOnly") or config.get("portalEvidence") == "LOCAL_SYNTH_FIXTURE_ONLY":
        config_status, config_detail = "fail", "本地 fixture 不能作为正式赛方配置。"
    elif not complete or config.get("contestConfigConfirmed") is not True or not _known(config.get("portalEvidence")):
        config_status, config_detail = "unknown", "等待 Portal 确认完整账号、区域、服务、模型与证据引用。"
    elif not re.fullmatch(r"\d{12}", config["teamAccountId"]) or config["teamAccountId"] == "111111111111":
        config_status, config_detail = "fail", "账号格式无效或为测试账号。"
    elif not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d+", config["allowedRegion"]):
        config_status, config_detail = "fail", "区域不是明确 AWS 区域码。"
    elif config["portalConfirmedAgentService"] != "bedrock-agentcore":
        config_status, config_detail = "fail", "当前 CDK 只实现 AgentCore 候选；Portal 指定其他服务时必须调整工程。"
    elif not config["modelResourceArn"].startswith(f"arn:aws:bedrock:{config['allowedRegion']}:"):
        config_status, config_detail = "fail", "模型资源 ARN 与指定区域不一致。"
    else:
        config_status, config_detail = "pass", "配置字段合同一致；此项不证明 Portal 原文或实际授权。"
    checks.append({"id": "deployment-config", "label": "赛方配置合同", "status": config_status, "detail": config_detail,
                   "action": "取得 Portal 原文并填写 infra/config.example.json 对应的正式配置。"})
    facts = packet.get("facts", {})
    repo = packet.get("repositoryUrl")
    def same(fact, key, expected):
        if fact.get(key) != expected:
            raise ValueError(f"{key} does not match expected delivery/configuration")
    for key, (label, kind, action) in FACTS.items():
        row = {"id": key, "label": label, "status": "unknown", "detail": "未记录可校验的实际验收证据。", "action": action}
        fact = facts.get(key)
        if fact is None or isinstance(fact, dict) and fact.get("status", "unknown") == "unknown":
            checks.append(row)
            continue
        try:
            if not isinstance(fact, dict) or fact.get("status") not in ("observed", "failed"):
                raise ValueError("fact status must be unknown, observed or failed")
            if fact.get("kind") != kind:
                raise ValueError("wrong evidence kind; synth/naming cannot establish deployed runtime")
            row["evidence"] = _attachment(fact.get("evidence"), root)
            same(fact, "version", expected_version)
            if fact["status"] == "failed":
                raise ValueError("recorded actual check failed")
            if key in ("private-repository", "portal-binding"):
                if not github_url(repo):
                    raise ValueError("expected repository must be a canonical HTTPS GitHub URL")
                same(fact, "repositoryUrl", repo)
                if key == "private-repository":
                    same(fact, "visibility", "private")
                else:
                    same(fact, "bound", True)
            else:
                if config_status != "pass":
                    row["detail"] = "已有附件，但完整赛方配置未通过合同检查，无法核对目标。"
                    checks.append(row)
                    continue
                same(fact, "accountId", config["teamAccountId"])
                if key != "aws-account":
                    same(fact, "region", config["allowedRegion"])
                if key == "portal-requirements":
                    same(fact, "agentService", config["portalConfirmedAgentService"])
                    same(fact, "modelId", config["portalConfirmedModelId"])
                elif key == "cdk-deployment":
                    same(fact, "tool", "aws-cdk")
                    if fact.get("stackStatus") not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
                        raise ValueError("CDK requires completed real CloudFormation deployment")
                    same(fact, "runtimeDeployment", True)
                elif key == "cloudfront":
                    if not cloudfront_url(fact.get("url")):
                        raise ValueError("delivery URL requires HTTPS native CloudFront hostname without credentials/query/fragment")
                    same(fact, "browserOpened", True)
                    same(fact, "filmPlayed", True)
                    if not isinstance(fact.get("distributionId"), str) or not re.fullmatch(r"E[A-Z0-9]{5,32}", fact["distributionId"]):
                        raise ValueError("actual CloudFront distribution ID required")
                    row["url"] = fact["url"]
                elif key == "agent-service":
                    same(fact, "agentService", config["portalConfirmedAgentService"])
                    same(fact, "invocationSucceeded", True)
                    if not isinstance(fact.get("runtimeArn"), str) or not fact["runtimeArn"].startswith(f"arn:aws:bedrock-agentcore:{config['allowedRegion']}:{config['teamAccountId']}:runtime/"):
                        raise ValueError("actual AgentCore runtime ARN must match account and region")
                elif key == "model-authorization":
                    same(fact, "modelId", config["portalConfirmedModelId"])
                    same(fact, "modelResourceArn", config["modelResourceArn"])
                    same(fact, "invocationSucceeded", True)
                    modalities = fact.get("successfulInputModalities")
                    if (not isinstance(modalities, list) or not modalities or len(set(modalities)) != len(modalities)
                            or any(m not in ("text", "image", "video") for m in modalities)):
                        raise ValueError("record exact successful input modalities; unknown/transcribed model type cannot be guessed")
                    row["successfulInputModalities"] = modalities
            row.update(status="pass", detail="附件 SHA、当前版本与记录字段匹配；远端事实尚未由此离线检查独立核实。")
        except (OSError, ValueError, TypeError) as error:
            row.update(status="fail", detail=str(error))
        checks.append(row)
    complete_evidence = all(row["status"] == "pass" for row in checks)
    return {"schema": "courtlens-contest-delivery-report/1", "expectedVersion": dict(expected_version),
            "checks": checks, "recordedEvidenceComplete": complete_evidence,
            "formalQualificationCertified": False, "cloudRuntimeIndependentlyVerified": False,
            "scope": "仅检查赛前配置和已记录证据的本地一致性；不认证比赛正式云资格，不计算机器评分。",
            "offline": {"externalTransmission": False, "awsRequests": False, "modelCalls": False, "repositoryModified": False},
            "handoff": {"consumer": "Kiro or another authorized engineering environment; Kiro is not confirmed mandatory",
                        "tasks": [{"gate": r["id"], "status": r["status"], "action": r["action"]} for r in checks if r["status"] != "pass"],
                        "requiresIndependentOnlineAcceptance": True}}
