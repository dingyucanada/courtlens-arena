"""Read-only, provider-neutral raw row mapping into the existing metrics-v2 contract.

This is a preparation tool, not an official Portal adapter or source certification.
Column names, provider definitions, units and clock anchors are supplied by the
operator. No numeric measurement, definition, availability time or identity is
inferred. JSON rows must be flat objects; CSV numeric cells are parsed literally.
"""
import copy
import csv
import io
import json
import re

from . import clock_alignment, validation
from .common import BroadcastError, canonical, digest, finite, hash_json, require, valid_id

MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_ROWS = 1000  # One full-source play; same per-play bound as the v2 adapter.
FIELDS = {"recordId", "metricId", "value", "eventId", "shotId", "playerId", "unit",
          "gameId", "teamId", "seasonId", "observedAt", "availableAt", "validFrom",
          "validTo", "period", "segmentId"}
TIMES = ("observedAt", "availableAt", "validFrom", "validTo")
NUMBER = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
LIMITATIONS = ["通用原始字段映射预览，不代表赛方 Portal 正式数据验收或来源认证。",
               "字典、单位、事件与球员身份须按原始资料核对；没有补造官方指标。",
               "空白可用时间保持 null，不能进入已确认指标绑定；映射不会自动审核或写入项目。",
               "比赛时钟仅使用指定镜头段的两个人工锚点；回放仍须核对原始事件 ID。"]


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON 重复字段：" + key)
        result[key] = value
    return result


def _json_float(value):
    parsed = float(value)
    if not finite(parsed):
        raise ValueError("非有限 JSON 数值：" + value)
    return parsed


def _parse(format, text):
    require(format in ("csv", "json"), "metric_source_invalid", "仅支持 CSV 或 JSON 原始行。", 422)
    require(isinstance(text, str), "metric_source_invalid", "原始文件须为 UTF-8 文本。", 422)
    try:
        encoded = text.encode("utf-8")
    except UnicodeError:
        raise BroadcastError("metric_source_invalid", "原始文件不是有效 UTF-8 文本。", 422)
    require(0 < len(encoded) <= MAX_SOURCE_BYTES, "metric_source_invalid", "原始文件须为 1 字节至 4 MiB。", 422)
    source_hash = digest(encoded)
    # BOM is a text encoding marker, not a source column. Hash retains its bytes.
    normalized = text.removeprefix("\ufeff")
    rows, columns = [], []
    try:
        if format == "json":
            raw = json.loads(normalized, object_pairs_hook=_pairs, parse_float=_json_float,
                             parse_constant=lambda value: (_ for _ in ()).throw(ValueError("非有限 JSON 数值：" + value)))
            if isinstance(raw, dict) and set(raw) == {"rows"}:
                raw = raw["rows"]
            require(isinstance(raw, list), "metric_source_invalid", "JSON 须为原始行数组或只有 rows 的对象。", 422)
            require(len(raw) <= MAX_ROWS, "metric_source_invalid", "单源片映射最多 1000 行；请明确分批导入。", 422)
            for number, row in enumerate(raw, 1):
                rows.append({"rowNumber": number, "rawRow": row,
                             "parseError": None if isinstance(row, dict) else "JSON 每行须为字段对象。"})
                if isinstance(row, dict):
                    columns.extend(key for key in row if key not in columns)
        else:
            reader = csv.reader(io.StringIO(normalized, newline=""), strict=True)
            header = next(reader, None)
            require(isinstance(header, list) and header and all(key.strip() for key in header),
                    "metric_source_invalid", "CSV 须有非空列名。", 422)
            require(len(set(header)) == len(header), "metric_source_invalid", "CSV 列名重复，无法唯一映射。", 422)
            columns = header
            for cells in reader:
                require(len(rows) < MAX_ROWS, "metric_source_invalid", "单源片映射最多 1000 行；请明确分批导入。", 422)
                number = reader.line_num
                raw = dict(zip(header, cells)) if len(cells) == len(header) else {"cells": cells}
                rows.append({"rowNumber": number, "rawRow": raw,
                             "parseError": None if len(cells) == len(header) else "CSV 行的字段数量与列名不一致。"})
    except (ValueError, csv.Error, RecursionError) as error:
        raise BroadcastError("metric_source_invalid", "原始文件无法解析：" + str(error)[:300], 422)
    require(rows, "metric_source_invalid", "原始文件没有数据行。", 422)
    require(len(columns) <= 100, "metric_source_invalid", "原始文件列数超过 100。", 422)
    return {"format": format, "sourceSha256": source_hash, "byteLength": len(encoded),
            "columns": columns, "rowCount": len(rows), "rows": rows}


