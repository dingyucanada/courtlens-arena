"""Pinned, original commentary profiles; style never changes evidence rules."""
import json
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

from .common import BroadcastError, require

STYLE_FILE = Path(__file__).resolve().parents[2] / "data" / "commentary-styles.v1.json"
DEFAULT_STYLE = "zh-analysis"


@lru_cache(maxsize=1)
def profiles():
    source = json.loads(STYLE_FILE.read_text(encoding="utf-8"))
    require(source.get("schema") == "courtlens-commentary-styles/1", "schema_invalid", "解说风格配置无效。", 503)
    rows = {row["id"]: row for row in source["profiles"]}
    require(set(rows) == {"zh-analysis", "en-live", "yue-live"}, "schema_invalid", "解说风格集合无效。", 503)
    return rows


def options():
    source = json.loads(STYLE_FILE.read_text(encoding="utf-8"))
    return source["languages"], source["styles"]


def resolve_style(value=None, language=None):
    style_id = DEFAULT_STYLE if value is None else value
    require(isinstance(style_id, str), "invalid_request", "解说风格无效。")
    languages, styles = options()
    legacy = profiles().get(style_id) if isinstance(style_id, str) else None
    canonical = {"zh-analysis": "analysis", "en-live": "energetic", "yue-live": "energetic"}.get(style_id, style_id)
    style = next((row for row in styles if row["id"] == canonical), None)
    require(style is not None, "invalid_request", "解说风格无效。")
    language = (legacy["language"] if legacy else "zh-CN") if language is None else language
    locale = next((row for row in languages if row["id"] == language), None)
    require(locale is not None, "invalid_request", "解说语言无效。")
    return {"id": style_id, "style": canonical, "language": language,
            "label": style["label"], "instruction": locale["instruction"] + style["instruction"],
            "wordsPerSecondGuide": locale["wordsPerSecondGuide"]}


def capability_options(cloud_modes=None):
    languages, styles = options()
    legacy = {row["language"]: row for row in capability_styles(cloud_modes)}
    return {"commentaryLanguages": [{"id": row["id"], "label": row["label"],
            "voiceModes": legacy[row["id"]]["voiceModes"], "voiceHint": legacy[row["id"]]["voiceHint"],
            "verified": False} for row in languages],
            "commentaryStyleOptions": [{"id": row["id"], "label": row["label"]} for row in styles]}


def capability_styles(cloud_modes=None):
    """List eligible routes; a configured route is not an audio quality verdict."""
    from .providers.voice import LOCAL_VOICES, configured_voice
    local_voices = ""
    if cloud_modes is None:
        say = shutil.which("say")
        if say:
            try:
                local_voices = subprocess.run([say, "-v", "?"], capture_output=True, timeout=3, check=True).stdout.decode("utf-8", "replace")
            except (OSError, subprocess.SubprocessError):
                pass
    result = []
    for row in profiles().values():
        language = row["language"]
        modes = ["silent"]
        for mode in ("local-tts", "minimax", "stepfun", "polly"):
            if cloud_modes is not None:
                if mode not in cloud_modes or language != "zh-CN":
                    continue
            elif mode == "local-tts":
                voice, locale = LOCAL_VOICES[language]
                if not any(line.split()[:1] == [voice] and locale in line for line in local_voices.splitlines()):
                    continue
            try:
                configured_voice(mode, language=language) if cloud_modes is None else None
            except BroadcastError:
                continue
            modes.append(mode)
        hint = "已配置可尝试的声道；自然度与语言发音仍需逐段试听。" if len(modes) > 1 else "此语言目前仅可发布字幕版。"
        result.append({"id": row["id"], "label": row["label"], "language": language, "voiceModes": modes, "voiceHint": hint})
    return result
