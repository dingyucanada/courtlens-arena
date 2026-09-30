"""Step Plan native-video proposals followed by source-PTS frame verification."""
import base64
import hashlib
import io
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from ..common import BroadcastError, finite, hash_json, now, require, uid
from .bedrock import _extract_json, _normalize
from .story_model import normalize_proposal
from ..media import FFMPEG

URL = "https://api.stepfun.com/step_plan/v1/chat/completions"
MAX_REQUEST = 28 * 1024 * 1024
MAX_RESPONSE = 1024 * 1024
MAX_IMAGE = 1024 * 1024
MAX_TOKENS = 12000
TIMEOUT_SECONDS = 150
REASONING_EFFORT = "low"
MAX_VIDEO = 16 * 1024 * 1024

# Only normalize explicitly read scorebug names; the same-game PBP source must
# still independently confirm which abbreviation is away and which is home.
NBA_NAME_ALIASES = dict(zip(
    "老鹰 凯尔特人 篮网 黄蜂 公牛 骑士 独行侠 掘金 活塞 勇士 火箭 步行者 快船 湖人 灰熊 热火 雄鹿 森林狼 鹈鹕 尼克斯 雷霆 魔术 76人 太阳 开拓者 国王 马刺 猛龙 爵士 奇才".split(),
    "ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS".split()))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def model_for(kind):
    require(kind in ("vision", "story"), "provider_not_configured", "StepFun 模型用途无效。", 503)
    key = os.environ.get("COURTLENS_STEPFUN_API_KEY")
    model = os.environ.get("COURTLENS_STEPFUN_" + kind.upper() + "_MODEL", "step-3.7-flash")
    require(bool(key) and isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", model), "provider_not_configured", "StepFun API 密钥或模型未配置。", 503)
    return model


def _chat(kind, content, *, max_tokens=MAX_TOKENS, timeout=TIMEOUT_SECONDS):
    model = model_for(kind)
    payload = {"model": model, "messages": [{"role": "user", "content": content}], "max_tokens": max_tokens, "temperature": .1, "reasoning_effort": REASONING_EFFORT}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    require(len(body) <= MAX_REQUEST, "unsupported_modality", "多模态输入超过28MiB上限。", 422)
    request = urllib.request.Request(URL, data=body, headers={"Authorization": "Bearer " + os.environ["COURTLENS_STEPFUN_API_KEY"], "Content-Type": "application/json", "Accept": "application/json"}, method="POST")
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout) as response:
            length = response.headers.get("Content-Length")
            require(length is None or int(length) <= MAX_RESPONSE, "provider_failed", "StepFun 响应超出大小限制。", 502)
            require("json" in response.headers.get("Content-Type", "").lower(), "provider_failed", "StepFun 未返回 JSON。", 502)
            data = response.read(MAX_RESPONSE + 1)
            require(len(data) <= MAX_RESPONSE, "provider_failed", "StepFun 响应超出大小限制。", 502)
    except urllib.error.HTTPError as exc:
        # The provider's error body may echo request content; expose only status.
        raise BroadcastError("provider_failed", f"StepFun HTTP {exc.code}；请检查模型权限或请求格式。", 502,
                             exc.code in (408, 409, 425, 429, 500, 502, 503, 504))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise BroadcastError("provider_failed", "StepFun 请求失败；请检查账户和网络。", 502, True)
    try:
        answer = json.loads(data)
        choice = answer["choices"][0]
        raw = choice["message"]["content"]
        if choice.get("finish_reason") != "stop" or not isinstance(raw, str) or not 0 < len(raw) <= 20000:
            reason = choice.get("finish_reason") if choice.get("finish_reason") in ("stop", "length", "content_filter", "tool_calls") else "other"
            usage = answer.get("usage") if isinstance(answer.get("usage"), dict) else {}
            token_count = next((usage.get(key) for key in ("completion_tokens", "output_tokens") if type(usage.get(key)) is int), None)
            detail = f"finishReason={reason}, contentLength={len(raw) if isinstance(raw, str) else 0}, outputTokens={token_count if token_count is not None else 'unknown'}"
            raise BroadcastError("provider_failed", "StepFun 生成未完成或返回空内容（" + detail + "）。", 502,
                                 reason == "length")
        return raw, answer.get("usage", {}), model
    except (KeyError, IndexError, TypeError, ValueError):
        raise BroadcastError("provider_failed", "StepFun 响应结构无效。", 502)