def inspect_source(format, text):
    """Inspect raw column names without choosing any mapping or interpreting units."""
    source = _parse(format, text)
    return {"schema": "courtlens-metric-source/1", **{key: source[key] for key in
            ("format", "sourceSha256", "byteLength", "columns", "rowCount")},
            "sampleRows": copy.deepcopy(source["rows"][:8]),
            "malformedRows": [{"rowNumber": row["rowNumber"], "message": row["parseError"]}
                              for row in source["rows"] if row["parseError"]],
            "limitations": LIMITATIONS[:2]}


def _empty(value):
    return value is None or isinstance(value, str) and not value.strip()


def _cell(row, mapping, field):
    column = mapping.get(field)
    if column is None:
        return None
    require(column in row, "metric_column_missing", field + " 对应的列在本行缺失：" + column, 422)
    return row[column]


def _identity(value, label, nullable=False):
    if nullable and _empty(value):
        return None
    # IDs are literal provider IDs; never normalize aliases or formula cells.
    require(valid_id(value), "metric_identity_invalid", label + " 须为明确的原始 ID（字母、数字、下划线或连字符，最多 80 字符）。", 422)
    return value


def _number(value, label, format):
    if _empty(value):
        return None
    if format == "csv" and isinstance(value, str):
        require(NUMBER.fullmatch(value.strip()) is not None, "metric_number_invalid", label + " 须为有限数字或空白；不会执行公式。", 422)
        value = float(value.strip())
    require(finite(value), "metric_number_invalid", label + " 须为有限数字或 null；布尔值、NaN 和公式均无效。", 422)
    return value


def _time(project, frames, row, request, field, evidence):
    value = _cell(row, request["mapping"], field)
    if _empty(value):
        return None
    if request["timeBase"] == "video":
        at = _number(value, field, request["format"])
    else:
        alignment = request.get("clockAlignment")
        require(isinstance(alignment, dict) and set(alignment) == {"segmentId", "period", "anchors"},
                "clock_invalid", "比赛时钟需要明确的镜头段、节次与两个锚点。", 422)
        target = copy.deepcopy(alignment)
        # Optional columns must agree with the selected segment-local anchors.
        if request["mapping"].get("period") is not None:
            period = _number(_cell(row, request["mapping"], "period"), "period", request["format"])
            require(period == alignment["period"], "clock_ambiguous", "本行节次与所选锚点节次不一致，请按节次分别映射。", 422)
        if request["mapping"].get("segmentId") is not None:
            require(_cell(row, request["mapping"], "segmentId") == alignment["segmentId"],
                    "clock_ambiguous", "本行镜头段与所选锚点不一致；回放须独立映射。", 422)
        target["clock"] = value
        result = clock_alignment.preview(project, frames, target)
        evidence[field] = result
        at = result["mapping"]["videoTime"]
    require(0 <= at <= project["media"]["duration"], "metric_time_outside_video", field + " 超出源片范围。", 422)
    return at


