"""Raw provider-row mapping regressions; no fixture is official-data acceptance."""
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core.broadcast.common import BroadcastError
from core.broadcast.metric_intake import convert, inspect_source, preview
from core.broadcast.store import BroadcastStore
from core.broadcast.validation import metric_bundle


class MetricIntakeTest(unittest.TestCase):
    def setUp(self):
        self.project = {"id": "project1", "revision": 4, "title": "原始字段演练",
                        "media": {"sha256": "a" * 64, "duration": 48}, "observations": [],
                        "context": {"gameId": "game1", "seasonId": "season1", "offenseTeamId": "team1",
                                    "roster": [{"id": "player1", "teamId": "team1"}, {"id": "player2", "teamId": "team2"}]}}
        self.dictionary = {"id": "test-dictionary", "version": "source-version",
            "provenance": {"kind": "synthetic", "source": "unit-test, not official", "extra": "preserved"},
            "metrics": {"gravity": {"version": "definition-version", "label": "示例原始指标",
                "role": "gravity", "semantics": "provider_on_ball_gravity_index", "unit": "provider-index",
                "definition": "测试定义；不能推断官方语义。", "granularity": "event", "ballState": "on-ball"}}}
        self.row = {"rid": "r1", "metric": "gravity", "value": 2.5, "event": "e1", "player": "player1",
                    "observed": 12, "available": 14, "unit": "provider-index", "game": "game1"}
        self.request = {"format": "json", "text": json.dumps([self.row]), "dictionary": self.dictionary,
            "mapping": {"recordId": "rid", "metricId": "metric", "value": "value", "eventId": "event",
                        "playerId": "player", "observedAt": "observed", "availableAt": "available",
                        "unit": "unit", "gameId": "game"}, "granularity": "event", "timeBase": "video"}
        self.frames = [{"id": "f1", "mediaSha256": "a" * 64, "sha256": "b" * 64, "actualTime": 10},
                       {"id": "f2", "mediaSha256": "a" * 64, "sha256": "c" * 64, "actualTime": 15}]

    def run_rows(self, rows):
        self.request["text"] = json.dumps(rows)
        return preview(self.project, self.request, self.frames)

    def test_preserves_exact_dictionary_provenance_raw_row_and_source_hash_without_editing(self):
        before = copy.deepcopy((self.project, self.request, self.frames))
        result = convert(self.project, self.request, self.frames)
        self.assertEqual((self.project, self.request, self.frames), before)
        self.assertEqual(result["status"], "proposal")
        self.assertEqual(result["counts"], {"source": 1, "accepted": 1, "rejected": 0})
        bundle = result["bundle"]
        self.assertEqual(bundle["dictionary"], self.dictionary)
        self.assertNotIn("provenance", bundle)
        self.assertEqual(bundle["plays"], [{"id": "metric-source", "gameId": "game1", "start": 0, "end": 48}])
        record = bundle["records"][0]
        self.assertEqual(record["value"], 2.5)
        self.assertEqual(record["unit"], "provider-index")
        self.assertEqual(record["intake"]["rawRow"], self.row)
        self.assertEqual(record["intake"]["sourceSha256"], hashlib.sha256(self.request["text"].encode()).hexdigest())
        self.assertEqual(bundle["intakeAudit"]["mapping"], self.request["mapping"])
        self.assertEqual(bundle["intakeAudit"]["sourceSha256"], record["intake"]["sourceSha256"])
        self.assertIn("dictionarySha256", bundle["intakeAudit"])
        self.assertEqual(set(bundle["intakeAudit"]) & {"sourceName", "sourceSha256", "dictionarySha256",
                         "mapping", "timeBase", "granularity", "clockAlignment"},
                         {"sourceName", "sourceSha256", "dictionarySha256", "mapping", "timeBase", "granularity", "clockAlignment"})
        metric_bundle(bundle)

    def test_rejects_wrong_players_games_units_and_seasons_individually(self):
        bad = []
        for number, (key, value) in enumerate((("player", "unknown"), ("game", "wrong-game"),
                                               ("unit", "percent"), ("season", "wrong-season")), 2):
            row = copy.deepcopy(self.row)
            row.update({"rid": "r" + str(number), "event": "e" + str(number), key: value, "season": row.get("season", "season1")})
            if key == "season":
                row["season"] = value
            bad.append(row)
        self.request["mapping"]["seasonId"] = "season"
        good = {**self.row, "season": "season1"}
        result = self.run_rows([good] + bad)
        self.assertEqual(result["status"], "partial")
        self.assertEqual([r["code"] for r in result["rejectedRows"]],
                         ["metric_player_mismatch", "metric_game_mismatch", "metric_unit_mismatch", "metric_season_mismatch"])
        self.assertEqual([r["id"] for r in result["bundle"]["records"]], ["r1"])

    def test_shot_mapping_keeps_original_percent_value_and_rejects_out_of_scale(self):
        self.dictionary["metrics"] = {"xfg": {"version": "test-only", "label": "示例出手概率",
            "role": "difficulty", "semantics": "shot_make_probability", "unit": "percent",
            "definition": "仅合成演练，不是正式官方数值。", "granularity": "shot",
            "transforms": {"probability": "percent-to-probability"}}}
        self.request["granularity"] = "shot"
        self.request["mapping"]["shotId"] = self.request["mapping"].pop("eventId")
        good = {**self.row, "metric": "xfg", "unit": "percent", "value": 62, "event": "shot1"}
        result = self.run_rows([good, {**good, "rid": "r2", "event": "shot2", "value": 101}])
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["bundle"]["records"][0]["value"], 62)
        self.assertEqual(result["bundle"]["records"][0]["scope"]["shotId"], "shot1")
        self.assertEqual(result["rejectedRows"][0]["code"], "metric_value_out_of_range")

    def test_existing_project_storage_retains_bundle_mapping_audit_and_raw_record(self):
        bundle = preview(self.project, self.request)["bundle"]
        project = {**copy.deepcopy(self.project), "metrics": bundle}
        with tempfile.TemporaryDirectory() as temp:
            store = BroadcastStore(temp)
            store.write(project)
            reloaded = store.read(project["id"])
        self.assertEqual(reloaded["metrics"]["intakeAudit"], bundle["intakeAudit"])
        self.assertEqual(reloaded["metrics"]["records"][0]["intake"]["rawRow"], self.row)
        metric_bundle(reloaded["metrics"])

    def test_missing_unit_or_dictionary_provenance_blocks_all_conversion(self):
        for key in ("unit", "definition"):
            with self.subTest(key=key):
                request = copy.deepcopy(self.request)
                del request["dictionary"]["metrics"]["gravity"][key]
                result = preview(self.project, request)
                self.assertEqual(result["status"], "blocked")
                self.assertIsNone(result["bundle"])
                self.assertFalse(result["validation"]["ok"])
                self.assertIn(key, result["validation"]["error"]["message"])
        request = copy.deepcopy(self.request)
        del request["dictionary"]["provenance"]
        self.assertIsNone(preview(self.project, request)["bundle"])

    def test_season_definition_cannot_be_relabelled_event(self):
        self.dictionary["metrics"]["gravity"]["granularity"] = "season"
        result = self.run_rows([self.row])
        self.assertEqual(result["rejectedRows"][0]["code"], "metric_scope_mismatch")
        self.assertEqual(result["counts"]["accepted"], 0)
        self.assertEqual(result["status"], "blocked")
        self.request["granularity"] = "season"
        with self.assertRaises(BroadcastError) as error:
            preview(self.project, self.request)
        self.assertEqual(error.exception.code, "metric_scope_mismatch")

    def test_unknown_availability_stays_null_with_warning_and_never_copies_observed_at(self):
        for mode in ("null-cell", "null-mapping", "blank-cell"):
            with self.subTest(mode=mode):
                request = copy.deepcopy(self.request)
                row = copy.deepcopy(self.row)
                row["available"] = "" if mode == "blank-cell" else None
                if mode == "null-mapping":
                    request["mapping"]["availableAt"] = None
                request["text"] = json.dumps([row])
                result = preview(self.project, request)
                self.assertEqual(result["bundle"]["records"][0]["time"],
                                 {"timeBase": "video", "observedAt": 12, "availableAt": None})
                self.assertIn("availability_unknown", result["acceptedRows"][0]["warnings"])
        del self.request["mapping"]["availableAt"]
        with self.assertRaises(BroadcastError):
            preview(self.project, self.request)

    def test_duplicate_ids_and_same_scope_conflicts_reject_every_member(self):
        for same_id in (True, False):
            with self.subTest(same_id=same_id):
                duplicate = {**self.row, "value": 9, "rid": "r1" if same_id else "r2"}
                result = self.run_rows([self.row, duplicate])
                self.assertEqual(result["status"], "blocked")
                self.assertEqual(result["counts"], {"source": 2, "accepted": 0, "rejected": 2})
                self.assertEqual({row["code"] for row in result["rejectedRows"]}, {"metric_duplicate_conflict"})
        # An invalid second row cannot make keeping the first duplicate ID safe.
        result = self.run_rows([self.row, {**self.row, "unit": "wrong"}])
        self.assertEqual(result["counts"]["accepted"], 0)

    def test_distinct_event_identity_at_same_clock_is_not_deduplicated(self):
        result = self.run_rows([self.row, {**self.row, "rid": "r2", "event": "e2"}])
        self.assertEqual(result["counts"]["accepted"], 2)
        self.assertEqual(result["status"], "proposal")

    def test_csv_values_parse_as_literals_preserve_zero_missing_and_formula_text(self):
        self.request["format"] = "csv"
        self.request["text"] = ("rid,metric,value,event,player,observed,available,unit,game,note\r\n"
            "r1,gravity,0,e1,player1,12,,provider-index,game1,=SUM(1+2)\r\n"
            "r2,gravity,,e2,player1,13,,provider-index,game1,missing\r\n"
            "r3,gravity,=1+2,e3,player1,14,14,provider-index,game1,formula\r\n"
            "r4,gravity,NaN,e4,player1,15,15,provider-index,game1,nonfinite\r\n")
        result = preview(self.project, self.request)
        self.assertEqual([r["value"] for r in result["bundle"]["records"]], [0, None])
        self.assertEqual(result["bundle"]["records"][0]["intake"]["rawRow"]["note"], "=SUM(1+2)")
        self.assertEqual(result["counts"], {"source": 4, "accepted": 2, "rejected": 2})
        self.assertEqual({r["code"] for r in result["rejectedRows"]}, {"metric_number_invalid"})
        self.assertEqual(result["audit"]["sourceSha256"], hashlib.sha256(self.request["text"].encode()).hexdigest())

    def test_malformed_csv_row_rejected_individually_and_header_or_quotes_fail_source(self):
        self.request["format"] = "csv"
        self.request["text"] = ("rid,metric,value,event,player,observed,available,unit,game\n"
            "r1,gravity,2,e1,player1,12,14,provider-index,game1\n"
            "r2,gravity,3\n")
        result = preview(self.project, self.request)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["rejectedRows"][0]["code"], "metric_row_malformed")
        self.assertEqual(result["rejectedRows"][0]["rowNumber"], 3)
        for text in ('id,id\na,b\n', 'id,value\n"unterminated,2\n', 'id,\na,2\n'):
            with self.subTest(text=text), self.assertRaises(BroadcastError):
                inspect_source("csv", text)

    def test_json_nonfinite_duplicate_keys_booleans_and_number_strings_never_become_measurements(self):
        for value in (True, "2.5", "=1+2"):
            result = self.run_rows([{**self.row, "value": value}])
            self.assertEqual(result["rejectedRows"][0]["code"], "metric_number_invalid")
        for text in ('[{"value":NaN}]', '[{"value":Infinity}]', '[{"value":1e999}]', '[{"value":1,"value":2}]'):
            with self.subTest(text=text), self.assertRaises(BroadcastError):
                inspect_source("json", text)

    def test_separate_clock_mappings_for_observed_available_and_validity(self):
        self.request["timeBase"] = "game-clock"
        self.request["clockAlignment"] = {"segmentId": "s1", "period": 3,
            "anchors": [{"frameId": "f1", "clock": "07:43"}, {"frameId": "f2", "clock": "07:38"}]}
        self.request["mapping"].update({"validFrom": "from", "validTo": "to"})
        row = {**self.row, "observed": "07:41", "available": "07:39", "from": "07:41", "to": "07:38"}
        before = copy.deepcopy((self.project, self.frames, self.request))
        result = self.run_rows([row])
        self.assertEqual((self.project, self.frames), before[:2])
        record = result["bundle"]["records"][0]
        self.assertEqual(record["time"], {"timeBase": "video", "observedAt": 12,
                                        "availableAt": 14, "validFrom": 12, "validTo": 15})
        evidence = record["intake"]["clockMappings"]
        self.assertEqual(set(evidence), {"observedAt", "availableAt", "validFrom", "validTo"})
        self.assertEqual(evidence["availableAt"]["mapping"]["clock"], "07:39")
        self.assertEqual(evidence["observedAt"]["mapping"]["mappingEvidenceIds"], ["f1", "f2"])
        row["available"] = None
        result = self.run_rows([row])
        self.assertIsNone(result["bundle"]["records"][0]["time"]["availableAt"])
        self.assertNotIn("availableAt", result["bundle"]["records"][0]["intake"]["clockMappings"])

    def test_ambiguous_clock_and_replay_segment_fail_closed(self):
        self.request["timeBase"] = "game-clock"
        self.request["clockAlignment"] = {"segmentId": "s1", "period": 3,
            "anchors": [{"frameId": "f1", "clock": "07:43"}, {"frameId": "f2", "clock": "07:43"}]}
        row = {**self.row, "observed": "07:41", "available": "07:39"}
        result = self.run_rows([row])
        self.assertEqual(result["rejectedRows"][0]["code"], "clock_ambiguous")
        self.request["clockAlignment"]["anchors"][1]["clock"] = "07:38"
        self.request["mapping"].update({"period": "period", "segmentId": "segment"})
        result = self.run_rows([{**row, "period": 3, "segment": "replay"}])
        self.assertEqual(result["rejectedRows"][0]["code"], "clock_ambiguous")
        result = self.run_rows([{**row, "period": 4, "segment": "s1"}])
        self.assertEqual(result["rejectedRows"][0]["code"], "clock_ambiguous")

    def test_unknown_columns_game_missing_and_implicit_time_base_rejected(self):
        for field, value in (("timeBase", None), ("granularity", "season")):
            request = copy.deepcopy(self.request)
            request[field] = value
            with self.assertRaises(BroadcastError):
                preview(self.project, request)
        self.request["mapping"]["value"] = "does-not-exist"
        with self.assertRaises(BroadcastError):
            preview(self.project, self.request)
        self.request["mapping"]["value"] = "value"
        self.project["context"]["gameId"] = None
        with self.assertRaises(BroadcastError) as error:
            preview(self.project, self.request)
        self.assertEqual(error.exception.code, "metric_game_missing")

    def test_out_of_video_and_invalid_validity_rejected_without_offsets(self):
        self.request["mapping"].update({"validFrom": "from", "validTo": "to"})
        result = self.run_rows([{**self.row, "observed": 49, "from": 12, "to": 15},
                               {**self.row, "rid": "r2", "event": "e2", "from": 15, "to": 12}])
        self.assertEqual([r["code"] for r in result["rejectedRows"]],
                         ["metric_time_outside_video", "metric_time_invalid"])
        self.assertEqual(result["counts"]["accepted"], 0)

    def test_final_v2_validation_is_mandatory_and_failure_returns_no_bundle(self):
        with patch("core.broadcast.metric_intake.validation.metric_bundle",
                   side_effect=[True, BroadcastError("schema_invalid", "final v2 rejected", 422)]) as validator:
            result = preview(self.project, self.request)
        self.assertEqual(validator.call_count, 2)
        self.assertEqual(result["status"], "blocked")
        self.assertIsNone(result["bundle"])
        self.assertFalse(result["validation"]["ok"])
        self.assertIn("final v2 rejected", result["validation"]["error"]["message"])

    def test_inspection_uses_exact_columns_bom_hash_and_reports_bad_row(self):
        text = '\ufeffID,Original Units\r\na,percent\r\nb\r\n'
        result = inspect_source("csv", text)
        self.assertEqual(result["columns"], ["ID", "Original Units"])
        self.assertEqual(result["rowCount"], 2)
        self.assertEqual(result["sourceSha256"], hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(result["malformedRows"][0]["rowNumber"], 3)
        self.assertNotIn("mapping", result)

    def test_cli_only_writes_new_report_and_refuses_existing_project_as_output(self):
        tool = Path(__file__).resolve().parents[1] / "tools" / "prepare_broadcast_metrics.py"
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "raw.csv"
            source.write_bytes(b"id,value\r\nr1,3\r\n")
            report = Path(temp) / "report.json"
            command = [sys.executable, str(tool), str(source), "--format", "csv", "--output", str(report)]
            proc = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(report.read_text())["sourceSha256"], hashlib.sha256(source.read_bytes()).hexdigest())
            original = report.read_bytes()
            proc = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(proc.returncode, 2)
            self.assertEqual(report.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
