"""Independent standard-library regressions for intake and evidence contracts.

Run: PYTHONDONTWRITEBYTECODE=1 python3 tests/independent_core.py -v
No Pillow, server socket, cloud credentials, or media rewriting is required.
"""
import copy
import json
from pathlib import Path
import sys
import unittest

APP = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(APP), str(APP / "tools")]
from core.adapters import blank_dataset, import_csv
from core.engine import analyze
from core.model_agent import direct, ModelAgentError
from core.quality import quality_report
from core.validation import validate_dataset, ValidationError

DEMO = json.loads((APP / "data/demo.json").read_text())
CSV = "id,title,start,end,shot_time,result_time,offense,shooter,points,result,xfg_pct,gravity,leverage\np01,输入事件,0,12,9,10.5,HOU,A,3,made,0.38,,\n"


def dataset(manual=False, calibrated=True, no_tracks=True):
    d = copy.deepcopy(DEMO)
    p = d["possessions"][0]
    p["annotations"] = [{
        "id": "audit-zone", "kind": "zone", "start": 2, "end": 10,
        "points": [[.62, .40], [.78, .40], [.78, .58], [.62, .58]],
        "label": "独立检查区", "evidence_id": "p01:audit-zone"
    }]
    if manual:
        p["annotations"][0].update(origin="manual", frame_reviewed=True, author_note="审计输入：人工核对静态位置")
    if no_tracks:
        p["tracks"] = []
    p["camera_segments"] = [{"id": "audit-camera", "start": 0, "end": 12, "calibrated": calibrated}]
    return d


def without_annotations(d):
    d = copy.deepcopy(d)
    d["possessions"][0]["annotations"] = []
    return d


class IntakeAndValidation(unittest.TestCase):
    def parse(self, text=CSV, **kwargs):
        return import_csv(text, DEMO["video"], DEMO["game"], "本地审计来源", **kwargs)["dataset"]

    def test_csv_missing_metrics_stay_null_and_zero_is_real_zero(self):
        p = self.parse()["possessions"][0]
        self.assertIsNone(p["metrics"]["gravity"])
        self.assertIsNone(p["metrics"]["leverage"])
        self.assertEqual(self.parse(CSV.replace("0.38,,", "0,0,"))["possessions"][0]["metrics"]["gravity"], 0)

    def test_csv_refuses_unconfirmed_leverage(self):
        text = CSV.replace("0.38,,", "0.38,,0.5")
        with self.assertRaises(ValidationError):
            self.parse(text)
        self.assertEqual(self.parse(text, leverage_semantics="possession_win_probability_opportunity")["possessions"][0]["metrics"]["leverage"], .5)

    def test_csv_does_not_rescale_percent_or_accept_nan(self):
        for value in ("38", "NaN", "Infinity"):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                self.parse(CSV.replace("0.38", value))

    def test_source_csv_row_number_survives(self):
        self.assertIn("CSV记录结束于物理行 2", self.parse()["possessions"][0]["source_refs"][0])

    def test_source_csv_row_does_not_miscount_blank_lines(self):
        header, record = CSV.split("\n", 1)
        refs = self.parse(header + "\n\n" + record)["possessions"][0]["source_refs"]
        self.assertTrue(any("CSV记录结束于物理行 3" in r for r in refs), refs)

    def test_csv_validation_error_locates_record_after_blank_line(self):
        header, record = CSV.split("\n", 1)
        with self.assertRaises(ValidationError) as caught:
            self.parse(header + "\n\n" + record.replace("0.38", "38"))
        self.assertIn("csv.row[3]", str(caught.exception))

    def test_quoted_multiline_csv_records_report_their_real_ending_lines(self):
        header = CSV.split("\n", 1)[0]
        text = header + '\np01,"第一行\n第二行",0,12,9,10.5,HOU,A,3,made,0.38,,\n\np02,下一回合,12,24,21,22.5,DAL,B,2,missed,0.71,,\n'
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)):
                rows = self.parse(text.replace("\n", newline))["possessions"]
                self.assertIn("第一行", rows[0]["title"])
                self.assertIn("第二行", rows[0]["title"])
                self.assertIn("CSV记录结束于物理行 3", rows[0]["source_refs"][0])
                self.assertIn("CSV记录结束于物理行 5", rows[1]["source_refs"][0])

    def test_quoted_multiline_csv_errors_use_the_record_ending_line(self):
        header = CSV.split("\n", 1)[0]
        first = 'p01,"第一行\n第二行",0,12,9,10.5,HOU,A,3,made,0.38,,\n'
        second = 'p02,下一回合,12,24,21,22.5,DAL,B,2,missed,0.71,,\n'
        # Number parsing fails while reading record 1; schema range validation
        # fails after all records have been read, so both mapping paths matter.
        cases = [(first.replace("0.38", "NaN") + "\n" + second, 3),
                 (first + "\n" + second.replace("0.71", "71"), 5)]
        for records, physical_line in cases:
            with self.subTest(physical_line=physical_line), self.assertRaises(ValidationError) as caught:
                self.parse(header + "\n" + records)
            self.assertIn(f"csv.row[{physical_line}]", str(caught.exception))

    def test_blank_draft_and_reviewed_placeholders_both_block(self):
        d = blank_dataset(DEMO["video"], DEMO["game"], "本地审计来源")
        self.assertFalse(quality_report(d)["export_allowed"])
        d["workflow"]["state"] = "reviewed"
        self.assertFalse(quality_report(d)["export_allowed"])

    def test_reviewed_sparse_intake_can_export_with_explicit_warnings(self):
        d = self.parse()
        d["workflow"]["state"] = "reviewed"
        q = quality_report(d)
        self.assertTrue(q["export_allowed"])
        self.assertEqual(q["status"], "needs_review")
        self.assertEqual(q["metrics"]["possessions_without_tracks"], 1)

    def test_manual_annotation_requires_nonempty_author_note(self):
        for value in (None, "", " "):
            d = dataset(manual=True)
            if value is None:
                del d["possessions"][0]["annotations"][0]["author_note"]
            else:
                d["possessions"][0]["annotations"][0]["author_note"] = value
            with self.subTest(value=value), self.assertRaises(ValidationError):
                validate_dataset(d)

    def test_manual_source_is_distinct_from_tracking(self):
        p = analyze(dataset(manual=True))["possessions"][0]
        e = next(e for e in p["evidence"] if e["id"] == "p01:audit-zone")
        self.assertIn("人工", e["source"])
        self.assertIn("不代表自动跟踪", e["source"])

    def test_manual_annotation_requires_explicit_frame_review(self):
        for value in (None, False, "true", 1):
            d = dataset(manual=True)
            if value is None:
                del d["possessions"][0]["annotations"][0]["frame_reviewed"]
            else:
                d["possessions"][0]["annotations"][0]["frame_reviewed"] = value
            with self.subTest(value=value), self.assertRaises(ValidationError):
                validate_dataset(d)

    def test_manual_annotation_cannot_cross_a_real_camera_cut(self):
        d = dataset(manual=True)
        d["possessions"][0]["camera_segments"] = [
            {"id": "first", "start": 0, "end": 6, "calibrated": True},
            {"id": "second", "start": 6, "end": 12, "calibrated": True},
        ]
        with self.assertRaises(ValidationError):
            validate_dataset(d)

    def test_shot_at_end_is_rejected_but_result_at_end_allowed(self):
        d = copy.deepcopy(DEMO)
        p = d["possessions"][0]
        p["result_time"] = p["end"]
        validate_dataset(d)
        p["shot_time"] = p["end"]
        with self.assertRaises(ValidationError):
            validate_dataset(d)


