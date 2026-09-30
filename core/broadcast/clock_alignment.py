"""Explicit, segment-local scoreboard alignment; never infer a game clock from PTS."""
import re

from .common import finite, hash_json, require, valid_id


def countdown(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{1,2}:[0-5]\d(?:\.\d{1,2})?", value),
            "clock_invalid", "比赛时钟须为 MM:SS 或 MM:SS.xx。", 422)
    minute, second = value.split(":")
    return int(minute) * 60 + float(second)


def preview(project, frames, request):
    """Interpolate only between two manually read source frames in one camera segment.

    This proposes a time, not an official-data binding. Replays must use their own
    segment and anchors. Stopped clocks and edited/slow-motion intervals fail closed.
    """
    require(isinstance(request, dict) and set(request) == {"segmentId", "period", "clock", "anchors"},
            "clock_invalid", "时钟映射需要镜头段、节次、目标比赛时钟和两个锚点。", 422)
    media = project.get("media")
    require(media is not None and valid_id(request["segmentId"]), "clock_invalid", "先选视频和唯一镜头段。", 422)
    period = request["period"]
    require(type(period) is int and 1 <= period <= 20, "clock_invalid", "节次无效。", 422)
    limit = 720 if period <= 4 else 300
    target = countdown(request["clock"])
    require(target <= limit, "clock_invalid", "比赛时钟超过本节时长。", 422)
    anchors = request["anchors"]
    require(isinstance(anchors, list) and len(anchors) == 2, "clock_invalid", "须提供两个不同的源帧锚点。", 422)
    indexed = {f["id"]: f for f in frames}
    checked = []
    for anchor in anchors:
        require(isinstance(anchor, dict) and set(anchor) == {"frameId", "clock"} and anchor["frameId"] in indexed,
                "clock_invalid", "锚点必须引用本项目已保存的真实源帧。", 422)
        frame = indexed[anchor["frameId"]]
        value = countdown(anchor["clock"])
        require(value <= limit and frame.get("mediaSha256") == media["sha256"] and
                finite(frame.get("actualTime")) and 0 <= frame["actualTime"] < media["duration"],
                "clock_invalid", "锚点源片、时钟或真实 PTS 不匹配。", 422)
        checked.append({"frameId": frame["id"], "videoTime": frame["actualTime"],
                        "frameSha256": frame["sha256"], "clock": anchor["clock"], "remaining": value})
    checked.sort(key=lambda a: a["videoTime"])
    left, right = checked
    elapsed = right["videoTime"] - left["videoTime"]
    game_elapsed = left["remaining"] - right["remaining"]
    require(left["frameId"] != right["frameId"] and elapsed >= .5 and game_elapsed > 0,
            "clock_ambiguous", "同一帧、停止或逆行的比赛时钟不能建立唯一映射。", 422)
    # Whole-second scoreboard reads have quantization uncertainty. Do not claim
    # sub-frame precision; require longer, approximately normal-speed intervals.
    quantization = max(1 if "." not in a["clock"] else .1 for a in checked)
    require(elapsed <= 30 and abs(elapsed - game_elapsed) <= quantization + .15,
            "clock_discontinuous", "锚点可能跨越暂停、剪辑或慢动作；请缩小到连续原速镜头。", 422)
    require(right["remaining"] <= target <= left["remaining"], "clock_outside_anchors",
            "目标比赛时钟必须位于两个锚点之间，不能外推。", 422)
    # Source-frame gap is checked against explicit observation segments. Unknown
    # scene boundaries remain a manual responsibility, not an automatic guarantee.
    crossed = [o for o in project.get("observations", []) if o.get("segmentId") != request["segmentId"]
               and finite(o.get("start")) and finite(o.get("end"))
               and o["start"] < right["videoTime"] and o["end"] > left["videoTime"]]
    require(not crossed, "clock_discontinuous", "锚点之间存在其他镜头段的观察，请分别建立映射。", 422)
    at = left["videoTime"] + (left["remaining"] - target) / game_elapsed * elapsed
    return {"schema": "courtlens-clock-alignment/1", "projectId": project["id"],
            "projectRevision": project["revision"], "mediaSha256": media["sha256"],
            "segmentId": request["segmentId"], "anchors": checked,
            "mapping": {"source": "game-clock", "videoTime": round(at, 6), "period": period,
                        "clock": request["clock"], "mappingEvidenceIds": [a["frameId"] for a in checked]},
            "uncertaintySeconds": quantization * elapsed / game_elapsed,
            "status": "proposal", "requestHash": hash_json(request),
            "limitations": ["两个比分牌读数由操作人核对；未自动确认镜头连续性。",
                            "结果不是官方指标接入验收，也不能把回放当作另一事件。",
                            "指标 availableAt 必须独立确认，不能从发生时刻自动推导。"]}
