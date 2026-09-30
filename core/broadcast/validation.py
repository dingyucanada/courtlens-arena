"""Cross-record, temporal and publication checks beyond JSON Schema shape."""
import re
import subprocess
import shutil
import os
from pathlib import Path

from .common import BroadcastError, bounded_text, finite, hash_json, require, valid_id

ROOT = Path(__file__).resolve().parents[2]
NODE = os.environ.get("COURTLENS_NODE") or shutil.which("node")


def grounded_wording(text, evidence, roster):
    """Conservative publication checks, not a substitute for semantic review.

    Official numbers use metric placeholders. Jersey numbers may be quoted only
    for players referenced by the accepted observations. Basketball vocabulary
    such as 三分球 is not itself a measured quantity.
    """
    stripped = re.sub(r"\{\{metric:[A-Za-z0-9_-]+\}\}", "", text)
    player_ids = {p for row in evidence for p in row["playerIds"]}
    for player in roster:
        jersey = player.get("jersey")
        if player["id"] in player_ids and jersey is not None:
            digit = re.escape(str(jersey))
            stripped = re.sub(r"(?<!\d)(?:#\s*|No\.?\s*)?" + digit + r"\s*[号號](?!\d)|(?:#\s*|No\.?\s*)" + digit + r"\b", "", stripped, flags=re.I)
    # A visible jersey can be known before the wearer's name is established.
    for row in evidence:
        visible_text = row["description"] + " " + " ".join(row.get("unknownActors", []))
        for jersey in re.findall(r"(?<!\d)(\d{1,2})\s*[号號](?!\d)", visible_text):
            stripped = re.sub(r"(?<!\d)(?:#\s*)?" + re.escape(jersey) + r"\s*[号號](?!\d)", "", stripped)
    require(not re.search(r"[0-9０-９]", stripped), "schema_invalid", "数字须引用指标记录；球衣号须有已确认的球员依据。", 422)
    chinese_number = r"[零〇一二两三四五六七八九十百千万亿点]+"
    # “这一次进攻” is ordinary narration, not an asserted measurement.
    quantitative = re.sub(r"三秒区|二次进攻|二次组织|二次传导", "篮球术语", stripped)
    quantitative = re.sub(r"(?<![零〇一二两三四五六七八九十百千万亿点])一次", "本次", quantitative)
    require(not re.search(r"(?:百分之|千分之)" + chinese_number + r"|" + chinese_number + r"\s*(?:百分点|厘米|米|秒|公里|次)", quantitative), "schema_invalid", "中文数量也须使用有来源的指标记录。", 422)
    english_number = r"(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand))*"
    require(not re.search(r"\b" + english_number + r"\s+(?:percent(?:age\s+points?)?|centimeters?|meters?|seconds?|minutes?|rebounds?|assists?|points)\b", quantitative, re.I), "schema_invalid", "英文数量须引用有来源的指标记录。", 422)
    outcome = re.search(r"命中(?!率|概率)|投进|打进|得手|投篮不中|投失|未能命中|打铁|入网|(?:球)?[进進]了|入咗|入左|入籃|唔入|射入|射中|射失|中咗|中左|冇入|唔中|入波|得分|\b(?:made|missed|scores?|scored|drains?|buries|bucket)\b|\b(?:goes? in|goes? down|puts? it in|lays? it in|hits? (?:it|the shot)|(?:it|shot|basket) (?:is )?good|it['’]s good|no good|won't go|makes? (?:the|a|it))\b", stripped, re.I)
    require(not outcome or any(row["type"] == "result" for row in evidence), "review_required", "进球或未进的断言需要已接受的结果观察。", 422)


def metric_bundle(bundle):
    if NODE is None:
        raise BroadcastError("schema_invalid", "指标 v2 验证需要 Node.js；当前未安装。", 503)
    try:
        proc = subprocess.run([NODE, str(ROOT / "tools" / "broadcast_compile.mjs"), "validate-metrics"], input=__import__("json").dumps(bundle, allow_nan=False).encode(), capture_output=True, timeout=15)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise BroadcastError("schema_invalid", "官方指标验证器不可用。", 503)
    if proc.returncode:
        raise BroadcastError("schema_invalid", "官方指标数据无效：" + proc.stderr.decode("utf-8", "replace")[:600], 422)
    return True