def _record(project, request, source, parsed, frames):
    require(parsed["parseError"] is None, "metric_row_malformed", parsed["parseError"] or "原始行无效。", 422)
    row, mapping = parsed["rawRow"], request["mapping"]
    rid = _identity(_cell(row, mapping, "recordId"), "recordId")
    metric_id = _identity(_cell(row, mapping, "metricId"), "metricId")
    definition = request["dictionary"]["metrics"].get(metric_id)
    require(definition is not None, "metric_unknown", "metricId 不在提供的原始字典中。", 422)
    require(definition["granularity"] == request["granularity"], "metric_scope_mismatch",
            "字典统计粒度与所选单次出手/事件不一致；赛季或球员汇总不能转为瞬时数值。", 422)
    value = _number(_cell(row, mapping, "value"), "value", request["format"])
    if value is not None:
        bounds = definition.get("range")
        if bounds is not None:
            require(bounds[0] <= value <= bounds[1], "metric_value_out_of_range", "value 超出提供者声明的范围。", 422)
        if definition["semantics"] in ("shot_make_probability", "official_xfg", "xfg_probability",
                                       "shot_difficulty", "shot_difficulty_probability", "possession_win_probability_opportunity"):
            require(0 <= value <= (100 if definition["unit"] == "percent" else 1),
                    "metric_value_out_of_range", "value 超出字典明确声明的概率尺度。", 422)
    if mapping.get("unit") is not None:
        require(_cell(row, mapping, "unit") == definition["unit"], "metric_unit_mismatch", "原始单位与字典单位不一致；不会猜测或转换单位。", 422)
    context = project["context"]
    if mapping.get("gameId") is not None:
        require(_cell(row, mapping, "gameId") == context["gameId"], "metric_game_mismatch", "本行比赛 ID 与项目比赛 ID 不一致。", 422)
    key = "shotId" if request["granularity"] == "shot" else "eventId"
    scope = {"granularity": request["granularity"], "playId": "metric-source",
             key: _identity(_cell(row, mapping, key), key)}
    roster = {player["id"]: player for player in context.get("roster", [])}
    for field in ("playerId", "teamId", "seasonId"):
        if mapping.get(field) is None:
            continue
        identity = _identity(_cell(row, mapping, field), field, nullable=True)
        if identity is None:
            continue
        if field == "playerId":
            require(identity in roster, "metric_player_mismatch", "本行球员 ID 不在已确认的当场名单中。", 422)
        if field == "seasonId":
            require(identity == context.get("seasonId"), "metric_season_mismatch", "本行赛季 ID 与项目上下文不一致。", 422)
        if field == "teamId":
            teams = {player.get("teamId") for player in roster.values()} | {context.get("offenseTeamId")}
            require(identity in teams, "metric_team_mismatch", "本行球队 ID 不在已确认比赛上下文中。", 422)
        scope[field] = identity
    if scope.get("playerId") and scope.get("teamId"):
        require(roster[scope["playerId"]].get("teamId") == scope["teamId"], "metric_player_mismatch", "球员与球队身份冲突。", 422)
    evidence, timing = {}, {"timeBase": "video"}
    for field in TIMES:
        if field in ("observedAt", "availableAt") or mapping.get(field) is not None:
            timing[field] = _time(project, frames, row, request, field, evidence)
    if timing.get("validFrom") is not None and timing.get("validTo") is not None:
        require(timing["validFrom"] < timing["validTo"], "metric_time_invalid", "指标有效区间倒置或为空。", 422)
    warnings = []
    if value is None:
        warnings.append("value_missing")
    if timing["availableAt"] is None:
        warnings.append("availability_unknown")
    if timing["observedAt"] is None:
        warnings.append("observation_time_unknown")
    record = {"id": rid, "metricId": metric_id, "value": value, "unit": definition["unit"],
              "scope": scope, "time": timing,
              "intake": {"sourceSha256": source["sourceSha256"], "rowNumber": parsed["rowNumber"],
                         "rawRow": copy.deepcopy(row), "clockMappings": evidence}}
    return {"rowNumber": parsed["rowNumber"], "record": record, "warnings": warnings}


