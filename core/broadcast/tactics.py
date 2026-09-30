"""Source-backed basketball concepts, matched only to prior reviewed video evidence."""
import json
import re
from functools import lru_cache
from pathlib import Path

from .common import finite, require

CATALOGUE_PATH = Path(__file__).resolve().parents[2] / "data" / "basketball-tactics.v1.json"
REQUIREMENTS = {
    "screen": ("screen",),
    "pick-and-roll": ("onball_screen", "roll"),
    "pick-and-pop": ("onball_screen", "pop"),
    "handoff": ("handoff",),
    "give-and-go": ("givego",),
    "backdoor": ("backdoor",),
    "offball-screen": ("offball_screen",),
    "drive-and-kick": ("drive", "kick"),
    "post-up": ("post",),
    "fast-break": ("fastbreak",),
}
FEATURE_LABELS = {
    "screen": "掩护动作", "onball_screen": "持球人借掩护", "roll": "掩护者顺下", "pop": "掩护者外弹",
    "handoff": "近距离手递手", "givego": "同一传球人交球后切入", "backdoor": "从防守者身后反切",
    "offball_screen": "为无球队友设掩护", "drive": "持球突破", "kick": "向外线分球",
    "post": "低位背身持球或要位", "fastbreak": "球权转换后向前推进",
}


@lru_cache(maxsize=1)
def catalogue():
    data = json.loads(CATALOGUE_PATH.read_text(encoding="utf-8"))
    assert data["schema"] == "courtlens-basketball-tactics/1"
    assert {row["id"] for row in data["catalogue"]} == set(REQUIREMENTS)
    assert all(source["url"].startswith("https://") for row in data["catalogue"] for source in row["sources"])
    assert all(row.get("terms", {}).get("en") and row.get("terms", {}).get("zh") for row in data["catalogue"])
    return data


TRADITIONAL_TERMS = str.maketrans("擋順護彈傳無單轉換籃線後給為隊遞見確認並發現", "挡顺护弹传无单转换篮线后给为队递见确认并发现")
VISIBLE_ACTION_NAMES = {"handoff", "backdoor", "offball-screen", "post-up"}


def normalized_terms(text):
    return text.translate(TRADITIONAL_TERMS).casefold()


def _features(observation):
    """Require explicit reviewed phrasing; type alone never proves a named play."""
    kind = observation["type"]
    words = normalized_terms(observation["description"])
    # A tentative or negated description is useful to a reviewer, but is not
    # positive evidence for a named tactic. This intentionally errs on silence.
    if re.search(r"没有看到|未看到|未见|没有|并未|并非|并不|并无|尚未|未发生|未出现|未进行|未完成|不能确认|不是|不确定|可能|疑似|似乎|看不清|无法判断|待确认|未能确认|未证实|\b(?:no|not|never|without|cannot|unclear|uncertain|possibly|maybe|may|might|could)\b|didn.t", words):
        return set()
    found = set()
    screen = kind == "screen" and bool(re.search(r"掩护|挡拆|挡住|\bscreen\b|\bpick\b", words))
    if screen:
        found.add("screen")
        if re.search(r"持球|运球|挡拆|ball.?screen|on.?ball", words) and not re.search(r"无球|off.?ball", words):
            found.add("onball_screen")
        if re.search(r"无球|off.?ball", words):
            found.add("offball_screen")
    if kind in ("screen", "movement", "other") and re.search(r"掩护(?:人|者).{0,12}(?:顺下|下顺|切向篮下)|(?:顺下|下顺).{0,8}掩护(?:人|者)|screener.{0,15}roll", words):
        found.add("roll")
    if kind in ("screen", "movement", "other") and re.search(r"掩护(?:人|者).{0,12}(?:外弹|外拆|向外线)|(?:外弹|外拆).{0,8}掩护(?:人|者)|screener.{0,15}pop", words):
        found.add("pop")
    if kind in ("pass", "other") and re.search(r"手递手|手交手|handoff|hand.?off", words):
        found.add("handoff")
    if kind in ("pass", "movement", "other") and re.search(r"(?:传球|交球|传出).{0,10}(?:自己|传球人|传球者|随即|立即).{0,8}切入|传切配合|give.and.go", words):
        found.add("givego")
    if kind in ("movement", "other") and re.search(r"反切|背切|防守(?:人|者).{0,8}身后.{0,8}切|backdoor", words):
        found.add("backdoor")
    if kind in ("movement", "other", "shot") and re.search(r"持球.{0,8}(?:突破|突入)|运球.{0,8}(?:突破|突入)|突破.{0,8}持球", words):
        found.add("drive")
    if kind == "pass" and re.search(r"(?:分球|传球|送球).{0,10}(?:外线|底角|三分线)|(?:外线|底角).{0,8}(?:分球|传球)|突破分球|kick.?out", words):
        found.add("kick")
    if kind in ("movement", "catch", "other") and re.search(r"(?:低位|篮下).{0,8}(?:背身|要位)|背身.{0,8}(?:持球|要位|低位)|post.?up", words):
        found.add("post")
    if kind in ("movement", "pass", "other") and re.search(r"(?:转换|快攻|反击).{0,14}(?:推进|前场|向前|冲向篮筐)|(?:抢断|篮板).{0,12}(?:快速|向前).{0,8}推进|fast.?break", words):
        found.add("fastbreak")
    return found


