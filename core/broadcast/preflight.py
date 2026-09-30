"""Read-only production checks, with external contest gates always explicit."""
from .common import hash_json
from .validation import content_hash, story as validate_story


def inspect_project(project, frames, provider_runs, capabilities, *, manifest=None):
    from .vision_readiness import assess
    from .commentary_rehearsal import analyze
    items = []
    def check(key, label, status, detail):
        items.append({"id": key, "label": label, "status": status, "detail": detail})
    media = project.get("media")
    check("media", "视频素材", "pass" if media else "fail",
          f"{media['duration']:.2f} 秒 · {media['width']}×{media['height']}" if media else "尚未添加视频")
    roster = project.get("context", {}).get("roster", [])
    check("roster", "当场名单", "pass" if roster else "unknown", f"{len(roster)} 人" if roster else "姓名识别需要比赛日期与同场名单")
    check("frames", "画面证据", "pass" if frames else "unknown", f"已保存 {len(frames)} 张源帧")
    bundle = project.get("metrics") or {}
    for role, label in (("difficulty", "预期命中率"), ("gravity", "球员引力"), ("leverage", "胜负影响率")):
        definitions = bundle.get("dictionary", {}).get("metrics", {})
        ids = {key for key, entry in definitions.items() if entry.get("role") == role}
        records = [r for r in bundle.get("records", []) if r.get("metricId") in ids]
        bindings = {rid for b in project.get("bindings", []) if b.get("status") == "confirmed" for rid in b.get("metricRecordIds", [])}
        official = [r for r in records if (r.get("provenance") or definitions[r["metricId"]].get("provenance") or bundle.get("provenance") or
                    bundle.get("dictionary", {}).get("provenance") or {}).get("kind") in ("official", "official-provided")]
        bound = [r for r in official if r["id"] in bindings and r.get("value") is not None]
        check("metric-" + role, label, "pass" if bound else "unknown",
              f"{len(bound)} 条来源标为官方的记录已人工映射；来源仍须核验" if bound else
              "未提供" if not records else "有资料，但尚无来源明确且已映射的事件值")
    valid_story = False
    if project.get("story"):
        try:
            validate_story(project, {f["id"]: f["actualTime"] for f in frames})
            valid_story = True
            detail = f"{len(project['story']['beats'])} 段解说通过内容合同检查"
        except Exception as exc:
            from .common import BroadcastError
            if not isinstance(exc, BroadcastError):
                raise
            detail = str(exc)
    else:
        detail = "尚未编排解说"
    check("story", "解说编排", "pass" if valid_story else "fail", detail)
    review = project.get("review") or {}
    reviewed = valid_story and review.get("result") == "approved" and review.get("contentHash") == content_hash(project) and review.get("projectRevision") == project["revision"]
    check("review", "发布审核", "pass" if reviewed else "fail", "审核对应当前内容" if reviewed else "当前内容尚未审核，或审核已失效")
    renderer = capabilities.get("renderer", {})
    check("renderer", "成片工具", "pass" if renderer.get("available") else "fail",
          "渲染依赖可用；此检查不代表已生成成片" if renderer.get("available") else "渲染依赖未齐全")
    for key, label, detail in (("aws-account", "比赛 AWS 账号", "等待赛方账号、区域与模型授权"),
                               ("agent-service", "指定 Agent 服务", "服务名仍须以 Portal 为准；本地测试不能代替运行验收"),
                               ("cloudfront", "CloudFront 交付地址", "须在比赛账号实际部署并打开验证"),
                               ("portal-repo", "私有仓库与 Portal 绑定", "提交前恢复私有，并在 Portal 核对绑定")):
        check(key, label, "unknown", detail)
    return {"schema": "courtlens-broadcast-preflight/1", "projectId": project["id"],
            "projectRevision": project["revision"], "mediaSha256": media.get("sha256") if media else None,
            "contentHash": hash_json(project), "checks": items, "frames": frames,
            "vision": assess(project, {f["id"]: f for f in frames}, provider_runs=provider_runs),
            "rehearsal": analyze(project, manifest=manifest),
            "scope": "赛前本地制作检查；未知事项未计为通过，不认证识别准确率或比赛资格。"}