def _jpeg(path):
    try:
        from PIL import Image
        with Image.open(path) as frame:
            frame.thumbnail((1280, 1280))
            image = frame.convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=84, optimize=True)
            data = buffer.getvalue()
    except (ImportError, OSError, ValueError):
        raise BroadcastError("unsupported_modality", "真实证据帧无法转成模型输入。", 422)
    require(0 < len(data) <= MAX_IMAGE, "unsupported_modality", "单帧模型输入超过1MiB。", 422)
    return data


RESULT_EVIDENCE_RULE = ("比分更新可能滞后，回放或剪辑跳时可能造成旧比分；比分未变不能作为投篮不中的证据。"
                        "命中或未中必须有独立可见的球入篮/弹出或连续完整的后续球权证据；"
                        "仅见防守者拿球、底线取球或旧比分，不能判定不中。证据不足只描述出手，结果unknown。")


def _execute_frames(service, project, job, options):
    require(options.get("providerId") == "stepfun-vision" and options.get("strategy") == "frames-first", "unsupported_modality", "StepFun 当前仅提供逐帧图像理解。", 422)
    model = model_for("vision")
    scope = options.get("scope") or {"start": 0, "end": project["media"]["duration"]}
    require(isinstance(scope, dict) and finite(scope.get("start")) and finite(scope.get("end")) and 0 <= scope["start"] < scope["end"] <= project["media"]["duration"], "invalid_request", "图像证据范围无效。", 422)
    require(scope["end"] - scope["start"] <= 48, "unsupported_modality", "StepFun 逐帧分析一次最多48秒；请显式缩小范围。", 422)
    count = min(6, max(2, round((scope["end"] - scope["start"]) / 2)))
    times = [scope["start"] + (scope["end"] - scope["start"]) * (i + .5) / count for i in range(count)]
    frames = service.frames(project["id"], project["revision"], times)["frames"]
    available = {frame["id"]: frame for frame in frames}
    prompt = ("你在看按源PTS排序的篮球素材关键帧，帧间可能发生未知动作。素材也可能只是合成圆点示意图；只有看得见人体姿势和球的动作才能说出手、接球等篮球事件。圆点移动只能写圆点位置变化，不能猜运动员、关节、球权或出手。"
              "只返回JSON对象 {\"observations\":[{\"type\":\"pass|shot|catch|movement|screen|result|other\",\"start\":秒,\"end\":秒,\"anchorTime\":秒或null,\"description\":\"可见事实\",\"frameIds\":[\"实际帧ID\"]}]}，最多2条。"
              "每条必须引用至少一张下方给定的frameId，起止时间须覆盖该帧的真实PTS且位于允许范围；anchorTime只能为所引帧的实际PTS或null。看不清就返回空数组。"
              + RESULT_EVIDENCE_RULE + "不要凭衣服猜具体身份、比赛结果、官方指标或战术因果。允许范围：" + json.dumps(scope, separators=(",", ":")))
    content = [{"type": "text", "text": prompt}]
    for frame in frames:
        image = _jpeg(service.store.find("frames", frame["id"]) / "frame.png")
        content.append({"type": "text", "text": f"frameId={frame['id']}，源PTS={frame['actualTime']:.6f}秒，PNG源hash={frame['sha256']}。"})
        content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")}})
    started = now()
    raw, usage, actual_model = _chat("vision", content)
    result, normalized_raw = _extract_json({"output": {"message": {"content": [{"text": raw}]}}})
    require(len(result["observations"]) <= 2, "schema_invalid", "StepFun 一次最多提出2个候选事件窗。", 422)
    run_id = uid()
    rows = _normalize(result, project, scope, run_id, "image-model", available)
    require(all(row["frameIds"] for row in rows), "schema_invalid", "逐帧模型候选必须引用实际看过的帧。", 422)
    require(all(row["anchorTime"] is None or any(abs(row["anchorTime"] - available[fid]["actualTime"]) <= .04 for fid in row["frameIds"]) for row in rows), "schema_invalid", "模型锚点必须来自所引真实证据帧。", 422)
    fingerprint = [{"id": frame["id"], "actualTime": frame["actualTime"], "sha256": frame["sha256"]} for frame in frames]
    return {"schema": "courtlens-observations/1", "mediaSha256": project["media"]["sha256"], "providerRun": {"id": run_id, "provider": "stepfun-step-plan", "modelId": actual_model, "mode": "image-model", "requestHash": hash_json({"model": model, "scope": scope, "mediaSha256": project["media"]["sha256"], "prompt": prompt, "frames": fingerprint, "maxTokens": MAX_TOKENS, "temperature": .1, "reasoningEffort": REASONING_EFFORT}), "responseHash": hashlib.sha256(normalized_raw.encode()).hexdigest(), "startedAt": started, "completedAt": now()}, "observations": rows, "rawProposal": normalized_raw, "frameFingerprints": fingerprint, "usage": usage, "strategy": "frames-first", "scope": scope, "proposalOnly": True}


