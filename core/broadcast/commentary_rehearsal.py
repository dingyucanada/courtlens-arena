"""Read-only offline authoring advice; generated audio remains the acceptance gate.

``analyze(project, manifest=release_manifest)`` returns JSON-safe advisory rows.
It never synthesizes audio, calls a network service, changes a reviewed story,
or grades voice naturalness. A story alone (plus optional roster) is also valid.
Metric replacement requires the existing bundle/story validators and a declared
official source; a source declaration is not independent authentication.
"""
import hashlib
import json
import math
import re
from pathlib import Path

from .common import BroadcastError
from .providers.voice import MAX_TEMPO

GLOSSARY_FILE = Path(__file__).resolve().parents[2] / "data" / "broadcast-pronunciation.v1.json"
RATES = {"zh-CN": (3.0, 2.5), "en-US": (3.0, 2.5), "yue-HK": (3.0, 2.5)}
PLACEHOLDER = re.compile(r"\{\{metric:([^{}]+)\}\}")
CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0002fa1f]")
WORDS = re.compile(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*")
NUMBERS = re.compile(r"(?<![A-Za-z\d])[+-]?\d+(?:[.,]\d+)*(?:%|％)?")


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _hash(value):
    # Invalid input can contain NaN; hash it without ever returning NaN in JSON.
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _issue(rows, code, message, beat_id=None, severity="warning"):
    rows.append({"code": code, "severity": severity, "message": message, "beatId": beat_id})


def count_text(text):
    """Count speech text units, not model tokens; unresolved placeholders are zero.

    Han characters and Latin words are reported separately for all three locales,
    so an English sentence does not get a Chinese character-count pace test.
    Numeric tokens have a separate, deliberately approximate speaking allowance.
    """
    unresolved = PLACEHOLDER.findall(text)
    clean = PLACEHOLDER.sub("", text)
    malformed = bool("{{" in clean or "}}" in clean)
    if malformed:
        clean = re.sub(r"\{\{.*?(?:\}\}|$)", "", clean)
    numbers = NUMBERS.findall(clean)
    words = WORDS.findall(NUMBERS.sub("", clean))
    return {"cjkCharacters": len(CJK.findall(clean)), "latinWords": len(words),
            "numericTokens": len(numbers), "numericCharacters": sum(sum(c.isdigit() for c in n) for n in numbers),
            "punctuation": len(re.findall(r"[，,。.!！?？;；:：]", NUMBERS.sub("", clean))),
            "unresolvedMetrics": len(unresolved), "malformedPlaceholder": malformed,
            "basis": "text-unit-count-not-model-tokenization"}


def _metric_phrases(project, story, issues):
    """Use publication validation before substituting any official numbers."""
    if not any(PLACEHOLDER.search(str(b.get("text", ""))) for b in story.get("beats", []) if isinstance(b, dict)):
        return {}
    if not isinstance(project.get("metrics"), dict):
        return {}
    try:
        from .validation import metric_bundle, story as validate_story
        metric_bundle(project["metrics"])
        validate_story(project)
    except (BroadcastError, KeyError, TypeError, ValueError, AttributeError):
        _issue(issues, "metric_validation_failed", "指标或故事未通过已有发布校验；占位符不按真实数字计数。")
        return {}
    bundle = project["metrics"]
    dictionary = bundle["dictionary"]
    phrases = {}
    for record in bundle["records"]:
        entry = dictionary["metrics"][record["metricId"]]
        provenance = record.get("provenance") or entry.get("provenance") or bundle.get("provenance") or dictionary.get("provenance", {})
        if provenance.get("kind") not in ("official", "official-provided") or not _finite(record.get("value")):
            continue
        value, unit = record["value"], entry["unit"]
        display = f"{value * 100:.1f}%" if unit == "probability" else f"{value:.1f}%" if unit == "percent" else f"{value:g} {unit}"
        phrases[record["id"]] = {"recordId": record["id"], "display": display,
                                   "unit": unit, "source": provenance.get("source"),
                                   "validation": "bundle-and-story-validated-source-declared-official",
                                   "sourceAuthenticated": False}
    return phrases


def _contains(text, alias):
    if re.search(r"[A-Za-z]", alias):
        return bool(re.search(r"(?<![A-Za-z])" + re.escape(alias) + r"(?![A-Za-z])", text, re.I))
    return alias in text


def _pronunciations(project, beat, text, roster, language, issues):
    observed = {pid for o in project.get("observations", []) if isinstance(o, dict)
                and o.get("id") in beat.get("observationIds", [])
                and (o.get("review") or {}).get("status") == "accepted"
                for pid in o.get("playerIds", [])}
    result = []
    for player in roster:
        if not isinstance(player, dict):
            continue
        name = player.get("name")
        if not isinstance(name, str) or not name or not (player.get("id") in observed or _contains(text, name)):
            continue
        pronunciation = player.get("pronunciation") or {}
        known = (isinstance(pronunciation, dict) and pronunciation.get("reviewed") is True
                 and isinstance(pronunciation.get("sourceRef"), str) and bool(pronunciation["sourceRef"].strip())
                 and isinstance(pronunciation.get(language), str) and bool(pronunciation[language].strip()))
        result.append({"playerId": player.get("id"), "name": name,
                       "status": "reviewed-roster-guide" if known else "unknown",
                       "readingAid": pronunciation[language] if known else None,
                       "sourceRef": pronunciation["sourceRef"] if known else player.get("source"),
                       "listenRequired": True})
        if not known:
            _issue(issues, "player_pronunciation_unknown", f"{name} 缺少此语言的已复核发音；先核对当场名单，再试听姓名。", beat.get("id"))
    return result


def _measured(manifest, voice, beat_id, cue, story_hash, language, issues, spoken, has_metric, media_sha):
    if not voice:
        return None
    records = [r for r in voice.get("cues", []) if isinstance(r, dict) and r.get("beatId") == beat_id]
    if len(records) != 1:
        _issue(issues, "measured_cue_missing_or_duplicate", "实测音频缺少唯一对应句；需要重新生成或检查 Manifest。", beat_id)
        return None
    row = records[0]
    duration, tempo = row.get("speechDuration"), row.get("tempo")
    compiled = [r for r in manifest.get("compiledBeats", []) if isinstance(r, dict) and r.get("beatId") == beat_id]
    text_matches = (len(compiled) == 1 and compiled[0].get("compiledText") == spoken) if has_metric or compiled else True
    media_matches = ((manifest.get("source") or {}).get("mediaSha256") == media_sha) if media_sha else None
    matches = (isinstance(manifest.get("story"), dict) and _hash(manifest["story"]) == story_hash
               and voice.get("language") == language and text_matches and media_matches is not False)
    valid = (_finite(duration) and duration > 0 and _finite(tempo) and tempo >= 1
             and _finite(row.get("outputStart")))
    aligned = valid and cue["valid"] and cue["availableSeconds"] > .1 and abs(row["outputStart"] - cue["outputStart"]) <= .001
    fits = bool(aligned and duration <= cue["sourceEnd"] - cue["sourceStart"] - .01 + 1e-6)
    tail = row.get("tailTruncated") if isinstance(row.get("tailTruncated"), bool) else None
    if not matches:
        _issue(issues, "measured_story_mismatch", "音频报告与当前故事、指标展开文稿或语言不一致；不能作为当前文稿验收。", beat_id)
    if not valid:
        _issue(issues, "measured_audio_invalid", "音频实测时长、语速或开始时间无效。", beat_id)
    elif not fits:
        _issue(issues, "measured_cue_overflow", "已生成音频超过对应窗口或起点不匹配；需缩句并重新生成。", beat_id)
    if _finite(tempo) and tempo > MAX_TEMPO:
        _issue(issues, "measured_tempo_excessive", "已生成音频语速超过 1.15 倍上限；需缩句并重新生成。", beat_id)
    if tail is not False:
        _issue(issues, "measured_tail_truncated_or_unknown", "音频句尾被截断或报告未明确保证完整句尾。", beat_id)
    return {"basis": "manifest-measurement", "source": "provided-manifest-voiceReport",
            "speechDuration": duration if _finite(duration) else None, "tempo": tempo if _finite(tempo) else None,
            "cueFits": fits, "tailTruncated": tail, "reportMatchesStory": matches, "compiledTextMatches": text_matches,
            "mediaMatches": media_matches,
            "timingAccepted": bool(matches and fits and valid and tempo <= MAX_TEMPO and tail is False),
            "naturalnessValidated": False}


def analyze(project, *, manifest=None, roster=None):
    """Return advice without changing review state. No external transmission.

    ``beats[].estimate`` is always heuristic, even when a measured manifest is
    present. ``beats[].measuredAudio`` describes that separate manifest report.
    Consumers should show issues and require real rendering/listening to accept.
    """
    if not isinstance(project, dict):
        raise ValueError("Expected a project or story JSON object.")
    story = project.get("story") if "story" in project else project
    story = story if isinstance(story, dict) else {}
    issues = []
    language = story.get("language") or {"en-live": "en-US", "yue-live": "yue-HK"}.get(story.get("commentaryStyle"), "zh-CN")
    language_ok = language in RATES
    if not language_ok:
        _issue(issues, "unsupported_language", "仅提供普通话、英语和粤语的离线彩排建议。", severity="error")
    roster = roster if roster is not None else (project.get("context") or {}).get("roster", [])
    if not isinstance(roster, list):
        roster = []
    beats = story.get("beats", [])
    if not isinstance(beats, list):
        beats = []
    if not beats:
        _issue(issues, "story_missing", "先建立至少一句解说，再进行彩排。", severity="error")
    source_range = story.get("sourceRange") or {}
    range_start, range_end = source_range.get("start"), source_range.get("end")
    media_duration = (project.get("media") or {}).get("duration")
    range_ok = (_finite(range_start) and _finite(range_end) and 0 <= range_start < range_end
                and (media_duration is None or _finite(media_duration) and range_end <= media_duration))
    if not range_ok:
        _issue(issues, "source_range_invalid", "剪辑范围须为有限且递增的非负时间。", severity="error")
    story_hash = _hash(story)
    phrases = _metric_phrases(project, story, issues)
    glossary = json.loads(GLOSSARY_FILE.read_text(encoding="utf-8"))
    manifest = manifest if isinstance(manifest, dict) else {}
    voice = manifest.get("voiceReport")
    voice = voice if isinstance(voice, dict) and isinstance(voice.get("cues"), list) else None
    if manifest and not voice:
        _issue(issues, "measured_audio_missing", "Manifest 没有逐句实测音频报告；本次仍只有文字估算。")
    rows, intervals, seen = [], [], set()
    for index, beat in enumerate(beats):
        if not isinstance(beat, dict):
            _issue(issues, "beat_invalid", "解说节点须为对象。", severity="error")
            continue
        bid = beat.get("id") or beat.get("beatId") or f"beat-{index + 1}"
        duplicate = bid in seen
        seen.add(bid)
        if duplicate:
            _issue(issues, "duplicate_beat_id", "解说节点 ID 重复，不能唯一对应音频。", bid, "error")
        start, end = beat.get("sourceStart"), beat.get("sourceEnd")
        valid = (range_ok and _finite(start) and _finite(end) and range_start <= start < end <= range_end and not duplicate)
        if valid and any(start < old_end and end > old_start for old_start, old_end in intervals):
            valid = False
            _issue(issues, "cue_overlap", "解说窗口重叠；需在故事编辑中调整并重新审核。", bid, "error")
        if _finite(start) and _finite(end) and start < end:
            intervals.append((start, end))
        if not valid:
            _issue(issues, "cue_invalid", "解说窗口须在剪辑范围内、有限且不重叠。", bid, "error")
        available = max(0, end - start - .08) if valid else None
        if valid and available <= .1:
            _issue(issues, "cue_too_short", "配音窗口不足 0.1 秒加句尾余量；需调整故事时间。", bid, "error")
        cue = {"sourceStart": start if _finite(start) else None, "sourceEnd": end if _finite(end) else None,
               "outputStart": start - range_start if valid else None, "outputEnd": end - range_start if valid else None,
               "availableSeconds": round(available, 4) if available is not None else None, "valid": bool(valid)}
        text = beat.get("text", "")
        if not isinstance(text, str):
            text = ""
        metrics = []
        def substitute(match):
            record = phrases.get(match[1]) if beat.get("metricRecordId") == match[1] else None
            if record:
                metrics.append(dict(record))
                return record["display"]
            return match[0]
        spoken = PLACEHOLDER.sub(substitute, text)
        counts = count_text(spoken)
        if counts["unresolvedMetrics"] or counts["malformedPlaceholder"]:
            _issue(issues, "metric_placeholder_unresolved", "指标未验证或未绑定；占位符不按真实数字计数，时长估算不完整。", bid)
        if not text.strip():
            _issue(issues, "text_missing", "解说文字为空。", bid, "error")
        # Numeric wording varies by language and unit. This is an allowance, not
        # a pronunciation engine or measured TTS prediction.
        cjk_rate, word_rate = RATES.get(language, (3.0, 2.5))
        numeric_units = counts["numericCharacters"] + 2 * counts["numericTokens"]
        duration = (counts["cjkCharacters"] / cjk_rate + counts["latinWords"] / word_rate
                    + numeric_units / (word_rate if language == "en-US" else cjk_rate) + .18 * counts["punctuation"])
        complete = not counts["unresolvedMetrics"] and not counts["malformedPlaceholder"] and language_ok and bool(text.strip())
        tempo = max(1.0, duration / available) if valid and available > .1 else None
        fits = complete and tempo <= MAX_TEMPO if tempo is not None else None
        if tempo is not None and tempo > MAX_TEMPO:
            _issue(issues, "estimated_pacing_overflow", "文字估算超过 1.15 倍语速窗口；优先缩句或延长窗口，再重新审核和生成音频。", bid)
        terms = [{"id": e["id"], "terms": e["terms"], "readingAid": e["readingAids"].get(language),
                  "review": e["review"], "sourceRefs": [glossary["sourceRefs"][r] for r in e["sourceRefs"]]}
                 for e in glossary["entries"] if any(_contains(spoken, alias) for alias in e["aliases"])]
        pronunciations = _pronunciations(project, beat, spoken, roster, language, issues)
        rows.append({"beatId": bid, "cue": cue, "text": spoken, "counts": counts,
                     "estimate": {"basis": "heuristic-not-measured", "complete": complete, "durationSeconds": round(duration, 3),
                                  "requiredTempo": round(tempo, 3) if tempo is not None else None, "maxTempo": MAX_TEMPO,
                                  "fitsAtMaxTempo": fits, "cjkCharactersPerSecondGuide": cjk_rate,
                                  "latinWordsPerSecondGuide": word_rate},
                     "metrics": metrics, "glossary": terms, "pronunciations": pronunciations,
                     "measuredAudio": _measured(manifest, voice, bid, cue, story_hash, language, issues, spoken,
                                                 bool(PLACEHOLDER.search(text)), (project.get("media") or {}).get("sha256")) if not duplicate else None})
    return {"schema": "courtlens-commentary-rehearsal/1", "language": language,
            "storyHash": story_hash, "status": "needs-attention" if issues else "advisory-ready",
            "readOnly": True, "externalTransmission": False, "issues": issues, "beats": rows,
            "summary": {"beatCount": len(rows), "estimatedDurationSeconds": round(sum(r["estimate"]["durationSeconds"] for r in rows), 3),
                        "measuredCueCount": sum(r["measuredAudio"] is not None for r in rows),
                        "timingAccepted": bool(rows) and all(r["measuredAudio"] and r["measuredAudio"]["timingAccepted"] for r in rows),
                        "naturalnessValidated": False},
            "limitations": ["文字速度与数字读法仅为编辑启发式，未生成或测量新音频。", "实测项仅引用所提供 Manifest；本模块未解码音频或试听。",
                            "最终验收须按当前审核故事生成逐句音频，测量时长，保留完整句尾并试听姓名与术语。",
                            "粤语自然度须由能听懂粤语的人复核；术语提示不证明本回合战术成立。",
                            "官方来源标签是输入声明；通过结构和绑定校验不等于独立来源认证。",
                            "风格使用原创表达；不提供名人声音模仿或克隆。"]}