class CloudEvidenceOrder(unittest.TestCase):
    @staticmethod
    def tool(name, ident, params):
        return {"toolUse": {"toolUseId": ident, "name": name, "input": params}}

    def test_first_turn_read_and_publish_both_orders_rejected(self):
        read = self.tool("read_evidence", "read", {})
        publish = self.tool("publish_plan", "publish", {"claim_ids": ["p01:claim:xfg"], "unsupported": False})
        for calls in ([read, publish], [publish, read]):
            class Provider:
                def converse(self, **kwargs):
                    return {"output": {"message": {"role": "assistant", "content": calls}}}
            with self.subTest(order=calls[0]["toolUse"]["name"]), self.assertRaises(ModelAgentError):
                direct(DEMO, "投篮概率", "p01", client=Provider(), model_id="audit-fake-only")

    def test_provider_receives_evidence_before_valid_publication(self):
        audit = self
        class Provider:
            def __init__(self): self.count = 0
            def converse(self, **kwargs):
                self.count += 1
                if self.count == 1:
                    call = audit.tool("read_evidence", "read", {})
                else:
                    result = kwargs["messages"][-1]["content"][0]["toolResult"]
                    claims = result["content"][0]["json"]["claims"]
                    audit.assertTrue(any(c["id"] == "p01:claim:xfg" for c in claims))
                    call = audit.tool("publish_plan", "publish", {"claim_ids": ["p01:claim:xfg"], "unsupported": False})
                return {"output": {"message": {"role": "assistant", "content": [call]}}}
        provider = Provider()
        r = direct(DEMO, "投篮概率", "p01", client=provider, model_id="audit-fake-only")
        self.assertEqual(provider.count, 2)
        self.assertIn("38.0%", r["answer"])



if __name__ == "__main__":
    unittest.main()