def _video_bytes(path, scope):
    """Create a bounded, moving MP4 with an explicit source-time offset."""
    with tempfile.TemporaryDirectory(prefix="courtlens-video-") as directory:
        target = os.path.join(directory, "semantic-input.mp4")
        command = [FFMPEG, "-v", "error", "-nostdin", "-protocol_whitelist", "file",
                   "-ss", str(scope["start"]), "-i", str(path), "-t", str(scope["end"] - scope["start"]),
                   "-vf", "fps=10,scale='min(1280,iw)':-2", "-an", "-c:v", "libx264", "-crf", "26",
                   "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", target]
        try:
            result = subprocess.run(command, capture_output=True, timeout=90)
            require(result.returncode == 0 and os.path.getsize(target) > 0, "unsupported_modality", "视频派生片生成失败。", 422)
            data = open(target, "rb").read(MAX_VIDEO + 1)
        except (OSError, subprocess.TimeoutExpired):
            raise BroadcastError("unsupported_modality", "无法生成视频模型输入。", 422)
    require(len(data) <= MAX_VIDEO, "unsupported_modality", "视频派生片超过16MiB上限；请缩小分析范围。", 422)
    return data


def _scene_cuts(path):
    """Conservative edit boundaries in source PTS; a cut is not an event."""
    try:
        result = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-nostdin", "-i", str(path),
                                 "-vf", "scdet=threshold=10", "-an", "-f", "null", "-"],
                                capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return sorted({float(value) for value in re.findall(r"lavfi\.scd\.time:\s*([0-9]+(?:\.[0-9]+)?)", result.stderr)})


def _candidate_windows(result, scope, revisions):
    candidates = result.get("observations") if isinstance(result, dict) else None
    require(isinstance(candidates, list) and len(candidates) <= 12, "schema_invalid", "视频模型候选窗无效。", 422)
    usable = []
    for row in candidates:
        if not isinstance(row, dict) or not finite(row.get("start")) or not finite(row.get("end")):
            revisions.append({"reason": "invalid_time", "candidate": row})
            continue
        if row["start"] == row["end"] and scope["start"] <= row["start"] < scope["end"]:
            point = row["start"]
            row = {**row, "start": max(scope["start"], point - .5), "end": min(scope["end"], point + .5)}
            revisions.append({"reason": "point_expanded_to_search_window", "point": point, "window": [row["start"], row["end"]]})
        if not scope["start"] <= row["start"] < row["end"] <= scope["end"]:
            revisions.append({"reason": "outside_source_scope", "candidate": row})
            continue
        usable.append(row)
    return usable[:6]


def _background(project):
    pbp = project["context"].get("playByPlay")
    if not pbp:
        return "", None
    source = pbp["source"]
    safe = {"provider": source["provider"], "url": source["url"], "retrievedAt": source["retrievedAt"],
            "gameId": source["gameId"], "entries": pbp["entries"]}
    note = ("以下是另行导入的同场逐回合背景记录，不是从视频识别的画面事实，也不是赛事官方高级指标。"
            "其中clock是比赛时钟，绝非源视频PTS；仅当视频比分牌的节次、比赛时钟、得分变化与记录吻合时，才可用它交叉核对人物和结果。"
            "如果画面与记录不一致，明确保留不确定，不按记录编造画面动作。背景=" + json.dumps(safe, ensure_ascii=False, separators=(",", ":")))
    return note, {"source": source, "entryCount": len(pbp["entries"]), "sha256": hash_json(pbp)}


def _read_scoreboard(service, frame):
    """Ask only for the visible broadcast score bug; never for an event."""
    content = [{"type": "text", "text": "只读这张画面比分牌。仅返回JSON：{\"period\":节次数字或null,\"clock\":\"比赛时钟MM:SS或null\",\"leftScore\":左侧分数或null,\"rightScore\":右侧分数或null,\"leftTeam\":\"左侧队缩写或null\",\"rightTeam\":\"右侧队缩写或null\"}。看不清填null；不要推断动作或球员。"},
               {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(_jpeg(service.store.find("frames", frame["id"]) / "frame.png")).decode("ascii")}}]
    try:
        raw, usage, _ = _chat("vision", content, max_tokens=1200, timeout=25)
        value = _parse_scoreboard(raw)
        return value, {"frameId": frame["id"], "raw": raw, "usage": usage}
    except (BroadcastError, ValueError, TypeError, KeyError) as exc:
        return None, {"frameId": frame["id"], "error": getattr(exc, "code", "invalid_scoreboard")}


