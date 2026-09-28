"""An inspectable evidence agent. No LLM, training, tracking, or metric inference."""

import re
from .validation import ValidationError, validate_dataset

MODE = "deterministic-evidence-agent"
METRIC_NAMES = {"xfg_pct": "Shot xFG%", "gravity": "Gravity", "leverage": "回合胜率机会差"}


def pct(value):
    return "缺失" if value is None else f"{value * 100:.1f}%"


def metric_text(key, value):
    if value is None:
        return "缺失"
    return f"{value:g}（输入单位）" if key == "gravity" else pct(value)


def selection_score(p):
    """Editorial points, not a learned score or a probability.

    Missing components contribute zero and are reported. Gravity is not scored:
    its source units may not be comparable across datasets.
    """
    xfg, leverage = p["metrics"]["xfg_pct"], p["metrics"]["leverage"]
    opportunity = 70 * leverage if leverage is not None else 0.0
    difficulty = 20 * (1 - xfg) if xfg is not None else 0.0
    surprise = 0.0
    if xfg is not None and p["result"] != "unknown":
        surprise = 10 * ((1 - xfg) if p["result"] == "made" else xfg)
    reasons = [
        "编辑筛选公式：70×回合胜率机会差 + 20×(1−xFG) + 10×结果反差；不是胜率或模型准确率。",
        f"胜率机会差贡献 {opportunity:.2f} 分；投篮难度贡献 {difficulty:.2f} 分；结果反差贡献 {surprise:.2f} 分。",
        "结果反差：命中用 1−xFG，未中用 xFG，结果未知用 0；Gravity 不进入排序。",
    ]
    if xfg is None or leverage is None:
        reasons.append("缺失项贡献记 0，不补值、不重分配权重；数据不完整会影响排序。")
    return round(opportunity + difficulty + surprise, 4), reasons


def camera_segment(p, t):
    for i, segment in enumerate(p["camera_segments"]):
        if segment["start"] <= t < segment["end"] or (i == len(p["camera_segments"]) - 1 and t == segment["end"]):
            return i, segment
    return None, None


def nearest_track(p, t, tolerance=0.75):
    _, segment = camera_segment(p, t)
    if segment is None or not segment["calibrated"]:
        return None
    candidates = [frame for frame in p["tracks"] if segment["start"] <= frame["t"] < segment["end"] or (frame["t"] == segment["end"] == p["end"])]
    if not candidates:
        return None
    frame = min(candidates, key=lambda item: abs(item["t"] - t))
    return frame if abs(frame["t"] - t) <= tolerance else None


def possession_warnings(p):
    warnings = []
    missing = [METRIC_NAMES[k] for k, value in p["metrics"].items() if k in METRIC_NAMES and value is None]
    if missing:
        warnings.append("指标缺失：" + "、".join(missing) + "。不以其他字段替代。")
    if not p["tracks"]:
        warnings.append("无轨迹样本：不能推断跑位，自动轨迹叠加应关闭；人工标注需独立标明。")
    elif p["tracks"][0]["t"] - p["start"] > 1.0 or p["end"] - p["tracks"][-1]["t"] > 1.0 or any(b["t"] - a["t"] > 1.0 for a, b in zip(p["tracks"], p["tracks"][1:])):
        warnings.append("轨迹有超过 1 秒的缺口；缺口内不可插值或推断跑位。")
    if nearest_track(p, p["shot_time"]) is None:
        warnings.append("投篮时刻附近无已标定的可靠轨迹；不能据此描述出手站位。")
    if any(not s["calibrated"] for s in p["camera_segments"]):
        warnings.append("存在未标定镜头段；该段关闭自动轨迹与自动空间标注；人工核对标注独立显示。")
    if len(p["camera_segments"]) > 1:
        warnings.append("存在镜头切换；轨迹不得跨镜头边界插值。")
    segments = p["camera_segments"]
    if segments[0]["start"] > p["start"] or segments[-1]["end"] < p["end"] or any(b["start"] > a["end"] for a, b in zip(segments, segments[1:])):
        warnings.append("镜头标定未覆盖完整回合；未覆盖时段关闭叠加层。")
    if p["result"] == "unknown":
        warnings.append("投篮结果未知，不推测是否命中。")
    elif p.get("result_time") is None:
        warnings.append("结果时刻缺失；回放字幕不提前宣布结果，结果记录仅用于赛后解说。")
    return warnings


