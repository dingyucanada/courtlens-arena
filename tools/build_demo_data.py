#!/usr/bin/env python3
"""Generate a reproducible, invented 36-second functional exercise.

HOU and DAL are team labels only. H1–H5 and D1–D5 are invented markers,
not real athletes. No NBA footage, results, measurements, or player likenesses
are used. All metric values are synthetic fixtures.
"""

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def plane(u, v):
    return {"x": round(0.5 + (u - 0.5) * (0.44 + 0.36 * v), 6), "y": round(0.20 + 0.64 * v, 6)}


def mix(a, b, t):
    t = max(0, min(1, t))
    return {k: round(a[k] * (1 - t) + b[k] * t, 6) for k in ("x", "y")}


def players_at(local_t, offense, variant):
    bases = [(0.49, 0.70), (0.16, 0.45), (0.84, 0.32), (0.36, 0.24), (0.69, 0.19)]
    players = []
    for team, prefix in (("HOU", "H"), ("DAL", "D")):
        for j, (u, v) in enumerate(bases):
            attacking = team == offense
            phase = j * 0.6 + variant * 0.4
            drift = min(local_t, 9) / 9
            # Small continuous movement makes interpolation visible without
            # pretending that this is a recovered real-world tactical pattern.
            u += 0.045 * math.sin(local_t * 0.48 + phase) + (0.045 if j % 2 == 0 else -0.035) * drift
            v += 0.035 * math.cos(local_t * 0.43 + phase)
            if not attacking:
                u += 0.045 if j < 3 else -0.045
                v -= 0.070
            if variant == 1 and j == 1 and attacking:
                u += 0.18 * drift
                v -= 0.12 * drift
            if variant == 2 and j == 4 and attacking:
                u += 0.10 * drift
                v += 0.14 * drift
            xy = plane(u, v)
            players.append({"id": prefix + str(j + 1), "team": team, **xy})
    return players


def create_possession(index, offense, shooter, result, points, metrics):
    start, end, shot = 12 * index, 12 * (index + 1), 12 * index + 9
    pid = f"p{index + 1:02d}"
    frames = []
    prefix = "H" if offense == "HOU" else "D"
    basket = {"x": 0.5, "y": 0.28}
    for sample in range(25):
        local_t = sample / 2
        players = players_at(local_t, offense, index)
        by_id = {player["id"]: player for player in players}
        passer, shooter_xy = by_id[prefix + "1"], by_id[shooter]
        if local_t < 4:
            ball = {k: passer[k] for k in ("x", "y")}
            ball["y"] = round(ball["y"] - 0.01 * abs(math.sin(local_t * 7)), 6)
        elif local_t < 5:
            ball = mix(passer, shooter_xy, local_t - 4)
        elif local_t < 9:
            ball = {"x": shooter_xy["x"] + 0.008, "y": shooter_xy["y"] - 0.009}
        elif local_t <= 10.5:
            at_shot = next(player for player in players_at(9, offense, index) if player["id"] == shooter)
            ball = mix(at_shot, basket, (local_t - 9) / 1.5)
            ball["y"] = round(ball["y"] - 0.12 * math.sin((local_t - 9) / 1.5 * math.pi), 6)
        else:
            rebound = {"x": 0.54, "y": 0.36} if result == "missed" else {"x": 0.5, "y": 0.32}
            ball = mix(basket, rebound, (local_t - 10.5) / 1.5)
        frames.append({"t": start + local_t, "players": players, "ball": ball})
    def player_point(local_t):
        frame = frames[int(local_t * 2)]
        player = next(player for player in frame["players"] if player["id"] == shooter)
        return [player["x"], player["y"]]
    x, y = player_point(9)
    radius = 0.035
    annotations = [
        {"id": pid + "-arrow", "start": start + 4, "end": start + 8, "kind": "arrow", "points": [player_point(4), player_point(8)], "label": shooter + " 移动轨迹", "evidence_id": pid + ":geometry:movement"},
        {"id": pid + "-zone", "start": start + 8, "end": start + 11, "kind": "zone", "points": [[round(x - radius, 6), round(y - radius, 6)], [round(x + radius, 6), round(y - radius, 6)], [round(x + radius, 6), round(y + radius, 6)], [round(x - radius, 6), round(y + radius, 6)]], "label": shooter + " 出手区域", "evidence_id": pid + ":geometry:shot-zone"},
    ]
    titles = ["低预期命中的高机会回合", "较高预期命中的未中回合", "较高牵制输入值的命中回合"]
    return {
        "id": pid, "title": titles[index], "start": start, "end": end, "shot_time": shot, "result_time": start + 10.5,
        "clock": ["Q3 07:41", "Q3 07:29", "Q3 07:17"][index], "offense": offense,
        "shooter": shooter, "result": result, "points": points, "metrics": metrics,
        "source_refs": ["synthetic:build_demo_data.py:" + pid], "annotations": annotations,
        "tracks": frames, "camera_segments": [{"start": start, "end": end, "calibrated": True}],
        "notes": ["纯合成功能演练；时间、比分、投篮与指标均为虚构，不是真实 NBA 事件。", "球员 ID 仅为演示标记；坐标是归一化画面坐标，不是球场米数。", "注释箭头来自 t=4 秒与 t=8 秒的实际合成轨迹点；区域围绕 t=9 秒的出手轨迹点生成。"],
    }


def build_demo():
    return {
        "schema_version": "1.0",
        "provenance": {"kind": "synthetic", "label": "纯合成功能演练 · 非真实 NBA 事件", "source": "CourtLens tools/build_demo_data.py：自行生成球员标记、运动轨迹、事件与示例指标；未使用官方比赛数据或版权比赛视频。"},
        "game": {"title": "HOU vs DAL · 合成功能演练", "home": "HOU", "away": "DAL", "period": "Q3（虚构）", "score": "78–77（虚构）"},
        "video": {"url": "/media/demo.mp4", "duration": 36, "width": 1280, "height": 720},
        "metric_definitions": {
            "xfg_pct": "Shot xFG%：单次出手的预测命中概率（0–1）；本演练为合成输入值，不是现场识别结果、期望得分或实际命中率。",
            "gravity": "Gravity：来源提供的牵制指标，保留来源单位；本演练为合成输入值，不由最近防守者距离计算，不能作为得分因果证据。",
            "leverage": "本演练口径：回合胜率机会差（0–1）；为合成输入值，不是该回合实际胜率变化，也不是球员 -10…+10 累计 Leverage Score。正式数据必须按数据字典做语义适配，不能仅改名或缩放。",
        },
        "metric_semantics": {"xfg_pct": "shot_make_probability", "gravity": "supplied_metric", "leverage": "possession_win_probability_opportunity"},
        "possessions": [
            create_possession(0, "HOU", "H3", "made", 3, {"xfg_pct": 0.38, "gravity": 1.8, "leverage": 0.82}),
            create_possession(1, "DAL", "D2", "missed", 2, {"xfg_pct": 0.71, "gravity": 1.2, "leverage": 0.20}),
            create_possession(2, "HOU", "H5", "made", 3, {"xfg_pct": 0.62, "gravity": 2.4, "leverage": 0.44}),
        ],
    }


if __name__ == "__main__":
    destination = ROOT / "data" / "demo.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(build_demo(), ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(destination)