def observations(rows, media, roster, frame_ids=None):
    require(isinstance(rows, list) and len(rows) <= 300, "schema_invalid", "观察记录超过限制。", 422)
    names = {r["id"] for r in roster}
    seen = set()
    for o in rows:
        require(isinstance(o, dict) and valid_id(o.get("id")) and o["id"] not in seen, "schema_invalid", "观察 ID 无效或重复。", 422)
        seen.add(o["id"])
        require(o.get("type") in ("pass", "shot", "catch", "movement", "screen", "result", "other"), "schema_invalid", "观察类型无效。", 422)
        a, b = o.get("start"), o.get("end")
        require(finite(a) and finite(b) and 0 <= a < b <= media["duration"], "schema_invalid", "观察源时间越界。", 422)
        t = o.get("anchorTime")
        require(t is None or finite(t) and a <= t <= b, "schema_invalid", "观察锚点越界。", 422)
        require(valid_id(o.get("segmentId")), "schema_invalid", "镜头段 ID 无效。", 422)
        bounded_text(o.get("description"), "description", 800, True)
        require(isinstance(o.get("playerIds"), list) and len(o["playerIds"]) <= 20 and all(p in names for p in o["playerIds"]), "schema_invalid", "观察引用了未确认名单中的球员。", 422)
        require(isinstance(o.get("unknownActors"), list) and len(o["unknownActors"]) <= 20 and all(isinstance(x, str) and len(x) <= 80 for x in o["unknownActors"]), "schema_invalid", "未知角色无效。", 422)
        require(isinstance(o.get("frameIds"), list) and len(o["frameIds"]) <= 16 and all(valid_id(x) for x in o["frameIds"]) and (frame_ids is None or all(x in frame_ids for x in o["frameIds"])), "schema_invalid", "观察引用不属于本源片的帧。", 422)
        source, review = o.get("source"), o.get("review")
        require(isinstance(source, dict) and source.get("kind") in ("manual", "model", "cv") and isinstance(review, dict) and review.get("status") in ("unreviewed", "accepted", "rejected"), "schema_invalid", "观察来源或审核无效。", 422)
        if review["status"] == "accepted":
            require(bool(review.get("actor")) and bool(review.get("at")), "schema_invalid", "接受观察需要复核署名和时间。", 422)
        c = o.get("confidence")
        require(c is None or finite(c) and 0 <= c <= 1, "schema_invalid", "置信度无效。", 422)
        g = o.get("geometry")
        if g is not None:
            require(isinstance(g, dict) and g.get("space") == "screen-normalized" and g.get("segmentId") == o["segmentId"] and finite(g.get("validFrom")) and finite(g.get("validTo")) and a <= g["validFrom"] < g["validTo"] <= media["duration"] and g["validTo"] - g["validFrom"] <= 3, "schema_invalid", "几何须位于同镜头的短持有窗，最长3秒。", 422)
            points(g.get("points"))


def points(value):
    require(isinstance(value, list) and 2 <= len(value) <= 20 and all(isinstance(p, dict) and finite(p.get("x")) and finite(p.get("y")) and 0 <= p["x"] <= 1 and 0 <= p["y"] <= 1 for p in value), "schema_invalid", "屏幕坐标必须在 0–1 内。", 422)