def collect_evidence(dataset, p, score):
    pid = p["id"]
    synthetic = dataset["provenance"]["kind"] == "synthetic"
    source = "合成演练数值；不对应真实 NBA 事件" if synthetic else "输入字段；来源真实性未独立核验：" + "; ".join(p["source_refs"])
    evidence = []
    for key in METRIC_NAMES:
        evidence.append({
            "id": f"{pid}:metric:{key}", "label": METRIC_NAMES[key], "value": p["metrics"][key],
            "unit": "输入单位" if key == "gravity" else "probability (0–1)",
            "source": source, "time": p["shot_time"], "definition": dataset["metric_definitions"][key],
        })
    evidence.append({
        "id": f"{pid}:event", "label": "输入出手记录", "value": {"shooter": p["shooter"], "shot_value": p["points"], "offense": p["offense"]},
        "unit": "事件", "source": source, "time": p["shot_time"],
        "definition": "由输入记录描述投篮球员与投篮分值；不是模型从视频识别的结论。结果另有独立证据与时间锚。",
    })
    result_time = p.get("result_time")
    evidence.append({
        "id": f"{pid}:result", "label": "输入投篮结果", "value": p["result"], "unit": "事件结果", "source": source,
        "time": result_time if result_time is not None else p["end"],
        "definition": "输入结果记录；按 result_time 才能显示结果字幕。" if result_time is not None else "结果时刻缺失；此条只供赛后回顾，时间锚暂用回合末尾，不是实测结果时刻。",
    })
    frame = nearest_track(p, p["shot_time"])
    shooter = next((player for player in frame["players"] if player["id"] == p["shooter"]), None) if frame else None
    evidence.append({
        "id": f"{pid}:tracking", "label": "出手附近轨迹样本", "value": {"sample_time": frame["t"], "player": shooter, "ball": frame["ball"]} if frame else None,
        "unit": "归一化画面坐标 (0–1)", "source": "输入轨迹样本；未跨镜头插值", "time": frame["t"] if frame else p["shot_time"],
        "definition": "从同一已标定镜头内取距投篮时刻不超过 0.75 秒的最近样本；画面距离不能视为球场米数。",
    })
    grouped = {}
    for annotation in p["annotations"]:
        grouped.setdefault(annotation["evidence_id"], []).append(annotation)
    for eid, annotations in grouped.items():
        first = annotations[0]
        sample = nearest_track(p, min(max(p["shot_time"], first["start"]), first["end"]))
        evidence.append({
            "id": eid, "label": "画面注释：" + first["label"],
            "value": {"annotations": [{k: a[k] for k in ("id", "kind", "start", "end", "points", "label")} for a in annotations], "track_sample": sample},
            "unit": "归一化画面坐标 (0–1)", "source": "人工视频标注；由标注者核对画面，不代表自动跟踪或战术因果" if all(a.get("origin")=="manual" for a in annotations) else ("合成输入注释几何 + 同镜头轨迹样本" if synthetic else "用户输入注释几何；未独立核验战术含义"),
            "time": first["start"], "definition": "箭头与区域只标示给定的画面位置或轨迹；不证明牵制效果或投篮因果。",
        })
    evidence.append({
        "id": f"{pid}:rank", "label": "编辑筛选分", "value": score, "unit": "编辑分（0–100）",
        "source": "公开确定性公式；不使用 Gravity，不补齐缺失项", "time": p["start"],
        "definition": "70×回合胜率机会差 + 20×(1−xFG) + 10×结果反差。命中反差=1−xFG，未中反差=xFG，未知=0。此分数不是胜率、模型精度或官方关键度。",
    })
    return evidence