def _parse_scoreboard(raw):
    """Accept small provider formatting drift without guessing a missing score."""
    try:
        value = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.I))
    except (ValueError, TypeError):
        labels = {key.strip(): value.strip() for line in raw.splitlines() if (pair := re.split(r"[:：]", line, 1)) and len(pair) == 2 for key, value in [pair]}
        if set(labels) != {"左边球队", "左分", "右边球队", "右分", "节次", "比赛时钟"}:
            return None
        value = {"leftTeam": labels["左边球队"], "rightTeam": labels["右边球队"],
                 "leftScore": labels["左分"], "rightScore": labels["右分"],
                 "period": labels["节次"], "clock": labels["比赛时钟"]}
    if not isinstance(value, dict):
        return None
    period = value.get("period")
    if isinstance(period, str):
        match = re.fullmatch(r"\s*(\d{1,2})(?:st|nd|rd|th|节)?\s*", period, re.I)
        period = int(match.group(1)) if match else None
    clock = value.get("clock", value.get("time"))
    normalized = {**value, "period": period, "clock": clock}
    for key in ("leftScore", "rightScore"):
        if isinstance(normalized.get(key), str) and re.fullmatch(r"\d{1,3}", normalized[key]):
            normalized[key] = int(normalized[key])
    for key in ("leftTeam", "rightTeam"):
        team = normalized.get(key)
        if isinstance(team, str):
            normalized[key] = NBA_NAME_ALIASES.get(team.strip(), team.strip().upper())
    valid = (type(period) is int and 1 <= period <= 20 and
             isinstance(clock, str) and re.fullmatch(r"\d{1,2}:\d{2}", clock) and
             int(clock.split(":")[1]) < 60 and
             all(type(normalized.get(key)) is int and 0 <= normalized[key] <= 500 for key in ("leftScore", "rightScore")) and
             all(isinstance(normalized.get(key), str) and re.fullmatch(r"[A-Za-z]{2,5}", normalized[key]) for key in ("leftTeam", "rightTeam")))
    return {key: normalized[key] for key in ("period", "clock", "leftScore", "rightScore", "leftTeam", "rightTeam")} if valid else None


def _clock_seconds(clock):
    minutes, seconds = clock.split(":")
    return int(minutes) * 60 + int(seconds)


def _canonical_score(reading, source):
    if not reading or not all(key in source for key in ("awayTeamId", "homeTeamId")):
        return None
    left, right = reading["leftTeam"].upper(), reading["rightTeam"].upper()
    away, home = source["awayTeamId"].upper(), source["homeTeamId"].upper()
    if (left, right) == (away, home):
        return reading["leftScore"], reading["rightScore"]
    if (left, right) == (home, away):
        return reading["rightScore"], reading["leftScore"]
    return None


def _matched_pbp(project, before, after):
    pbp = project["context"].get("playByPlay")
    if not pbp or not before or not after or before["period"] != after["period"]:
        return None
    source = pbp["source"]
    old_score, new_score = _canonical_score(before, source), _canonical_score(after, source)
    if old_score is None or new_score is None:
        return None
    start_clock, end_clock = _clock_seconds(before["clock"]), _clock_seconds(after["clock"])
    if not 0 <= start_clock - end_clock <= 15:
        return None  # edits, replays, and large gaps have no safe clock mapping
    if old_score == new_score or any(a > b or b - a > 3 for a, b in zip(old_score, new_score)):
        return None
    matches = [entry for entry in pbp["entries"] if entry["period"] == before["period"] and
               end_clock <= _clock_seconds(entry["clock"]) <= start_clock and
               (entry["awayScore"], entry["homeScore"]) == new_score and
               re.search(r"\b(makes|made|scores)\b", entry["text"], re.I)]
    return matches[0] if len(matches) == 1 else None