def _compatible_actors(first, second):
    """Reject explicit actor conflicts; otherwise retain a tentative candidate."""
    left, right = set(first.get("playerIds") or []), set(second.get("playerIds") or [])
    if left and right and not left.intersection(right):
        return False
    jerseys = lambda row: set(re.findall(r"(?<!\d)(?:#\s*)?(\d{1,2})\s*号", row["description"]))
    first_jerseys, second_jerseys = jerseys(first), jerseys(second)
    if len(first_jerseys) == len(second_jerseys) == 1 and first_jerseys != second_jerseys:
        return False
    return True


def _sequence_supported(window, first_feature, second_feature):
    for first, first_features in window:
        if first_feature not in first_features:
            continue
        for second, second_features in window:
            if second_feature not in second_features:
                continue
            if first is second:
                return True  # the reviewed description explicitly contains both roles
            if (first["start"] <= second["start"] <= first["end"] + 4 and
                    first["end"] <= second["end"] and _compatible_actors(first, second)):
                return True
    return False


def _prior_evidence(project, frame_times, at):
    evidence = []
    for row in project["observations"]:
        if row["review"]["status"] != "accepted" or row["type"] == "result" or row["end"] > at:
            continue
        frame_ids = row.get("frameIds") or []
        if not frame_ids or any(fid not in frame_times or frame_times[fid] > at for fid in frame_ids):
            continue
        features = _features(row)
        if features:
            evidence.append((row, features))
    return evidence


def _best_window(evidence, requirements):
    best = None
    for anchor, _ in evidence:
        window = [(row, features) for row, features in evidence if row["segmentId"] == anchor["segmentId"]
                  and abs(row["end"] - anchor["end"]) <= 6 and max(row["end"], anchor["end"]) - min(row["start"], anchor["start"]) <= 6]
        seen = set().union(*(features for _, features in window)) if window else set()
        if "onball_screen" in requirements and "roll" in seen and not _sequence_supported(window, "onball_screen", "roll"):
            seen.discard("roll")
        if "onball_screen" in requirements and "pop" in seen and not _sequence_supported(window, "onball_screen", "pop"):
            seen.discard("pop")
        if "drive" in requirements and "kick" in seen and not _sequence_supported(window, "drive", "kick"):
            seen.discard("kick")
        matched = [item for item in requirements if item in seen]
        if not matched:
            continue
        rank = (len(matched) == len(requirements), len(matched), max(row["end"] for row, _ in window))
        if best is None or rank > best[0]:
            best = (rank, window, matched)
    return best


def retrieve(project, frame_times, at, query=""):
    """Retrieve concepts and tentative matches as of source PTS `at`.

    A game's final play-by-play, team identity, and later frames are never match
    inputs. A team article is separate dated context, not an inference rule.
    """
    require(project.get("media") is not None and finite(at) and 0 <= at <= project["media"]["duration"],
            "invalid_request", "战术检索时刻必须位于源片内。", 422)
    require(isinstance(query, str) and len(query) <= 60 and not any(ord(c) < 32 for c in query),
            "invalid_request", "战术检索词无效。", 422)
    db = catalogue()
    needle = query.strip().casefold()
    entries = [row for row in db["catalogue"] if not needle or needle in
               (row["label"] + " " + row["summary"] + " " + row["id"] + " " +
                " ".join(row["terms"].values())).casefold()]
    evidence = _prior_evidence(project, frame_times, at)
    candidates = []
    for concept in entries:
        requirements = REQUIREMENTS[concept["id"]]
        best = _best_window(evidence, requirements)
        if best is None:
            continue
        _, window, matched = best
        chosen = [(row, features) for row, features in window if features.intersection(matched)]
        candidates.append({"id": concept["id"], "label": concept["label"],
                           "match": "rule-candidate" if len(matched) == len(requirements) else "needs-evidence",
                           "observedCues": [FEATURE_LABELS[name] for name in matched],
                           "missingCues": [FEATURE_LABELS[name] for name in requirements if name not in matched],
                           "observationIds": list(dict.fromkeys(row["id"] for row, _ in chosen)),
                           "frameIds": list(dict.fromkeys(fid for row, _ in chosen for fid in row["frameIds"])),
                           "segmentId": chosen[0][0]["segmentId"], "lastEvidenceAt": max(row["end"] for row, _ in chosen),
                           "conditionalCommentary": concept["conditionalCommentary"], "confusable": concept["confusable"],
                           "sources": concept["sources"]})
    candidates.sort(key=lambda row: (row["match"] != "rule-candidate", -row["lastEvidenceAt"], row["label"]))
    game_date = project["context"].get("gameDate")
    season = project["context"].get("seasonId")
    team_ids = {p["teamId"] for p in project["context"].get("roster", [])}
    if project["context"].get("offenseTeamId"):
        team_ids.add(project["context"]["offenseTeamId"])
    team_context = [row for row in db["teamContexts"] if game_date and season and row["teamId"] in team_ids
                    and row["seasonId"] == season and row["validFrom"] <= game_date <= row["validTo"]
                    and row["source"]["publishedAt"] <= game_date]
    return {"schema": "courtlens-tactic-retrieval/1", "projectId": project["id"], "projectRevision": project["revision"],
            "at": at, "query": query.strip(), "catalogue": entries, "teamContext": team_context,
            "candidates": candidates, "basis": "仅检索此时刻以前已接受且有真实源帧的画面观察；候选不是战术定论或概率。"}