def bindings(rows, project):
    require(isinstance(rows, list) and len(rows) <= 300, "schema_invalid", "绑定数量超限。", 422)
    obs = {o["id"]: o for o in project["observations"]}
    metric = {r["id"]: r for r in (project.get("metrics") or {}).get("records", [])}
    metric_plays = {play["id"]: play for play in (project.get("metrics") or {}).get("plays", [])}
    ids = set()
    for b in rows:
        require(isinstance(b, dict) and valid_id(b.get("id")) and b["id"] not in ids and valid_id(b.get("observationId")) and b["observationId"] in obs, "unresolved_binding", "绑定引用不存在的观察。", 422)
        ids.add(b["id"])
        require(b.get("status") in ("proposed", "confirmed", "rejected"), "schema_invalid", "绑定状态无效。", 422)
        require(isinstance(b.get("metricRecordIds"), list) and len(b["metricRecordIds"]) <= 20 and all(valid_id(x) and x in metric for x in b["metricRecordIds"]), "unresolved_binding", "绑定引用不存在的指标。", 422)
        mapping = b.get("timeMapping")
        require(isinstance(mapping, dict) and mapping.get("source") in ("video", "game-clock") and finite(mapping.get("videoTime")) and obs[b["observationId"]]["start"] <= mapping["videoTime"] <= obs[b["observationId"]]["end"], "unresolved_binding", "绑定视频时间不在观察窗。", 422)
        require(isinstance(mapping.get("mappingEvidenceIds"), list) and len(mapping["mappingEvidenceIds"]) <= 20 and all(valid_id(x) for x in mapping["mappingEvidenceIds"]), "schema_invalid", "映射证据无效。", 422)
        if b["status"] == "confirmed":
            require(bool(b.get("confirmedBy")) and bool(b.get("confirmedAt")) and obs[b["observationId"]]["review"]["status"] == "accepted", "unresolved_binding", "绑定确认须先接受已复核的观察。", 422)
            require(b.get("gameId") is None or b["gameId"] == project["context"]["gameId"], "unresolved_binding", "比赛 ID 冲突。", 422)
            require(b.get("playerId") is None or b["playerId"] in obs[b["observationId"]]["playerIds"], "unresolved_binding", "球员身份没有观察支持。", 422)
            for rid in b["metricRecordIds"]:
                r = metric[rid]
                scope = r["scope"]
                require(scope["granularity"] in ("shot", "event"), "unresolved_binding", "只有本次出手或事件指标可进入主视频。", 422)
                require(project["context"]["gameId"] and b.get("gameId") == project["context"]["gameId"], "unresolved_binding", "比赛 ID 未确认，不能展示本场官方事件值。", 422)
                metric_play = metric_plays.get(scope.get("playId"))
                require(metric_play is not None and metric_play.get("gameId") == b["gameId"] and metric_play["start"] <= mapping["videoTime"] <= metric_play["end"], "unresolved_binding", "指标回合比赛与视频映射不一致。", 422)
                require(r["time"].get("timeBase") == "video", "unresolved_binding", "指标时钟尚未显式映射至视频PTS。", 422)
                if scope["granularity"] == "shot":
                    require(b.get("shotId") and scope["shotId"] == b["shotId"], "unresolved_binding", "shotId 不匹配。", 422)
                if scope["granularity"] == "event":
                    require(b.get("officialEventId") and scope["eventId"] == b["officialEventId"], "unresolved_binding", "eventId 不匹配。", 422)
                for field, expected in (("playerId", b.get("playerId")), ("teamId", project["context"].get("offenseTeamId")), ("seasonId", project["context"].get("seasonId"))):
                    if scope.get(field) is not None:
                        require(expected == scope[field], "unresolved_binding", field + " 不匹配。", 422)
                require(r.get("value") is not None, "unresolved_binding", "指标数值未知，不能确认展示绑定。", 422)
                require(r["time"].get("availableAt") is not None, "unresolved_binding", "指标可用时间未知。", 422)


