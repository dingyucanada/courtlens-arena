"""Validate the public data contract without third-party dependencies.

Validation deliberately does not authenticate a source or certify its metrics.
Missing observations are represented as null, never silently imputed.
"""

import copy
import math
import re


SEMANTICS = {
    "xfg_pct": "shot_make_probability",
    "gravity": "supplied_metric",
    "leverage": "possession_win_probability_opportunity",
}


class ValidationError(ValueError):
    def __init__(self, path, message):
        self.path = path
        self.message = message
        super().__init__(f"{path}: {message}")


def fail(path, message):
    raise ValidationError(path, message)


def obj(value, path):
    if not isinstance(value, dict):
        fail(path, "必须是对象")
    return value


def required(value, key, path):
    if key not in value:
        fail(f"{path}.{key}", "缺少必填字段；未知指标请显式使用 null")
    return value[key]


def string(value, path, limit=1000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        fail(path, f"必须是长度 1–{limit} 的非空字符串")
    return value


def number(value, path, minimum=None, maximum=None):
    # bool is an int in Python; accepting it here hides malformed JSON.
    try:
        finite = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
    except (OverflowError, TypeError):
        finite = False
    if not finite:
        fail(path, "必须是有限数字，不能是 NaN、Infinity、布尔值或字符串")
    if minimum is not None and value < minimum:
        fail(path, f"不能小于 {minimum}")
    if maximum is not None and value > maximum:
        fail(path, f"不能大于 {maximum}")
    return value


def array(value, path, minimum=0, maximum=10000):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail(path, f"必须是包含 {minimum}–{maximum} 项的数组")
    return value


def enum(value, path, options):
    if not isinstance(value, str) or value not in options:
        fail(path, "必须是 " + " / ".join(options))
    return value


def coord(value, path):
    obj(value, path)
    for key in ("x", "y"):
        number(required(value, key, path), f"{path}.{key}", 0, 1)


def all_finite(value, path="dataset", depth=0):
    if depth > 40:
        fail(path, "数据嵌套过深")
    if isinstance(value, float) and not math.isfinite(value):
        fail(path, "不允许非有限数字")
    if isinstance(value, dict):
        for key, item in value.items():
            all_finite(item, f"{path}.{key}", depth + 1)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            all_finite(item, f"{path}[{index}]", depth + 1)


def validate_dataset(dataset):
    """Return a defensive copy or raise a path-specific ValidationError."""
    d = obj(dataset, "dataset")
    all_finite(d)
    if required(d, "schema_version", "dataset") != "1.0":
        fail("dataset.schema_version", "当前仅支持 1.0")
    prov = obj(required(d, "provenance", "dataset"), "dataset.provenance")
    enum(required(prov, "kind", "dataset.provenance"), "dataset.provenance.kind", ("synthetic", "official", "user"))
    for key in ("label", "source"):
        string(required(prov, key, "dataset.provenance"), f"dataset.provenance.{key}", 2000)
    game = obj(required(d, "game", "dataset"), "dataset.game")
    for key in ("title", "home", "away", "period", "score"):
        string(required(game, key, "dataset.game"), f"dataset.game.{key}", 200)
    if game["home"] == game["away"]:
        fail("dataset.game.away", "主客队不能相同")
    teams = (game["home"], game["away"])
    video = obj(required(d, "video", "dataset"), "dataset.video")
    string(required(video, "url", "dataset.video"), "dataset.video.url", 2000)
    duration = number(required(video, "duration", "dataset.video"), "dataset.video.duration", 0.001, 14400)
    for key in ("width", "height"):
        value = number(required(video, key, "dataset.video"), f"dataset.video.{key}", 1, 32768)
        if not isinstance(value, int):
            fail(f"dataset.video.{key}", "必须是整数")
    if "sha256" in video and (not isinstance(video["sha256"], str) or not re.fullmatch(r"[a-fA-F0-9]{64}", video["sha256"])):
        fail("dataset.video.sha256", "必须是64位十六进制视频指纹")
    if "workflow" in d:
        workflow=obj(d["workflow"],"dataset.workflow")
        enum(required(workflow,"state","dataset.workflow"),"dataset.workflow.state",("draft","reviewed"))
    definitions = obj(required(d, "metric_definitions", "dataset"), "dataset.metric_definitions")
    for key in SEMANTICS:
        string(required(definitions, key, "dataset.metric_definitions"), f"dataset.metric_definitions.{key}", 2000)
    semantics = d.get("metric_semantics", {})
    obj(semantics, "dataset.metric_semantics")
    for key, value in semantics.items():
        if key in SEMANTICS and value != SEMANTICS[key]:
            fail(f"dataset.metric_semantics.{key}", f"未知或不兼容口径，需按正式字典适配为 {SEMANTICS[key]}，不能仅改名或缩放")
    possessions = array(required(d, "possessions", "dataset"), "dataset.possessions", 1, 200)
    ids, annotation_ids, evidence_owners, previous_end, sample_count = set(), set(), {}, -1, 0
    reserved_ids = set()
    for p in possessions:
        if isinstance(p, dict) and isinstance(p.get("id"), str):
            for suffix in ("metric:xfg_pct", "metric:gravity", "metric:leverage", "event", "result", "tracking", "rank"):
                reserved_ids.add(f"{p['id']}:{suffix}")
    for i, p in enumerate(possessions):
        path = f"dataset.possessions[{i}]"
        obj(p, path)
        pid = string(required(p, "id", path), f"{path}.id", 80)
        if pid in ids:
            fail(f"{path}.id", "回合 ID 重复")
        ids.add(pid)
        for key in ("title", "clock", "shooter"):
            string(required(p, key, path), f"{path}.{key}", 200)
        enum(required(p, "offense", path), f"{path}.offense", teams)
        enum(required(p, "result", path), f"{path}.result", ("made", "missed", "unknown"))
        start = number(required(p, "start", path), f"{path}.start", 0, duration)
        end = number(required(p, "end", path), f"{path}.end", 0, duration)
        if end <= start:
            fail(f"{path}.end", "必须晚于 start")
        if start < previous_end:
            fail(f"{path}.start", "回合必须按时间排列且不能重叠")
        previous_end = end
        number(required(p, "shot_time", path), f"{path}.shot_time", start, end)
        if p["shot_time"] >= end:
            fail(f"{path}.shot_time", "出手时刻必须早于回合终点")
        if "result_time" in p and p["result_time"] is not None:
            number(p["result_time"], f"{path}.result_time", p["shot_time"], end)
        pts = number(required(p, "points", path), f"{path}.points", 0, 4)
        if not isinstance(pts, int):
            fail(f"{path}.points", "必须是整数；表示本次投篮的分值，不保证实际得分")
        metrics = obj(required(p, "metrics", path), f"{path}.metrics")
        for key in SEMANTICS:
            val = required(metrics, key, f"{path}.metrics")
            if val is not None:
                number(val, f"{path}.metrics.{key}", None if key == "gravity" else 0, None if key == "gravity" else 1)
        if prov["kind"] != "synthetic" and metrics["leverage"] is not None and semantics.get("leverage") != SEMANTICS["leverage"]:
            fail("dataset.metric_semantics.leverage", "正式或用户数据须先声明并核对回合胜率机会差口径；不接受未知 Leverage 或球员 -10…+10 累计分")
        for key in ("source_refs", "notes"):
            for j, item in enumerate(array(required(p, key, path), f"{path}.{key}", 1 if key == "source_refs" else 0, 100)):
                string(item, f"{path}.{key}[{j}]", 2000)
        segments = array(required(p, "camera_segments", path), f"{path}.camera_segments", 1, 100)
        segment_end = start
        for j, seg in enumerate(segments):
            sp = f"{path}.camera_segments[{j}]"
            obj(seg, sp)
            a = number(required(seg, "start", sp), f"{sp}.start", start, end)
            b = number(required(seg, "end", sp), f"{sp}.end", start, end)
            if b <= a or a < segment_end:
                fail(sp, "镜头段必须有正时长、按时间排序且不重叠")
            segment_end = b
            if not isinstance(required(seg, "calibrated", sp), bool):
                fail(f"{sp}.calibrated", "必须是布尔值")
        tracks = array(required(p, "tracks", path), f"{path}.tracks", 0, 50000)
        sample_count += len(tracks)
        if sample_count > 150000:
            fail("dataset.possessions", "轨迹总样本数超过 150000")
        prev_t = -1
        player_teams = {}
        for j, track in enumerate(tracks):
            tp = f"{path}.tracks[{j}]"
            obj(track, tp)
            t = number(required(track, "t", tp), f"{tp}.t", start, end)
            if t <= prev_t:
                fail(f"{tp}.t", "轨迹时刻必须严格递增，不允许重复或倒序")
            prev_t = t
            frame_ids = set()
            players = array(required(track, "players", tp), f"{tp}.players", 0, 30)
            for k, player in enumerate(players):
                pp = f"{tp}.players[{k}]"
                coord(player, pp)
                player_id = string(required(player, "id", pp), f"{pp}.id", 80)
                if player_id in frame_ids:
                    fail(f"{pp}.id", "同一帧球员 ID 重复")
                frame_ids.add(player_id)
                team = enum(required(player, "team", pp), f"{pp}.team", teams)
                if player_id in player_teams and player_teams[player_id] != team:
                    fail(f"{pp}.team", "同一球员的球队在回合内不一致")
                player_teams[player_id] = team
            coord(required(track, "ball", tp), f"{tp}.ball")
        if p["shooter"] in player_teams and player_teams[p["shooter"]] != p["offense"]:
            fail(f"{path}.shooter", "投篮球员不属于进攻球队")
        for j, ann in enumerate(array(required(p, "annotations", path), f"{path}.annotations", 0, 100)):
            ap = f"{path}.annotations[{j}]"
            obj(ann, ap)
            origin = enum(ann.get("origin", "tracking"), f"{ap}.origin", ("tracking", "manual"))
            if origin == "manual":
                string(required(ann, "author_note", ap), f"{ap}.author_note", 500)
                if ann.get("frame_reviewed") is not True:
                    fail(f"{ap}.frame_reviewed", "人工标注须显式确认画面时间，不能替代跟踪校准")
            aid = string(required(ann, "id", ap), f"{ap}.id", 120)
            if aid in annotation_ids:
                fail(f"{ap}.id", "注释 ID 重复")
            annotation_ids.add(aid)
            kind = enum(required(ann, "kind", ap), f"{ap}.kind", ("arrow", "zone", "label"))
            a = number(required(ann, "start", ap), f"{ap}.start", start, end)
            b = number(required(ann, "end", ap), f"{ap}.end", start, end)
            if b <= a:
                fail(f"{ap}.end", "必须晚于 start")
            if origin=="manual" and not any(s["start"]<=a and s["end"]>=b for s in p["camera_segments"]):
                fail(ap,"人工标注不能跨越已声明的镜头边界")
            points = array(required(ann, "points", ap), f"{ap}.points", {"arrow": 2, "zone": 3, "label": 1}[kind], 100)
            for k, point in enumerate(points):
                array(point, f"{ap}.points[{k}]", 2, 2)
                number(point[0], f"{ap}.points[{k}][0]", 0, 1)
                number(point[1], f"{ap}.points[{k}][1]", 0, 1)
            string(required(ann, "label", ap), f"{ap}.label", 200)
            eid = string(required(ann, "evidence_id", ap), f"{ap}.evidence_id", 160)
            if eid in reserved_ids:
                fail(f"{ap}.evidence_id", "注释证据 ID 不能占用分析器内置 ID")
            if eid in evidence_owners and evidence_owners[eid] != pid:
                fail(f"{ap}.evidence_id", "不同回合不能共用同一注释证据 ID")
            evidence_owners[eid] = pid
    return copy.deepcopy(d)