def execute_vision(service, project, job, options):
    require(options.get("providerId") == "stepfun-vision", "provider_not_configured", "StepFun 视频提供者无效。", 503)
    strategy = options.get("strategy", "video-first")
    require(strategy in ("video-first", "frames-first"), "unsupported_modality", "StepFun 分析策略无效。", 422)
    if strategy == "frames-first":
        return _execute_frames(service, project, job, options)
    model = model_for("vision")
    scope = options.get("scope") or {"start": 0, "end": project["media"]["duration"]}
    require(isinstance(scope, dict) and finite(scope.get("start")) and finite(scope.get("end")) and
            0 <= scope["start"] < scope["end"] <= project["media"]["duration"], "invalid_request", "视频分析范围无效。", 422)
    require(scope["end"] - scope["start"] <= 48, "unsupported_modality", "一次视频分析最多48秒。", 422)
    video = _video_bytes(service.media_path(project), scope)
    deadline = time.monotonic() + 180
    video_input = {"sha256": hashlib.sha256(video).hexdigest(), "bytes": len(video), "sourceSha256": project["media"]["sha256"],
                   "sourceStart": scope["start"], "sourceEnd": scope["end"], "samplingFps": 10,
                   "mapping": "approximate source PTS = video presentation seconds + sourceStart; exact events require source-frame confirmation"}
    roster = [{"id": p["id"], "name": p["name"], "teamId": p["teamId"], "jersey": p.get("jersey"), "validOn": p.get("validOn")} for p in project["context"]["roster"]]
    background_prompt, background_audit = _background(project)
    prompt = ("请直接观看这段有连续运动的篮球转播视频，先辨认球衣/球队线索、持球和防守关系，再找最值得解说的出手、篮下动作和结果。"
              "视频派生片0秒约对应源PTS " + str(scope["start"]) + "秒；时间只是候选窗，不能声称帧级精度。"
              "注意转播可能插入回放：根据比分牌比赛时钟和画面识别回放，重复镜头不能计为新的得分。"
              + RESULT_EVIDENCE_RULE +
              "优先选关键事件及其可见结果，不要把普通推进挤占有限名额；投篮与结果若分别可见，应分别列出。"
              "这是未经验证的素材，可能是示意图；没有真实球员、球和动作就返回空候选。"
              "只返回JSON {\"observations\":[{\"type\":\"pass|shot|catch|movement|screen|result|other\",\"start\":源PTS秒,\"end\":源PTS秒,\"anchorTime\":源PTS秒或null,\"description\":\"可见动作和不确定的战术影响\"}]}，最多6条，覆盖不同动作和结果。"
              "不要编造比分、命中、球员身份或官方高级指标。名单仅可作候选，不是视觉证明：" + json.dumps(roster, ensure_ascii=False, separators=(",", ":")))
    started = now()
    video_content = [
        {"type": "video_url", "video_url": {"url": "data:video/mp4;base64," + base64.b64encode(video).decode("ascii")}},
        {"type": "text", "text": prompt}]
    for video_attempt in (1, 2):
        try:
            raw_video, video_usage, actual_model = _chat("vision", video_content, max_tokens=6000,
                                                          timeout=min(60, max(10, int(deadline - time.monotonic()))))
            break
        except BroadcastError as exc:
            if video_attempt == 2 or not exc.retryable or time.monotonic() >= deadline - 75:
                raise
            if hasattr(service.store, "project_dir") and hasattr(service.store, "atomic") and isinstance(job.get("id"), str):
                service.store.atomic(service.store.project_dir(project["id"]) / "jobs" / job["id"] / "video-retry.json",
                                     {"attempt": video_attempt, "code": exc.code, "retryable": True,
                                      "videoSha256": video_input["sha256"]})
    if hasattr(service.store, "project_dir") and hasattr(service.store, "atomic") and isinstance(job.get("id"), str):
        service.store.atomic(service.store.project_dir(project["id"]) / "jobs" / job["id"] / "video-proposal.json",
                             {"rawProposal": raw_video, "promptHash": hash_json(prompt), "videoInput": video_input,
                              "background": background_audit, "usage": video_usage, "proposalOnly": True})
    preliminary, _ = _extract_json({"output": {"message": {"content": [{"text": raw_video}]}}})
    candidate_revisions = []
    candidates = _candidate_windows(preliminary, scope, candidate_revisions)
    run_id = uid()
    available = {}
    scoreboard_evidence = []
    corroborated = []
    corroborated_ids = []
    if project["context"].get("playByPlay"):
        sample_times = [round(scope["start"] + 4 * i, 3) for i in range(13) if scope["start"] + 4 * i < scope["end"]]
        last_time = round(min(scope["end"] - .04, project["media"]["duration"] - .04), 3)
        if sample_times and last_time > sample_times[-1] + .5:
            sample_times.append(last_time)
        samples = service.frames(project["id"], project["revision"], sample_times)["frames"]
        available.update({frame["id"]: frame for frame in samples})
        readings = [None] * len(samples)
        audits = [None] * len(samples)
        for index, frame in enumerate(samples):
            if time.monotonic() >= deadline - 20:
                break
            score, audit = _read_scoreboard(service, frame)
            audit["actualTime"] = frame["actualTime"]
            audit["sha256"] = frame["sha256"]
            audits[index], readings[index] = audit, score
            if hasattr(service.store, "project_dir") and hasattr(service.store, "atomic"):
                service.store.atomic(service.store.project_dir(project["id"]) / "jobs" / job["id"] / "scoreboard-progress.json",
                                     {"readings": [item for item in audits if item is not None], "proposalOnly": True})
        scoreboard_evidence = [item for item in audits if item is not None]
        for index in range(len(readings) - 1):
            before, after = readings[index:index + 2]
            matched = _matched_pbp(project, before, after)
            if matched is None or matched["id"] in corroborated_ids:
                continue
            first_frame, last_frame = samples[index:index + 2]
            if first_frame["actualTime"] >= last_frame["actualTime"]:
                continue
            player_ids = [player["id"] for player in project["context"]["roster"] if
                          re.search(r"(?<![A-Za-z])" + re.escape(player["name"]) + r"(?![A-Za-z])", matched["text"], re.I)]
            source_name = project["context"]["playByPlay"]["source"]["provider"]
            before_score = _canonical_score(before, project["context"]["playByPlay"]["source"])
            after_score = _canonical_score(after, project["context"]["playByPlay"]["source"])
            description = (f"{source_name}同场逐回合记录：{matched['text']}。视频比分牌在本时间窗从"
                           f"{before_score[0]}–{before_score[1]}变为{after_score[0]}–{after_score[1]}（客–主）；"
                           "事件与姓名由比赛记录交叉核对，仍需人工确认画面对应。")
            corroborated.append({"type": "result", "start": first_frame["actualTime"], "end": last_frame["actualTime"],
                                 "anchorTime": last_frame["actualTime"], "segmentId": "segment-scoreboard",
                                 "description": description[:800], "playerIds": player_ids, "unknownActors": [],
                                 "frameIds": [first_frame["id"], last_frame["id"]], "confidence": .65})
            corroborated_ids.append(matched["id"])
    scene_cuts = _scene_cuts(service.media_path(project))
    if scene_cuts is not None:
        continuous = []
        for row in candidates:
            crossing = [cut for cut in scene_cuts if row["start"] + .04 < cut < row["end"] - .04]
            if crossing:
                candidate_revisions.append({"reason": "crosses_scene_cut", "cutTimes": crossing, "candidate": row})
            else:
                continuous.append(row)
        candidates = continuous
    priority = {"result": 0, "shot": 1, "pass": 2, "screen": 3, "catch": 4, "movement": 5, "other": 6}
    candidates = [row for row in sorted(candidates, key=lambda row: (priority.get(row.get("type"), 7), row["start"]))
                  if not any(row["start"] < confirmed["end"] and confirmed["start"] < row["end"] for confirmed in corroborated)]
    candidates = candidates[:min(3, max(0, 6 - len(corroborated)))]
    def safe_window(row):
        lower, upper = scope["start"], scope["end"]
        if scene_cuts is not None:
            before = [cut for cut in scene_cuts if cut <= row["start"] + .04]
            after = [cut for cut in scene_cuts if cut >= row["end"] - .04]
            if before:
                lower = max(lower, before[-1] + .04)
            if after:
                upper = min(upper, after[0] - .04)
        return lower, upper

    candidates = [row for row in candidates if safe_window(row)[0] < row["end"] and
                  safe_window(row)[1] > row["start"]]
    frames = []
    if candidates:
        times = []
        for row in candidates:
            lower, upper = safe_window(row)
            times.extend([max(lower, row["start"] - .8), min(upper, row["end"] + .8)])
        times = [round(t, 3) for t in times]
        frames = service.frames(project["id"], project["revision"], times)["frames"]
    available.update({frame["id"]: frame for frame in frames})
    final_rows = list(corroborated)
    evidence_raw = []
    evidence_usage = []
    evidence_prompt_hashes = []
    evidence_clips = []
    evidence_attempts = []
    if frames:
        for index, candidate in enumerate(candidates):
            if time.monotonic() >= deadline - 20:
                candidate_revisions.append({"reason": "deadline_before_evidence_clip", "candidate": candidate})
                break
            pair = frames[index * 2:index * 2 + 2]
            lower, upper = safe_window(candidate)
            clip_scope = {"start": max(lower, candidate["start"] - 1),
                          "end": min(upper, candidate["end"] + 1)}
            if clip_scope["end"] - clip_scope["start"] > 12:
                middle = (candidate["start"] + candidate["end"]) / 2
                clip_scope = {"start": max(scope["start"], middle - 6), "end": min(scope["end"], middle + 6)}
            evidence_video = _video_bytes(service.media_path(project), clip_scope)
            evidence_clips.append({"sourceStart": clip_scope["start"], "sourceEnd": clip_scope["end"],
                                   "sha256": hashlib.sha256(evidence_video).hexdigest(), "bytes": len(evidence_video)})
            evidence_prompt = ("独立核对这段连续篮球视频和两张原片PTS证据帧。短片0秒约对应源PTS " + str(clip_scope["start"]) + "秒。"
                               "以下第一轮候选可能完全错误；请重新辨别球队、动作、球是否入筐、比分变化及回放，不可照抄候选。"
                               "只在球衣颜色和可辨号码与当场名单相符时给球员ID，否则保留未知角色。playerIds只允许名单给定的ID；名单为空必须为[]，不要填球衣号或自造未知ID。"
                               + RESULT_EVIDENCE_RULE + "战术影响仅作有依据的定性候选。"
                               "只输出JSON {\"observations\":[{\"type\":\"pass|shot|catch|movement|screen|result|other\",\"start\":源PTS秒,\"end\":源PTS秒,\"anchorTime\":所引真实帧PTS或null,\"segmentId\":\"segment-1\",\"description\":\"事实与不确定性\",\"playerIds\":[],\"unknownActors\":[],\"frameIds\":[],\"confidence\":0到1或null}]}，最多1条。"
                               "观察时间窗须覆盖所引帧，必须引用下面的真实frameId；证据不足返回空数组。"
                               "待复核假设=" + json.dumps(candidate, ensure_ascii=False, separators=(",", ":")) +
                               "；当场名单=" + json.dumps(roster, ensure_ascii=False, separators=(",", ":")))
            evidence_prompt_hashes.append(hash_json(evidence_prompt))
            content = [{"type": "video_url", "video_url": {"url": "data:video/mp4;base64," + base64.b64encode(evidence_video).decode("ascii")}},
                       {"type": "text", "text": evidence_prompt}]
            for frame in pair:
                content.append({"type": "text", "text": f"frameId={frame['id']}，源PTS={frame['actualTime']:.6f}秒，PNG源hash={frame['sha256']}。"})
                content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(_jpeg(service.store.find("frames", frame["id"]) / "frame.png")).decode("ascii")}})
            try:
                for attempt in (1, 2):
                    try:
                        raw, usage, _ = _chat("vision", content, max_tokens=4000 if attempt == 1 else 6000,
                                              timeout=min(45, max(10, int(deadline - time.monotonic()))))
                        evidence_attempts.append({"clipSha256": evidence_clips[-1]["sha256"], "attempts": attempt, "outcome": "completed"})
                        break
                    except BroadcastError as exc:
                        if attempt == 2 or not exc.retryable or time.monotonic() >= deadline - 30:
                            raise
                parsed, _ = _extract_json({"output": {"message": {"content": [{"text": raw}]}}})
                require(len(parsed["observations"]) <= 1, "schema_invalid", "短片复核最多返回1条观察。", 422)
                require(all(set(item.get("frameIds", [])) <= {f["id"] for f in pair} for item in parsed["observations"]),
                        "schema_invalid", "短片模型引用了其他候选窗的帧。", 422)
                final_rows.extend(parsed["observations"])
                evidence_raw.append(raw)
                evidence_usage.append(usage)
            except BroadcastError as exc:
                message = str(exc)
                classification = ("output_limit" if "finishReason=length" in message else
                                  "network_or_timeout" if "请求失败" in message else
                                  "upstream_http" if message.startswith("StepFun HTTP ") else "response_or_validation")
                evidence_attempts.append({"clipSha256": evidence_clips[-1]["sha256"], "attempts": attempt,
                                          "outcome": "failed", "code": exc.code, "class": classification})
                candidate_revisions.append({"reason": "evidence_clip_failed", "code": exc.code,
                                            "retryable": exc.retryable, "class": classification, "candidate": candidate})
    grounded_rows = []
    for item in final_rows:
        refs = item.get("frameIds", [])
        if not isinstance(refs, list) or not refs or any(ref not in available for ref in refs):
            candidate_revisions.append({"reason": "missing_source_frame", "candidate": item})
            continue
        if not finite(item.get("start")) or not finite(item.get("end")):
            candidate_revisions.append({"reason": "invalid_final_time", "candidate": item})
            continue
        times = [available[ref]["actualTime"] for ref in refs]
        start, end = min(item["start"], *times), max(item["end"], *times)
        if (start < scope["start"] or end > scope["end"] or start >= end or
                max(item["start"] - start, end - item["end"]) > 1.2):
            candidate_revisions.append({"reason": "final_time_conflicts_with_frame", "candidate": item})
            continue
        corrected = {**item, "start": start, "end": end}
        if start != item["start"] or end != item["end"]:
            candidate_revisions.append({"reason": "window_extended_to_cited_frame", "before": [item["start"], item["end"]], "after": [start, end]})
        if corrected.get("anchorTime") is not None and not any(abs(corrected["anchorTime"] - t) <= .04 for t in times):
            candidate_revisions.append({"reason": "anchor_snapped_to_cited_frame", "before": corrected["anchorTime"], "after": times[0]})
            corrected["anchorTime"] = times[0]
        grounded_rows.append(corrected)
    normalized_raw = json.dumps({"observations": grounded_rows}, ensure_ascii=False, separators=(",", ":"))
    rows = _normalize({"observations": grounded_rows}, project, scope, run_id, "video-model", available, max_rows=6)
    pbp_by_frames = {tuple(row["frameIds"]): record_id for row, record_id in zip(corroborated, corroborated_ids)}
    for row in rows:
        record_id = pbp_by_frames.get(tuple(row["frameIds"]))
        if record_id is not None:
            row["source"]["recordId"] = record_id
    require(all(row["frameIds"] for row in rows), "schema_invalid", "视频候选须经过真实源帧取证。", 422)
    require(all(row["anchorTime"] is None or any(abs(row["anchorTime"] - available[fid]["actualTime"]) <= .04 for fid in row["frameIds"]) for row in rows), "schema_invalid", "模型锚点必须来自所引真实源帧。", 422)
    fingerprint = [{"id": f["id"], "actualTime": f["actualTime"], "sha256": f["sha256"]} for f in available.values()]
    return {"schema": "courtlens-observations/1", "mediaSha256": project["media"]["sha256"],
            "providerRun": {"id": run_id, "provider": "stepfun-step-plan", "modelId": actual_model, "mode": "video-model",
                            "requestHash": hash_json({"model": model, "scope": scope, "mediaSha256": project["media"]["sha256"], "videoInput": video_input, "frames": fingerprint, "videoPromptHash": hash_json(prompt), "evidencePromptHashes": evidence_prompt_hashes, "background": background_audit, "maxTokens": MAX_TOKENS, "reasoningEffort": REASONING_EFFORT}),
                            "responseHash": hashlib.sha256((raw_video + ''.join(evidence_raw) + json.dumps(scoreboard_evidence, ensure_ascii=False, separators=(",", ":"))).encode()).hexdigest(), "startedAt": started, "completedAt": now()},
            "observations": rows, "rawProposal": normalized_raw, "rawVideoProposal": raw_video,
            "rawEvidenceProposals": evidence_raw, "videoPromptHash": hash_json(prompt), "evidencePromptHashes": evidence_prompt_hashes,
            "videoInput": video_input, "videoAttempts": video_attempt, "sceneCuts": scene_cuts,
            "evidenceClips": evidence_clips, "evidenceAttempts": evidence_attempts,
            "background": background_audit, "frameFingerprints": fingerprint,
            "scoreboardEvidence": scoreboard_evidence, "matchedPlayIds": corroborated_ids, "candidateRevisions": candidate_revisions,
            "usage": [video_usage, *(item.get("usage", {}) for item in scoreboard_evidence), *evidence_usage],
            "strategy": "video-first", "scope": scope, "proposalOnly": True}


