#!/usr/bin/env python3
"""Build optional, sourced same-game background; never infer video timestamps."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.broadcast.service import validate_play_by_play

MAX_BYTES = 5 * 1024 * 1024


def context_from_espn(data, *, event_id, game_id, game_date, period=1, limit=40, retrieved_at=None):
    if not re.fullmatch(r"[0-9]{6,12}", event_id):
        raise ValueError("ESPN event ID must be 6–12 digits")
    if str(data.get("header", {}).get("id")) != event_id:
        raise ValueError("ESPN response event ID does not match the requested game")
    datetime.strptime(game_date, "%Y-%m-%d")
    if not 1 <= period <= 20 or not 1 <= limit <= 40:
        raise ValueError("period or selected event limit is invalid")
    competitions = data.get("header", {}).get("competitions", [])
    competitors = competitions[0].get("competitors", []) if len(competitions) == 1 else []
    teams = {side: [row.get("team", {}).get("abbreviation") for row in competitors if row.get("homeAway") == side] for side in ("away", "home")}
    if any(len(values) != 1 or not isinstance(values[0], str) or not values[0] for values in teams.values()) or teams["away"][0] == teams["home"][0]:
        raise ValueError("Verified away/home team mapping is missing or ambiguous")
    source_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={event_id}"
    stamp = retrieved_at or datetime.now(timezone.utc).isoformat()
    roster = []
    seen = set()
    for team in data.get("boxscore", {}).get("players", []):
        team_id = team["team"]["abbreviation"]
        for section in team.get("statistics", []):
            for row in section.get("athletes", []):
                # A listed DNP is not proof the player appears in the video.
                if row.get("didNotPlay"):
                    continue
                athlete = row["athlete"]
                player_id = "espn-" + str(athlete["id"])
                if player_id in seen:
                    continue
                seen.add(player_id)
                roster.append({"id": player_id, "name": athlete["displayName"], "teamId": team_id,
                    "jersey": str(athlete["jersey"]) if athlete.get("jersey") is not None else None,
                    "source": source_url + " · 同场出场记录；号码仍需与历史画面核对", "validOn": game_date})
    if not roster:
        raise ValueError("No same-game played-player roster is available")
    entries = []
    for row in data.get("plays", []):
        if row.get("period", {}).get("number") != period:
            continue
        entries.append({"id": "espn-" + str(row["id"]), "period": period,
            "clock": row["clock"]["displayValue"], "text": row["text"],
            "awayScore": row["awayScore"], "homeScore": row["homeScore"]})
        if len(entries) == limit:
            break
    season = data.get("header", {}).get("season", {})
    year = season.get("year")
    context = {"gameId": game_id, "gameDate": game_date,
        "seasonId": f"{year-1}-{str(year)[-2:]}" if type(year) is int else None,
        "seasonType": {1: "Preseason", 2: "Regular Season", 3: "Playoffs"}.get(season.get("type")),
        "offenseTeamId": None, "roster": roster,
        "playByPlay": {"source": {"provider": "ESPN", "url": source_url, "retrievedAt": stamp,
            "gameId": game_id, "awayTeamId": teams["away"][0], "homeTeamId": teams["home"][0]}, "entries": entries}}
    validate_play_by_play(context["playByPlay"], game_id)
    return context


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--espn-event-id", required=True)
    parser.add_argument("--game-id", required=True, help="Verified NBA/organizer game ID; not guessed from ESPN ID")
    parser.add_argument("--game-date", required=True, help="Verified game-local date YYYY-MM-DD; UTC date may differ")
    parser.add_argument("--period", type=int, default=1)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--input", type=Path, help="Previously retrieved ESPN summary JSON, for reproducibility")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]{6,12}", args.espn_event_id):
        parser.error("ESPN event ID must be 6–12 digits")
    if args.input:
        if args.input.stat().st_size > MAX_BYTES:
            parser.error("Source JSON exceeds 5 MiB")
        raw = args.input.read_bytes()
        retrieved = datetime.fromtimestamp(args.input.stat().st_mtime, timezone.utc).isoformat()
    else:
        url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=" + args.espn_event_id
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=25) as response:
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            parser.error("Response exceeds 5 MiB")
        retrieved = datetime.now(timezone.utc).isoformat()
    result = context_from_espn(json.loads(raw), event_id=args.espn_event_id, game_id=args.game_id,
        game_date=args.game_date, period=args.period, limit=args.limit, retrieved_at=retrieved)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "players": len(result["roster"]),
        "backgroundEvents": len(result["playByPlay"]["entries"]), "videoTimeMapping": "none",
        "officialAdvancedMetrics": "none"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