def analyze_possession(dataset, p, audience):
    pid, metrics = p["id"], p["metrics"]
    xfg, gravity, leverage = (metrics[k] for k in ("xfg_pct", "gravity", "leverage"))
    score, reasons = selection_score(p)
    result = {"made": "命中", "missed": "未中", "unknown": "结果未知"}[p["result"]]
    event = f"{p['shooter']} 的 {p['points']} 分投篮，{result}。"
    xfg_line = "该次出手的预期命中概率缺失。" if xfg is None else f"该次出手预期命中概率 {pct(xfg)}，不保证实际结果。"
    gravity_line = "Gravity 缺失，不能用最近防守者距离代替。" if gravity is None else f"输入 Gravity 为 {gravity:g}；不能单凭此值断言牵制导致命中。"
    leverage_line = "回合胜率机会差缺失，无法据此判断机会大小。" if leverage is None else f"输入回合胜率机会差 {pct(leverage)}，不等于实际胜率增减。"
    fan = event + xfg_line + leverage_line
    analyst = event + xfg_line + gravity_line + leverage_line
    claims = [
        {"id": f"{pid}:claim:event", "text": f"{p['shooter']} 执行 {p['points']} 分投篮。", "type": "observed", "evidence_ids": [f"{pid}:event"]},
        {"id": f"{pid}:claim:result", "text": f"输入投篮结果：{result}。", "type": "unavailable" if p["result"] == "unknown" else "observed", "evidence_ids": [f"{pid}:result"]},
        {"id": f"{pid}:claim:xfg", "text": xfg_line, "type": "unavailable" if xfg is None else "observed", "evidence_ids": [f"{pid}:metric:xfg_pct"]},
        {"id": f"{pid}:claim:gravity", "text": gravity_line, "type": "unavailable" if gravity is None else "observed", "evidence_ids": [f"{pid}:metric:gravity"]},
        {"id": f"{pid}:claim:leverage", "text": leverage_line, "type": "unavailable" if leverage is None else "observed", "evidence_ids": [f"{pid}:metric:leverage"]},
        {"id": f"{pid}:claim:rank", "text": f"编辑筛选分 {score:.2f}，仅用于挑选片段。", "type": "inferred", "evidence_ids": [f"{pid}:rank"]},
    ]
    duration = p["end"] - p["start"]
    # No result is revealed before its own supplied time. Missing result_time
    # disables result captions entirely; retrospective prose may still use it.
    cue_text = [
        f"{p['offense']} · {p['shooter']} · {p['points']} 分回合",
        f"胜率机会差 {pct(leverage)}" if audience == "fan" else f"Gravity {metric_text('gravity', gravity)}",
        "预期命中概率缺失" if xfg is None else f"预期命中概率 {pct(xfg)}",
    ]
    cue_evidence = [[f"{pid}:event"], [f"{pid}:metric:leverage" if audience == "fan" else f"{pid}:metric:gravity"], [f"{pid}:metric:xfg_pct"]]
    result_time = p.get("result_time") if p["result"] != "unknown" else None
    pre_result_end = result_time if result_time is not None else p["end"]
    cues = []
    for i, (text, ids) in enumerate(zip(cue_text, cue_evidence)):
        start = p["start"] + i * duration / 3
        end = min(p["start"] + (i + 1) * duration / 3, pre_result_end)
        if end > start:
            cues.append({"start": start, "end": end, "text": text, "evidence_ids": ids})
    if result_time is not None and result_time < p["end"]:
        cues.append({"start": result_time, "end": p["end"], "text": f"命中 · {p['points']} 分投篮" if p["result"] == "made" else "本次投篮未中", "evidence_ids": [f"{pid}:result", f"{pid}:event"]})
    warnings = possession_warnings(p)
    if duration < 6:
        warnings.append("片段不足 6 秒，字幕可能来不及读完；请扩展片段或精简字幕。")
    return {
        "id": pid, "title": p["title"], "start": p["start"], "end": p["end"], "rank_score": score, "rank_reasons": reasons,
        "headline": f"{p['shooter']} {result} · 预期命中 {pct(xfg)}", "fan_narration": fan, "analyst_narration": analyst,
        "claims": claims, "evidence": collect_evidence(dataset, p, score), "cues": cues, "warnings": warnings,
    }


def validate_audience(audience):
    if audience not in ("fan", "analyst"):
        raise ValidationError("audience", "必须是 fan 或 analyst")