def propose_story(project, audience, frame_times, commentary_style=None, audit_sink=None, language=None):
    from .story_model import story_prompt
    prompt = story_prompt(project, audience, frame_times, commentary_style, language)
    model = model_for("story")
    started = now()
    last_error = None
    for attempt in range(2):
        content = [{"type": "text", "text": prompt if attempt == 0 else prompt + "\n上一份候选未通过服务端证据校验：" + str(last_error)[:300] + "。请只返回修正的JSON。"}]
        raw, usage, actual_model = _chat("story", content)
        try:
            result = normalize_proposal(project, audience, raw, frame_times, commentary_style, language)
            audit = {"provider": "stepfun-step-plan", "modelId": actual_model, "requestHash": hash_json({"model": model, "prompt": prompt, "maxTokens": MAX_TOKENS, "temperature": .1, "reasoningEffort": REASONING_EFFORT}), "responseHash": hashlib.sha256(raw.encode()).hexdigest(), "startedAt": started, "completedAt": now(), "attempts": attempt + 1, "usage": usage, "proposalOnly": True}
            return result, audit
        except BroadcastError as exc:
            last_error = exc
            if audit_sink:
                audit_sink({"provider": "stepfun-step-plan", "modelId": actual_model, "attempt": attempt + 1, "responseHash": hashlib.sha256(raw.encode()).hexdigest(), "rawProposal": raw[:20000], "validationError": str(exc)[:500], "at": now()})
    raise BroadcastError("schema_invalid", "StepFun 故事提议两次未通过证据校验：" + str(last_error)[:300], 422)
