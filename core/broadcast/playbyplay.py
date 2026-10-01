"""Evidence-backed spoken action lane, separate from the three visual beats.

This module neither watches footage nor translates descriptions. Timings and
text estimates are authoring aids; human semantic review and measured audio
remain necessary. Silence is valid when accepted event evidence is sparse.
"""
import math
import re

from .common import BroadcastError, bounded_text, finite, require, uid, valid_id

MAX_CUES = 60
MAX_CUE_SECONDS = 8
MAX_EVENT_LAG = 3
FIELDS = {"id", "sourceStart", "sourceEnd", "text", "observationIds", "language"}
METRIC_WORDING = re.compile(
    r"\{\{|\}\}|[%％]|百分之|百分比|百分点|百分點|胜率|勝率|"
    r"(?<![A-Za-z])(?:xFG|GRAV|LVG)(?![A-Za-z])|"
    r"\b(?:percent(?:age)?|per\s+cent|win\s+probability|leverage)\b", re.I)


def available_at(observation, frame_times=None):
    """An anchored event is available only with every cited decoded frame.

    Interval conclusions and results wait for their reviewed window to end.
    Missing frame PTS never grants early access. This rule does not certify
    that a frame actually proves the description; that is a review decision.
    """
    frames = observation.get("frameIds") or []
    anchor = observation.get("anchorTime")
    early = (observation.get("type") in ("shot", "catch", "pass")
             and finite(anchor) and bool(frames) and frame_times is not None
             and all(fid in frame_times and finite(frame_times[fid]) for fid in frames))
    cited = [frame_times[fid] for fid in frames if frame_times is not None and fid in frame_times and finite(frame_times[fid])]
    return max([anchor, *cited]) if early else max([observation["end"], *cited])


def event_context(project, frame_times=None):
    """Return only accepted event windows; no metric values or extra actors."""
    result = []
    for row in sorted(project.get("observations", []), key=lambda o: (o["start"], o["end"])):
        if (row.get("review") or {}).get("status") != "accepted":
            continue
        at = available_at(row, frame_times)
        result.append({"observationId": row["id"], "type": row["type"],
                       "earliestCueStart": at, "latestCueStart": at + MAX_EVENT_LAG,
                       "description": row["description"], "playerIds": row["playerIds"]})
    return result


def validate_cues(project, frame_times=None):
    """Validate optional spoken cues independently of visual metric windows."""
    from .commentary_style import resolve_style
    from .validation import grounded_wording
    story = project["story"]
    if "commentaryCues" not in story:
        return True
    cues = story["commentaryCues"]
    require(isinstance(cues, list) and len(cues) <= MAX_CUES, "schema_invalid", "逐动作口播最多60句。", 422)
    language = resolve_style(story.get("commentaryStyle"), story.get("language"))["language"]
    observations = {o["id"]: o for o in project["observations"]}
    previous = story["sourceRange"]["start"]
    ids = set()
    for cue in cues:
        require(isinstance(cue, dict) and set(cue) == FIELDS and valid_id(cue.get("id")) and cue["id"] not in ids,
                "schema_invalid", "逐动作口播字段或ID无效。", 422)
        ids.add(cue["id"])
        start, end = cue["sourceStart"], cue["sourceEnd"]
        require(finite(start) and finite(end) and previous <= start < end <= story["sourceRange"]["end"]
                and end - start <= MAX_CUE_SECONDS, "schema_invalid", "口播时间重叠、越界或单句超过8秒。", 422)
        previous = end
        require(cue["language"] == language, "schema_invalid", "口播语言与故事所选语言不一致。", 422)
        refs = cue["observationIds"]
        require(isinstance(refs, list) and 1 <= len(refs) <= 10
                and all(valid_id(r) and r in observations and observations[r]["review"]["status"] == "accepted" for r in refs)
                and len(set(refs)) == len(refs),
                "review_required", "口播须引用唯一的已接受动作观察。", 422)
        evidence = [observations[r] for r in refs]
        available = max(available_at(o, frame_times) for o in evidence)
        require(available <= start + 1e-6 and start <= available + MAX_EVENT_LAG + 1e-6, "review_required", "口播早于动作证据或离事件过远；请补充当前时刻的观察。", 422)
        text = bounded_text(cue["text"], "text", 280, True)
        require(not METRIC_WORDING.search(text), "schema_invalid", "逐动作口播不读概率或高级指标；数值保留在分析图层。", 422)
        extra_outcome = re.search(r"没进|沒進|未进|未進|\b(?:it['’]s in|drops through)\b", text, re.I)
        require(not extra_outcome or any(o["type"] == "result" for o in evidence), "review_required", "结果口播需要已接受的结果观察。", 422)
        grounded_wording(text, evidence, project["context"]["roster"])
        player_ids = {pid for o in evidence for pid in o["playerIds"]}
        for player in project["context"]["roster"]:
            name = player.get("name")
            if isinstance(name, str) and name and player["id"] not in player_ids:
                pattern = (r"(?<![A-Za-z])" + re.escape(name) + r"(?![A-Za-z])") if re.search(r"[A-Za-z]", name) else re.escape(name)
                require(not re.search(pattern, text, re.I), "review_required", "口播姓名未由本句已接受观察支持。", 422)
        from .tactics import validate_beat_tactics
        validate_beat_tactics(project, {**cue, "label": "", "explanationKind": "visible-fact"}, frame_times)
    return True