def analyze(dataset, audience="fan"):
    validate_audience(audience)
    d = validate_dataset(dataset)
    possessions = [analyze_possession(d, p, audience) for p in d["possessions"]]
    possessions.sort(key=lambda p: (-p["rank_score"], p["start"], p["id"]))
    synthetic = d["provenance"]["kind"] == "synthetic"
    warnings = [
        "离线确定性证据 Agent：不调用语言模型，不从视频检测球员，不估计官方指标。",
        "合成数据仅验证功能，不对应真实 NBA 比赛、球员或官方统计。" if synthetic else "来源标签来自输入，未独立核验；正式字段须按数据字典适配。",
        "Shot xFG% 是该次出手的预测命中概率；Gravity 保留输入口径；回合胜率机会差不是实际胜率变化或球员累计 Leverage Score。",
    ]
    top = possessions[0]
    trace = [
        {"step": "1", "tool": "validate_dataset", "status": "ok", "detail": f"校验 {len(possessions)} 个回合：时序、有限数字、坐标、唯一 ID、指标及口径。"},
        {"step": "2", "tool": "collect_evidence", "status": "ok", "detail": "读取输入事件、指标、同镜头轨迹与注释几何；缺失信息保留为空。"},
        {"step": "3", "tool": "selection_score", "status": "ok", "detail": "使用公开编辑公式排序；不把 xFG 当作关键度，不使用 Gravity 代理值。"},
        {"step": "4", "tool": "compose_grounded_narration", "status": "ok", "detail": f"按 {'球迷' if audience == 'fan' else '分析师'}视角生成短字幕与逐条证据引用；不推断战术因果。"},
    ]
    return {"mode": MODE, "provenance": d["provenance"], "summary": f"已分析 {len(possessions)} 个回合；优先回看“{top['title']}”（编辑分 {top['rank_score']:.2f}）。" + ("本演练全部为合成内容。" if synthetic else "排序依赖输入字段的完整性与口径。"), "possessions": possessions, "trace": trace, "warnings": warnings}


INJECTION = re.compile(r"ignore\s+(all\s+)?(previous|prior|system|instructions|rules)|reveal.{0,20}(system|secret|prompt)|system\s*prompt|忽略.{0,16}(指令|规则|要求)|泄露.{0,16}(提示词|密钥)|执行.{0,20}(命令|代码)|假装.{0,15}(官方|真实)|伪造|编造|不要.{0,10}(证据|来源)|\b(?:curl|subprocess|eval|exec)\s*\(", re.I)
CAUSAL = re.compile(r"导致|造成|因果|证明|归功|为什么.{0,20}(命中|投进|漏人|得分)|why.{0,25}(made|score|defen)|caus|because", re.I)


def mentioned_possessions(question, possessions):
    """Resolve literal IDs beside Chinese text without matching p02 in p020.

    The query's mention order is retained. Longest matches win when imported
    IDs contain another ID; ordinary Chinese letters are not ID delimiters in
    Python's Unicode word matcher, so use explicit ASCII token boundaries here.
    """
    matches = []
    for p in possessions:
        pattern = r"(?<![A-Za-z0-9_])" + re.escape(p["id"]) + r"(?![A-Za-z0-9_])"
        matches.extend((m.start(), m.end(), p) for m in re.finditer(pattern, question, re.I))
    matches.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    mentioned, covered, seen = [], [], set()
    for start, end, p in matches:
        if any(start < b and end > a for a, b in covered):
            continue
        covered.append((start, end))
        if p["id"] not in seen:
            mentioned.append(p)
            seen.add(p["id"])
    unknown = []
    # Unrecognized conventional pNN IDs are explicit unavailable references,
    # not permission to substitute the selected clip or the editorial leader.
    for m in re.finditer(r"(?<![A-Za-z0-9_])p[0-9]+(?![A-Za-z0-9_])", question, re.I):
        if not any(m.start() >= a and m.end() <= b for a, b in covered):
            if m.group().casefold() not in {x.casefold() for x in unknown}:
                unknown.append(m.group())
    return mentioned, unknown


