"""Pinned, original commentary profiles; style never changes evidence rules."""
import json
from functools import lru_cache
from pathlib import Path

from .common import require

STYLE_FILE = Path(__file__).resolve().parents[2] / "data" / "commentary-styles.v1.json"
DEFAULT_STYLE = "zh-analysis"


@lru_cache(maxsize=1)
def profiles():
    source = json.loads(STYLE_FILE.read_text(encoding="utf-8"))
    require(source.get("schema") == "courtlens-commentary-styles/1", "schema_invalid", "解说风格配置无效。", 503)
    rows = {row["id"]: row for row in source["profiles"]}
    require(set(rows) == {"zh-analysis", "en-live", "yue-live"}, "schema_invalid", "解说风格集合无效。", 503)
    return rows


def resolve_style(value=None):
    style_id = DEFAULT_STYLE if value is None else value
    require(isinstance(style_id, str) and style_id in profiles(), "invalid_request", "解说风格无效。")
    return profiles()[style_id]


def capability_styles():
    """Only silent captions are language-neutral; no English/Cantonese TTS claim."""
    return [{"id": row["id"], "label": row["label"], "language": row["language"],
             "voiceHint": "普通话 Zhiyu 可选；实际合成需先验证。" if row["id"] == DEFAULT_STYLE else "此语言尚无已验证配音；请选择字幕版。"}
            for row in profiles().values()]
