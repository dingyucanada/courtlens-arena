"""Hydrated-workspace worker for Fargate. It never accepts media paths or URLs."""
import argparse
import json
import os
import sys
from pathlib import Path

from .common import BroadcastError, require, valid_id
from .service import BroadcastService


def run(request, workspace_root):
    require(isinstance(request, dict) and set(request) == {"projectId", "expectedRevision", "jobType", "options"}, "invalid_request", "云任务字段无效。")
    require(valid_id(request["projectId"]) and request["jobType"] in ("analyze", "cv", "render", "probe-provider", "model-story") and isinstance(request["options"], dict), "invalid_request", "云任务 ID 或类型无效。")
    service = BroadcastService(workspace_root)
    options = dict(request["options"])
    fixed_proposal = service.store.project_dir(request["projectId"]) / "agentcore-proposal.json"
    if request["jobType"] in ("analyze", "probe-provider") and fixed_proposal.is_file():
        require(bool(os.environ.get("AGENT_RUNTIME_ARN")) and not fixed_proposal.is_symlink() and fixed_proposal.stat().st_size <= 1024 * 1024, "provider_unverified", "AgentCore 旁证路径或配置无效。", 422)
        options["providerId"] = "agentcore-proposal"
        options["_trustedAgentCore"] = True
    if request["jobType"] == "model-story":
        fixed_story = service.store.project_dir(request["projectId"]) / "agentcore-story.json"
        require(bool(os.environ.get("AGENT_RUNTIME_ARN")) and fixed_story.is_file() and not fixed_story.is_symlink() and fixed_story.stat().st_size <= 1024 * 1024, "provider_unverified", "AgentCore 故事旁证路径或配置无效。", 422)
        options["providerId"] = "agentcore-story"
        options["_trustedAgentCore"] = True
    job = service.start_job(request["projectId"], request["expectedRevision"], request["jobType"], options)
    thread = service._threads[job["id"]]
    thread.join(timeout=240)
    if thread.is_alive():
        service.cancel(job["id"])
        raise BroadcastError("provider_failed", "云任务超过240秒，已取消。", 504)
    job = service.job(job["id"])
    result = {"job": job}
    if job["type"] == "render" and job["status"] == "succeeded":
        result["release"] = service.release(job["resultId"])["summary"]
    if job["type"] == "model-story" and job["status"] == "succeeded":
        project = service.get(request["projectId"])
        result["result"] = {"projectId": project["id"], "projectRevision": project["revision"]}
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    try:
        path = Path(args.request)
        require(path.is_file() and path.stat().st_size <= 65536, "invalid_request", "云任务文件无效或过大。")
        request = json.loads(path.read_text())
        result = run(request, args.workspace)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        if result["job"]["status"] not in ("succeeded", "needs_review"):
            sys.exit(1)
    except BroadcastError as exc:
        print(json.dumps({"error": exc.body()}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