def draft_cues(project, frame_times=None, language="zh-CN"):
    """Short original templates for reviewed action types in three languages.

    Short Mandarin descriptions can retain their precise action wording.
    Generic templates deliberately omit location, intentions and identities
    not established by the observation. These remain drafts requiring review.
    """
    require(language in ("zh-CN", "en-US", "yue-HK"), "invalid_request", "口播语言无效。")
    source_range = (project.get("story") or {}).get("sourceRange") or {"start": 0, "end": project["media"]["duration"]}
    previous = source_range["start"]
    cues = []
    for event in sorted(event_context(project, frame_times), key=lambda e: e["earliestCueStart"]):
        text = _action_text(event, project["context"]["roster"], language)
        if not text:
            continue
        # A conservative character/word budget, not measured speech timing.
        han = len(re.findall(r"[\u3400-\u9fff]", text))
        words = len(re.findall(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*", text))
        digits = len(re.findall(r"[0-9]", text))
        estimate = han / 3 + words / 2.5 + digits / 2.5 + .3
        start = math.ceil(max(previous, event["earliestCueStart"]) * 25 - 1e-8) / 25
        end = math.ceil((start + max(1, estimate)) * 25 - 1e-8) / 25
        if (not (han or words) or METRIC_WORDING.search(text) or end > source_range["end"]
                or end - start > MAX_CUE_SECONDS or start > event["latestCueStart"]):
            continue
        cue = {"id": uid(), "sourceStart": start, "sourceEnd": end, "text": text,
               "observationIds": [event["observationId"]], "language": language}
        temporary = {**project, "story": {**(project.get("story") or {}), "sourceRange": source_range,
                     "commentaryStyle": "analysis", "language": language, "commentaryCues": [cue]}}
        try:
            validate_cues(temporary, frame_times)
        except BroadcastError:
            continue
        cues.append(cue)
        previous = end
        if len(cues) == MAX_CUES:
            break
    return cues


ACTION_TEXT = {
    "zh-CN": {"pass": "球传出去了。", "catch": "接到球。", "shot": "起手投篮。",
              "movement": "球员在跑动。", "screen": "这里有个掩护。", "made": "球进了！", "missed": "没进。"},
    "en-US": {"pass": "The pass is away.", "catch": "The catch.", "shot": "The shot is up.",
              "movement": "A player on the move.", "screen": "A screen here.", "made": "It goes in!", "missed": "It won't go."},
    "yue-HK": {"pass": "個波傳咗出去。", "catch": "接到個波。", "shot": "起手投籃。",
               "movement": "球員喺度走位。", "screen": "呢度有個掩護。", "made": "入咗！", "missed": "唔入。"},
}


def _action_text(event, roster, language):
    description = event["description"].strip()
    if METRIC_WORDING.search(description):
        return None
    kind = event["type"]
    if kind == "result":
        # A result record alone does not state whether the attempt went in.
        if re.search(r"可能|如果|或许|或許|疑似|\b(?:if|might|maybe|could)\b", description, re.I):
            return None
        # Negative outcomes must be recognized before the affirmative substring
        # (未命中 contains 命中; not made contains made). Ambiguous negations stay silent.
        if re.search(r"并非|並非|不是没|不是沒|不是未|\b(?:not missed|did(?:n['’]t| not) miss)\b", description, re.I):
            return None
        negative = (r"未能命中|没有命中|沒有命中|未命中|不中|投失|射失|没进|沒進|唔入|唔中|冇入|"
                    r"打铁|打鐵|没投进|沒投進|未投进|未投進|没有投进|沒有投進|未进|未進|不进|不進|"
                    r"\b(?:not made|was not made|did not make|didn['’]t make|missed|misses|no good|won['’]t go|does not go in|did not go in)\b")
        missed = bool(re.search(negative, description, re.I))
        positive = re.sub(negative, "", description, flags=re.I)
        if re.search(r"未|没|沒|不|冇|唔|\b(?:never|not)\b|n['’]t\b", positive, re.I):
            return None
        made = bool(re.search(r"命中(?!率|概率)|投进|投進|进了|進了|入网|入網|进入篮筐|進入籃筐|入咗|入籃|射入|中咗|\b(?:made|scores|scored|goes in|goes down)\b", positive, re.I))
        return ACTION_TEXT[language]["missed" if missed else "made"] if made != missed else None
    if kind not in ACTION_TEXT[language]:
        return None
    # Preserve a naturally short reviewed action rather than inventing detail.
    if language == "zh-CN" and 0 < len(re.findall(r"[\u3400-\u9fff]", description)) <= 20 and len(description) <= 50:
        return description
    text = ACTION_TEXT[language][kind]
    # A referenced roster entry is not automatically the action's subject.
    if kind in ("movement", "shot") and len(event["playerIds"]) == 1:
        player = next((p for p in roster if p["id"] == event["playerIds"][0]), None)
        name = player.get("name") if player else None
        if isinstance(name, str) and name and description.startswith(name):
            suffix = {"zh-CN": {"movement": "在跑动。", "shot": "起手投篮。"},
                      "en-US": {"movement": " on the move.", "shot": " puts up the shot."},
                      "yue-HK": {"movement": "喺度走位。", "shot": "起手投籃。"}}
            text = name + suffix[language][kind]
    return text
