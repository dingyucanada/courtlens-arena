import copy
import unittest
from tools.import_game_context import context_from_espn


class GameContextTest(unittest.TestCase):
    def setUp(self):
        self.data = {"header": {"id": "401705026", "season": {"year": 2025, "type": 2}, "competitions": [{"competitors": [{"homeAway": "away", "team": {"abbreviation": "DAL"}}, {"homeAway": "home", "team": {"abbreviation": "HOU"}}]}]},
            "boxscore": {"players": [{"team": {"abbreviation": "DAL"}, "statistics": [{"athletes": [
                {"athlete": {"id": "1", "displayName": "Player A", "jersey": "2"}, "didNotPlay": False},
                {"athlete": {"id": "2", "displayName": "Player B"}, "didNotPlay": True}]}]}]},
            "plays": [{"id": "event1", "period": {"number": 1}, "clock": {"displayValue": "11:40"},
                "text": "Player A makes tip shot", "awayScore": 2, "homeScore": 0}]}

    def build(self, data=None):
        return context_from_espn(data or self.data, event_id="401705026", game_id="0022400460",
            game_date="2025-01-01", retrieved_at="2026-09-30T00:00:00Z")

    def test_background_keeps_game_clock_and_never_invents_video_time_or_metrics(self):
        result = self.build()
        self.assertEqual(result["gameDate"], "2025-01-01")
        self.assertEqual(result["playByPlay"]["source"]["awayTeamId"], "DAL")
        self.assertEqual(result["playByPlay"]["source"]["homeTeamId"], "HOU")
        self.assertEqual(result["seasonId"], "2024-25")
        self.assertEqual(len(result["roster"]), 1)
        event = result["playByPlay"]["entries"][0]
        self.assertEqual(event["clock"], "11:40")
        self.assertNotIn("start", event)
        self.assertNotIn("metrics", result)

    def test_missing_or_ambiguous_team_order_rejected(self):
        data = copy.deepcopy(self.data)
        data["header"]["competitions"] = []
        with self.assertRaises(ValueError):
            self.build(data)

    def test_wrong_game_cannot_be_attached(self):
        data = copy.deepcopy(self.data)
        data["header"]["id"] = "401999999"
        with self.assertRaises(ValueError):
            self.build(data)

    def test_duplicate_stat_sections_do_not_duplicate_players(self):
        data = copy.deepcopy(self.data)
        data["boxscore"]["players"][0]["statistics"] *= 2
        self.assertEqual(len(self.build(data)["roster"]), 1)


if __name__ == "__main__":
    unittest.main()