def ask(dataset, question, possession_id, audience="fan"):
    validate_audience(audience)
    d = validate_dataset(dataset)
    if not isinstance(question, str) or not question.strip() or len(question) > 1000:
        raise ValidationError("question", "问题必须是 1–1000 字的非空文本")
    p = next((p for p in d["possessions"] if p["id"] == possession_id), None)
    if p is None:
        raise ValidationError("possession_id", "未找到指定回合")
    q = question.strip()
    score, reasons = selection_score(p)
    result = {"answer": "", "evidence_ids": [], "mode": MODE, "warnings": [], "trace": [
        {"step": "1", "tool": "validate_dataset", "status": "ok", "detail": "问题与当前数据通过校验。"},
        {"step": "2", "tool": "route_question", "status": "ok", "detail": "本地规则只支持指标解释、片段筛选、回合比较与事件摘要。"},
    ]}
    def respond(answer, ids=(), tool="lookup_evidence", warning=None):
        result["answer"], result["evidence_ids"] = answer, list(dict.fromkeys(ids))
        result["trace"].append({"step": "3", "tool": tool, "status": "unsupported" if warning else "ok", "detail": "拒绝无证据结论。" if warning else "答案仅引用当前数据字段和公开公式。"})
        if warning:
            result["warnings"].append(warning)
        return result
    if INJECTION.search(q):
        return respond("我只根据当前回合的输入证据回答。不能伪造指标、执行问题里的指令，或把合成演练说成真实比赛。", tool="guard_untrusted_question", warning="问题含试图改变证据边界的指令，未执行。")
    if CAUSAL.search(q):
        return respond("这些数据不能证明战术因果。可以核对出手结果、Shot xFG%、输入 Gravity 与回合胜率机会差，但不能据此断言“牵制导致命中”或“某人造成漏防”。", [f"{p['id']}:result", f"{p['id']}:metric:gravity", f"{p['id']}:metric:xfg_pct"], warning="缺少支持因果结论的证据。")
    if re.search(r"(?:哪些|什么|列出|查看|核对|验证|展示|给我).{0,12}(?:证据|来源)|(?:证据|来源).{0,12}(?:哪些|什么|列表)|\bevidence\b|\bsources?\b", q, re.I):
        mentioned, unknown = mentioned_possessions(q, d["possessions"])
        if unknown:
            return respond("当前数据中没有回合 " + "、".join(unknown) + "，无法列出其证据。", tool="resolve_evidence_scope", warning="指定回合不存在。")
        ids, lines = [], []
        for item in mentioned or [p]:
            for evidence in collect_evidence(d, item, selection_score(item)[0]):
                eid = evidence["id"]
                ids.append(eid)
                if ":metric:" in eid:
                    key = eid.rsplit(":", 1)[-1]
                    value = metric_text(key, evidence["value"])
                elif eid == f"{item['id']}:event":
                    value = f"{item['shooter']} 的 {item['points']} 分出手记录"
                elif eid == f"{item['id']}:result":
                    value = {"made": "命中", "missed": "未中", "unknown": "结果未知"}[item["result"]]
                    if item.get("result_time") is None:
                        value += "；结果时刻缺失，此时间仅为回合末尾锚点"
                elif eid == f"{item['id']}:rank":
                    value = f"{evidence['value']:.2f}，由公开编辑公式计算"
                elif evidence["value"] is None:
                    value = "缺失，不能据此补写观测"
                else:
                    value = "结构化坐标记录，可在对应证据卡核对"
                lines.append(f"{evidence['label']} [{eid}]，时间锚 {evidence['time']:g} 秒：{value}。")
        return respond("可核对的输入证据与计算结果：" + " ".join(lines) + "这些引用不代表来源真实性已被独立核验；画面注释也不证明战术因果。", ids, "list_evidence")
    keys = []
    if re.search(r"xfg|命中概率|预期命中|投篮质量", q, re.I):
        keys.append("xfg_pct")
    if re.search(r"gravity|牵制|引力", q, re.I):
        keys.append("gravity")
    if re.search(r"leverage|机会差|杠杆|关键度|胜率", q, re.I):
        keys.append("leverage")

    wants_max = bool(re.search(r"最高|最大|更高|更大|highest|largest|maximum|\bmax\b", q, re.I))
    wants_min = bool(re.search(r"最低|最小|更低|更小|lowest|smallest|minimum|\bmin\b", q, re.I))
    wants_order = bool(re.search(r"排序|排名|排行|sort|order|\brank(?:ing)?\b", q, re.I))
    wants_comparison = bool(re.search(r"比较|对比|相比|compare|versus|\bvs\b", q, re.I))
    unsupported_metric = bool(re.search(r"得分|篮板|助攻|速度|跑动|效率|薪资|工资|合同|球员表现|防守.{0,8}(好|差|强|弱)|points|rebound|assist|speed|efficiency|\befg\b|salary|contract|defen", q, re.I))
    # Metric ordering is distinct from explaining the editorial rank. A naked
    # “why ranked?” continues to the existing selection-explanation route, but
    # a request to sort an unknown metric must not become a rank explanation.
    asks_selection_reason = bool(re.search(r"为什么|为何|解释|\bwhy\b|\bexplain\b", q, re.I)) and not keys and not unsupported_metric
    numeric_query = wants_max or wants_min or (wants_order and not asks_selection_reason)
    if wants_comparison or numeric_query:
        mentioned, unknown = mentioned_possessions(q, d["possessions"])
        if unknown:
            return respond("当前数据中没有回合 " + "、".join(unknown) + "，无法按指定范围比较；未替换成其他回合。", tool="resolve_comparison_scope", warning="指定回合不存在。")
        unknown_named_field = re.search(r"(?:的|\bby\s+)([A-Za-z0-9_\u4e00-\u9fff]+)", q, re.I) if not keys else None
        if unknown_named_field and unknown_named_field.group(1) in ("区别", "差异", "差别", "不同", "指标", "所有指标"):
            unknown_named_field = None
        if unsupported_metric or unknown_named_field:
            return respond("当前比较工具只支持 Shot xFG%、Gravity 与回合胜率机会差。这个问题还要求未支持的指标或评价，现有证据不足以回答；未用其他指标替代。", tool="report_unsupported", warning="请求包含当前工具不支持的比较项目。")
        if numeric_query and not keys:
            return respond("请明确要比较的指标：Shot xFG%、Gravity 或回合胜率机会差。不能把未指定的“最高／最低”自动解释成编辑筛选分。", tool="report_unsupported", warning="未指定可支持的比较指标。")

        # Multiple explicit IDs always define the scope. With no such scope,
        # global extrema/order must consider every possession, not the active
        # clip plus the highest editorial score. One ID in “p02最高吗” is a
        # candidate, not a one-item population; the stated scope remains all.
        if len(mentioned) >= 2:
            selected = mentioned
            scope = "比较范围：" + "、".join(item["id"] for item in selected) + "。"
        elif numeric_query or not mentioned:
            selected = d["possessions"]
            scope = f"比较范围：全部 {len(selected)} 个回合。"
        elif re.search(r"当前|这个回合|本回合|current|selected", q, re.I) and mentioned[0]["id"] != p["id"]:
            selected = [p, mentioned[0]]
            scope = "比较范围：" + "、".join(item["id"] for item in selected) + "。"
        else:
            return respond(f"只指定了 {mentioned[0]['id']} 一个回合；请再指定另一个回合，或明确比较全部回合。未自动加入其他回合。", tool="resolve_comparison_scope", warning="比较范围不完整。")

        if numeric_query:
            ids, lines, missing_notes = [], [], []
            has_values = False
            ascending = bool(re.search(r"从低到高|由低到高|从小到大|升序|ascending|low.{0,6}high", q, re.I))
            descending = bool(re.search(r"从高到低|由高到低|从大到小|降序|descending|high.{0,6}low", q, re.I))
            if wants_order and ascending and descending:
                return respond("问题同时指定了升序和降序，无法确定一个排序方向；请保留一个方向。", tool="report_unsupported", warning="排序方向冲突。")
            for key in keys:
                available = [item for item in selected if item["metrics"][key] is not None]
                missing = [item["id"] for item in selected if item["metrics"][key] is None]
                ids.extend(f"{item['id']}:metric:{key}" for item in selected)
                if not available:
                    lines.append(f"{METRIC_NAMES[key]} 在指定范围内全部缺失，无法判断极值或排序。")
                else:
                    has_values = True
                    if wants_max or wants_min:
                        for maximum, requested in ((True, wants_max), (False, wants_min)):
                            if not requested:
                                continue
                            value = (max if maximum else min)(item["metrics"][key] for item in available)
                            winners = [item["id"] for item in available if item["metrics"][key] == value]
                            tie = "并列" if len(winners) > 1 else ""
                            lines.append(f"{METRIC_NAMES[key]} 可用数值中的{'最高' if maximum else '最低'}值：{'、'.join(winners)}{tie}，{metric_text(key, value)}。")
                    if wants_order:
                        ordered = sorted(available, key=lambda item: ((1 if ascending else -1) * item["metrics"][key], item["start"], item["id"]))
                        lines.append(f"{METRIC_NAMES[key]} 从{'低到高' if ascending else '高到低'}：" + "、".join(f"{item['id']}（{metric_text(key, item['metrics'][key])}）" for item in ordered) + "；相同数值为并列。")
                if missing:
                    note = f"{METRIC_NAMES[key]} 缺失回合：{'、'.join(missing)}；未参与数值比较，不能当作 0。"
                    lines.append(note)
                    missing_notes.append(note)
            response = respond(scope + " ".join(lines) + "比较只针对输入指标，不证明战术因果。", ids, "compare_metric_values", None if has_values else "指定指标全部缺失，无法给出极值或排序。")
            response["warnings"].extend(missing_notes)
            return response

        if len(selected) < 2:
            return respond("当前数据只有一个回合，无法做回合间比较。", warning="比较样本不足。")
        ids, lines = [], []
        for item in selected:
            compare_keys = keys or list(METRIC_NAMES)
            lines.append(f"{item['id']}：" + "，".join(METRIC_NAMES[k] + " " + metric_text(k, item["metrics"][k]) for k in compare_keys))
            ids.extend(f"{item['id']}:metric:{k}" for k in compare_keys)
        return respond(scope + "；".join(lines) + "。这只是输入数值比较，不证明因果。Gravity 不参与编辑排序。", ids, "compare_possessions")
    if re.search(r"为什么.{0,15}(选|片段|回合|排|关键)|为何.{0,15}(选|排|关键)|排序|筛选|为什么看|why.{0,20}(clip|select|rank|important)|rank|关键片段", q, re.I):
        return respond(f"{p['id']} 的编辑筛选分为 {score:.2f}。" + " ".join(reasons), [f"{p['id']}:rank", f"{p['id']}:metric:leverage", f"{p['id']}:metric:xfg_pct", f"{p['id']}:result"], "explain_selection")
    if keys:
        explanations = {
            "xfg_pct": "Shot xFG% 是该次出手的预测命中概率，不是期望得分，也不保证投进。本工具直接读取输入值，不从画面自行估算。",
            "gravity": "Gravity 是来源提供的牵制指标，本工具保留其数值与定义；最近防守者距离不是 Gravity 的替代值。单个数值不证明牵制导致得分。",
            "leverage": "本演练的 leverage 指回合胜率机会差（0–1），不是回合实际胜率增减，也不是球员 -10…+10 的累计 Leverage Score；正式数据须按字典适配。",
        }
        return respond(" ".join(f"{METRIC_NAMES[k]} 当前值：{metric_text(k, p['metrics'][k])}。{explanations[k]} 输入定义：{d['metric_definitions'][k]}" for k in keys), [f"{p['id']}:metric:{k}" for k in keys], "explain_metric")
    if re.search(r"发生|解说|讲解|总结|谁.{0,5}(投|进)|结果|describe|summary|happened", q, re.I):
        ap = analyze_possession(d, p, audience)
        return respond(ap["fan_narration" if audience == "fan" else "analyst_narration"], [f"{p['id']}:event", f"{p['id']}:result", f"{p['id']}:metric:xfg_pct", f"{p['id']}:metric:leverage"] + ([f"{p['id']}:metric:gravity"] if audience == "analyst" else []), "summarize_event")
    return respond("当前数据不足以回答这个问题。我能解释当前回合的 Shot xFG%、Gravity、回合胜率机会差，说明片段为何入选，或比较两个回合。对于伤病、真实球员身份、教练意图、比赛预测及外部事实，我没有证据。", tool="report_unsupported", warning="问题超出离线证据 Agent 的可支持范围；未生成猜测。")