def draft_context(project, frame_times, observations):
    """Small, time-bound knowledge excerpts for story drafting, never play proof."""
    if frame_times is None:
        return []
    db = {row["id"]: row for row in catalogue()["catalogue"]}
    context = []
    for row in observations[:12]:
        at = row["earliestCueStart"]
        snapshot = retrieve({**project, "id": project.get("id", "draft"),
                             "revision": project.get("revision", 0)}, frame_times, at)
        relevant = [candidate for candidate in snapshot["candidates"]
                    if row["id"] in candidate["observationIds"]][:4]
        if not relevant:
            continue
        context.append({"at": at, "anchorObservationId": row["id"], "candidates": [
            {"id": item["id"], "label": item["label"], "terms": db[item["id"]]["terms"],
             "definition": db[item["id"]]["summary"], "match": item["match"],
             "observedCues": item["observedCues"], "missingCues": item["missingCues"],
             "observationIds": item["observationIds"], "frameIds": item["frameIds"],
             "lastEvidenceAt": item["lastEvidenceAt"], "confusable": item["confusable"],
             "sources": item["sources"]}
            for item in relevant]})
    return context


def named_tactics(text):
    """Detect specific play names in draft prose, excluding a generic screen."""
    result = set()
    for row in catalogue()["catalogue"]:
        if row["id"] == "screen":
            continue
        for term in row.get("narrationTerms", []):
            if re.search(r"(?<![a-z])" + re.escape(normalized_terms(term)) + r"(?![a-z])", normalized_terms(text)):
                result.add(row["id"])
                break
    return result


CONDITIONAL = re.compile(r"可能|如果|或许|也许|似乎|看起来|有机会|可望|也許|可能會|睇落|\b(?:may|might|could|if|perhaps|possibly)\b", re.I)


def validate_beat_tactics(project, beat, frame_times):
    """Final publication guard shared by model, manual edit, review and render.

    Basic handoff, cut, off-ball screen and post-up actions remain visible
    facts when complete prior visual cues support their terminology. Explanatory prose must
    remain conditional; a catalogue definition never proves a play occurred.
    """
    fields = [beat["text"], beat["label"], beat.get("secondaryLabel") or ""]
    names = set().union(*(named_tactics(value) for value in fields))
    if beat["explanationKind"] == "interpretation":
        require(CONDITIONAL.search(beat["text"]), "schema_invalid",
                "战术解释须使用条件或可能性措辞，不能把候选写成事实。", 422)
        for value in fields:
            require(not named_tactics(value) or CONDITIONAL.search(value), "schema_invalid",
                    "含具名战术的正文或标签须保留条件或可能性措辞。", 422)
    if not names:
        return True
    snapshot = retrieve(project, frame_times or {}, beat["sourceStart"])
    cited = set(beat["observationIds"])
    supported = {row["id"] for row in snapshot["candidates"] if row["match"] == "rule-candidate"
                 and set(row["observationIds"]) <= cited}
    require(names <= supported, "schema_invalid",
            "具名战术缺少该时刻已复核的完整画面线索与节点引用。", 422)
    visible_action = beat["explanationKind"] == "visible-fact" and names <= VISIBLE_ACTION_NAMES
    require(beat["explanationKind"] == "interpretation" or visible_action, "schema_invalid",
            "具名配合战术须为有条件的解释；已具备完整线索的基本动作可作为画面事实。", 422)
    return True


def story_knowledge(project, frame_times, story):
    """Recompute auditable citations; callers cannot supply their own proof."""
    result = []
    for beat in story["beats"]:
        names = set().union(*(named_tactics(beat.get(key) or "") for key in ("text", "label", "secondaryLabel")))
        if not names:
            continue
        snapshot = retrieve(project, frame_times or {}, beat["sourceStart"])
        result.append({"beatId": beat["id"], "at": snapshot["at"],
                       "catalogueVersion": catalogue()["updatedAt"],
                       "candidates": [row for row in snapshot["candidates"] if row["id"] in names],
                       "role": "Terminology definitions and prior reviewed cues; conditional interpretation, not independent visual proof."})
    return result