def story(project, frame_times=None):
    from .commentary_style import resolve_style
    s = project.get("story")
    media = project.get("media")
    require(media is not None and isinstance(s, dict) and s.get("schema") == "courtlens-broadcast-story/1", "review_required", "先建立故事。", 422)
    observations(project["observations"], media, project["context"]["roster"], set(frame_times) if frame_times is not None else None)
    bindings(project["bindings"], project)
    beats = s.get("beats")
    require(isinstance(beats, list) and 1 <= len(beats) <= 3, "schema_invalid", "故事须有 1–3 个节点。", 422)
    source_range = s.get("sourceRange") or {}
    a, b = source_range.get("start"), source_range.get("end")
    require(finite(a) and finite(b) and 0 <= a < b <= media["duration"], "schema_invalid", "剪辑范围无效。", 422)
    require(s.get("audience") in ("fan", "pro"), "schema_invalid", "受众无效。", 422)
    resolve_style(s.get("commentaryStyle"), s.get("language"))
    obs = {o["id"]: o for o in project["observations"]}
    bind = {x["id"]: x for x in project["bindings"]}
    metric = {r["id"]: r for r in (project.get("metrics") or {}).get("records", [])}
    previous = a
    for beat in beats:
        require(isinstance(beat, dict) and valid_id(beat.get("id")), "schema_invalid", "故事节点 ID 无效。", 422)
        x, y, anchor = beat.get("sourceStart"), beat.get("sourceEnd"), beat.get("anchorTime")
        require(finite(x) and finite(y) and finite(anchor) and previous <= x < y <= b and x <= anchor <= y, "schema_invalid", "故事节点时间重叠或越界。", 422)
        previous = y
        bounded_text(beat.get("label"), "label", 100, True)
        text = bounded_text(beat.get("text"), "text", 500, True)
        require(beat.get("explanationKind") in ("visible-fact", "data-fact", "interpretation"), "schema_invalid", "叙事类别无效。", 422)
        refs = beat.get("observationIds")
        require(isinstance(refs, list) and refs and len(refs) <= 10 and all(valid_id(r) and r in obs and obs[r]["review"]["status"] == "accepted" for r in refs), "review_required", "节点引用未审核观察。", 422)
        for rid in refs:
            evidence = obs[rid]
            early_anchor = evidence["type"] in ("shot", "catch", "pass") and evidence["anchorTime"] is not None and evidence["anchorTime"] <= x and evidence["frameIds"]
            if early_anchor and frame_times is not None:
                early_anchor = all(fid in frame_times and frame_times[fid] <= x for fid in evidence["frameIds"])
            require(evidence["end"] <= x or early_anchor, "review_required", "节点引用了尚不可用的观察或帧。", 422)
        br = beat.get("bindingIds")
        require(isinstance(br, list) and len(br) <= 10 and all(valid_id(r) and r in bind and bind[r]["status"] == "confirmed" and bind[r]["observationId"] in refs for r in br), "unresolved_binding", "节点引用未确认绑定。", 422)
        mid = beat.get("metricRecordId")
        placeholders = re.findall(r"\{\{metric:([^{}]+)\}\}", text)
        require(text.count("{{") == len(placeholders) and text.count("}}") == len(placeholders), "schema_invalid", "正文含畸形占位符。", 422)
        if mid is not None:
            require(valid_id(mid) and mid in metric and any(mid in bind[r]["metricRecordIds"] for r in br), "unresolved_binding", "主指标没有确认绑定。", 422)
            record = metric[mid]
            timing = record["time"]
            require(record["scope"]["granularity"] in ("shot", "event") and record["value"] is not None and timing["availableAt"] is not None and timing["availableAt"] <= x and (timing.get("observedAt") is None or timing["observedAt"] <= x) and (timing.get("validFrom") is None or timing["validFrom"] <= x) and (timing.get("validTo") is None or y <= timing["validTo"]), "unresolved_binding", "指标缺值、粒度错误或不覆盖节点完整显示窗。", 422)
            require(placeholders == [mid], "schema_invalid", "指标文本只能使用当前唯一记录占位符。", 422)
        elif placeholders:
            raise BroadcastError("unresolved_binding", "正文有未绑定指标。", 422)
        grounded_wording(text, [obs[r] for r in refs], project["context"]["roster"])
        grounded_wording(beat["label"], [obs[r] for r in refs], project["context"]["roster"])
        if beat.get("secondaryLabel"):
            grounded_wording(beat["secondaryLabel"], [obs[r] for r in refs], project["context"]["roster"])
        from .tactics import validate_beat_tactics
        validate_beat_tactics(project, beat, frame_times)
        annotation = beat.get("annotation")
        if annotation is not None:
            require(isinstance(annotation, dict) and annotation.get("sourceObservationId") in refs and bool(annotation.get("confirmedBy")) and bool(annotation.get("confirmedAt")), "review_required", "箭头须来自已确认观察。", 422)
            points(annotation.get("points"))
            g = obs[annotation["sourceObservationId"]].get("geometry")
            require(g is not None and g["segmentId"] == obs[annotation["sourceObservationId"]]["segmentId"], "review_required", "箭头缺少同镜头几何旁证。", 422)
            require(g["validFrom"] < y and g["validTo"] > x, "review_required", "箭头的已确认几何窗与节点没有交集。", 422)
            require(annotation["points"] == g["points"], "review_required", "箭头点位与已确认几何不一致。", 422)
            if frame_times is not None:
                ids = obs[annotation["sourceObservationId"]]["frameIds"]
                require(any(fid in frame_times and g["validFrom"] <= frame_times[fid] <= g["validTo"] and x - .2 <= frame_times[fid] <= x + .04 for fid in ids), "review_required", "箭头需要解说开始附近的真实目标帧。", 422)
    return True


def content_hash(project):
    return hash_json({k: project[k] for k in ("media", "context", "observations", "bindings", "metrics", "story")})