def preview(project, request, frames=None):
    """Return a dry-run bundle plus individual rejected rows; never change project.

    Mapping values are exact column names, or explicit null for unknown optional
    fields. observedAt and availableAt mappings must both be present; their null
    mappings/cells remain null independently. Video seconds and game clocks are
    selected explicitly with timeBase. Exact provider dictionary is required.
    """
    require(isinstance(request, dict) and set(request) <= {"format", "text", "mapping", "dictionary",
            "granularity", "timeBase", "clockAlignment", "bindings", "sourceName"},
            "metric_mapping_invalid", "指标映射请求含未知字段。", 422)
    source = _parse(request.get("format"), request.get("text"))
    media = project.get("media")
    require(isinstance(media, dict) and finite(media.get("duration")) and media["duration"] > 0,
            "media_mismatch", "先上传可用的源视频。", 422)
    require(isinstance(project.get("context"), dict) and valid_id(project["context"].get("gameId")),
            "metric_game_missing", "先确认项目比赛 ID；不能猜测指标所属比赛。", 422)
    require(request.get("granularity") in ("shot", "event"), "metric_scope_mismatch", "主视频映射只接受明确的单次出手或事件粒度。", 422)
    require(request.get("timeBase") in ("video", "game-clock"), "metric_mapping_invalid", "显式选择 video 秒或 game-clock 倒计时。", 422)
    mapping = request.get("mapping")
    key = "shotId" if request["granularity"] == "shot" else "eventId"
    require(isinstance(mapping, dict) and set(mapping) <= FIELDS and
            {"recordId", "metricId", "value", key, "observedAt", "availableAt"} <= set(mapping),
            "metric_mapping_invalid", "显式选择记录、指标、数值、事件/出手、发生与可用时间列；未知时间填 null。", 422)
    for field, column in mapping.items():
        require(column is None or isinstance(column, str) and column in source["columns"],
                "metric_mapping_invalid", field + " 映射须为原始列名或 null。", 422)
    require(all(mapping.get(field) is not None for field in ("recordId", "metricId", "value", key)),
            "metric_mapping_invalid", "记录 ID、指标 ID、数值与事件/出手 ID 必须选列。", 422)
    require(request.get("sourceName") is None or isinstance(request["sourceName"], str) and len(request["sourceName"]) <= 200,
            "metric_mapping_invalid", "原始文件名无效或过长。", 422)
    dictionary = request.get("dictionary")
    bundle = {"schema": "courtlens-metrics/2", "name": project.get("title", "原始指标映射预览"),
              "dictionary": copy.deepcopy(dictionary), "bindings": copy.deepcopy(request.get("bindings", {})),
              "plays": [{"id": "metric-source", "gameId": project["context"]["gameId"],
                         "start": 0, "end": media["duration"]}], "records": []}
    result = {"schema": "courtlens-metric-intake/1", "projectId": project["id"],
              "projectRevision": project["revision"], "mediaSha256": media["sha256"],
              "status": "blocked", "bundle": None, "acceptedRows": [], "rejectedRows": [],
              "validation": {"ok": False, "error": None}, "limitations": copy.deepcopy(LIMITATIONS),
              "counts": {"source": source["rowCount"], "accepted": 0, "rejected": 0},
              "audit": {"sourceName": request.get("sourceName"), "format": source["format"],
                        "sourceSha256": source["sourceSha256"], "byteLength": source["byteLength"],
                        "rowCount": source["rowCount"], "mapping": copy.deepcopy(mapping),
                        "timeBase": request["timeBase"], "granularity": request["granularity"],
                        "clockAlignment": copy.deepcopy(request.get("clockAlignment")),
                        "rawRows": copy.deepcopy(source["rows"])}}
    # Validate exact input dictionary before reading any values. The canonical
    # v2 validator remains mandatory; this module is not a replacement for it.
    try:
        validation.metric_bundle(bundle)
        result["audit"]["dictionarySha256"] = hash_json(dictionary)
    except BroadcastError as error:
        result["validation"]["error"] = error.body()
        return result
    candidates = []
    for parsed in source["rows"]:
        try:
            candidates.append(_record(project, request, source, parsed, frames or []))
        except BroadcastError as error:
            result["rejectedRows"].append({"rowNumber": parsed["rowNumber"],
                "rawRow": copy.deepcopy(parsed["rawRow"]), "code": error.code, "message": str(error)})
    # Reject every member of a collision: never silently pick the first value,
    # and never deduplicate distinct events by clock alone (including replays).
    ids, slots = {}, {}
    # A malformed/conflicting row does not license retaining another row with
    # its same record ID. Keep all such IDs in the collision audit.
    for parsed in source["rows"]:
        if isinstance(parsed["rawRow"], dict):
            identity = parsed["rawRow"].get(mapping["recordId"])
            if valid_id(identity):
                ids.setdefault(identity, []).append(parsed["rowNumber"])
    for candidate in candidates:
        record, timing = candidate["record"], candidate["record"]["time"]
        slot = hash_json([record["metricId"], record["scope"], timing["observedAt"],
                          timing.get("validFrom"), timing.get("validTo")])
        slots.setdefault(slot, []).append(candidate["rowNumber"])
    duplicated = {number for group in list(ids.values()) + list(slots.values()) if len(group) > 1 for number in group}
    for candidate in candidates:
        if candidate["rowNumber"] in duplicated:
            result["rejectedRows"].append({"rowNumber": candidate["rowNumber"],
                "rawRow": candidate["record"]["intake"]["rawRow"], "code": "metric_duplicate_conflict",
                "message": "记录 ID 或相同指标/完整范围/观察与有效区间重复；须人工消解全部冲突行。"})
        else:
            result["acceptedRows"].append(candidate)
    result["rejectedRows"].sort(key=lambda row: row["rowNumber"])
    bundle["records"] = [candidate["record"] for candidate in result["acceptedRows"]]
    bundle["intakeAudit"] = {key: copy.deepcopy(value) for key, value in result["audit"].items() if key != "rawRows"}
    try:
        # Fail the entire proposed bundle if any v2 rule not covered above fails.
        # A successful preview remains a proposal and is not saved or reviewed.
        validation.metric_bundle(bundle)
        require(len(canonical(bundle)) <= 8 * 1024 * 1024, "metric_source_invalid", "映射结果超过 8 MiB。", 422)
        result["validation"]["ok"] = True
        # An all-rejected source must never expose an importable empty bundle:
        # confirming it would otherwise clear a project's existing metric work.
        result["bundle"] = bundle if bundle["records"] else None
        result["status"] = ("partial" if result["rejectedRows"] else "proposal") if bundle["records"] else "blocked"
    except BroadcastError as error:
        result["validation"]["error"] = error.body()
    result["counts"] = {"source": source["rowCount"], "accepted": len(result["acceptedRows"]),
                        "rejected": len(result["rejectedRows"])}
    return result


def convert(project, request, frames=None):
    """Alias for preview; conversion is always dry-run."""
    return preview(project, request, frames)
