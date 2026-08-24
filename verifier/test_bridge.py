"""Unit tests for verifier/bridge.py (no DB, no network).

Run: uv run python -m unittest discover -s verifier -p "test_bridge.py"
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BRIDGE = Path(__file__).resolve().parent / "bridge.py"
PYTHON = sys.executable


def run_bridge(texts):
    proc = subprocess.run(
        [PYTHON, str(BRIDGE)],
        input=json.dumps({"texts": texts}),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise AssertionError(f"bridge exited {proc.returncode}: {proc.stderr[-400:]}")
    payload = json.loads(proc.stdout)
    if "error" in payload:
        raise AssertionError(f"bridge protocol error: {payload['error']}")
    return payload["results"]


class TestBridge(unittest.TestCase):
    def test_full_citation_groups(self):
        out = run_bridge(["See Roe v. Wade, 410 U.S. 113 (1973)."])[0]
        full = [c for c in out if c.get("type") == "full"]
        self.assertEqual(len(full), 1)
        c = full[0]
        self.assertEqual((c["volume"], c["reporter"], c["page"]), ("410", "U.S.", "113"))
        self.assertEqual(c["text"], "410 U.S. 113")
        self.assertLess(c["start"], c["end"])

    def test_pin_cite_captured(self):
        out = run_bridge(["Miranda v. Arizona, 384 U.S. 436, at 118."])[0]
        c = next(c for c in out if c.get("type") == "full")
        self.assertEqual(c["pin_cite"], "at 118")

    def test_id_and_short_forms_classified(self):
        out = run_bridge(
            ["Brown, 347 U.S. 483. Id. at 495. See also 410 U.S., at 150."]
        )[0]
        types = sorted(c["type"] for c in out)
        self.assertIn("id", types)

    def test_alias_reporter_normalized(self):
        # "S. Ct." parallel cite must normalize through reporters-db
        out = run_bridge(["See 384 U.S. 436, 86 S. Ct. 1602 (1966)."])[0]
        reporters = {c.get("reporter") for c in out if c.get("type") == "full"}
        self.assertIn("S. Ct.", reporters)

    def test_fabricated_still_extracts(self):
        # extraction is syntactic: a well-formed fake cite still parses.
        # Rejection happens later, at corpus resolution (verify.ts).
        out = run_bridge(["Smith v. Jones, 734 F.3d 999 (11th Cir. 2020)."])[0]
        c = next(c for c in out if c.get("type") == "full")
        self.assertEqual((c["volume"], c["reporter"], c["page"]), ("734", "F.3d", "999"))

    def test_no_citations_empty_list(self):
        out = run_bridge(["This draft contains no authority whatsoever."])[0]
        self.assertEqual(out, [])

    def test_batch_parallel_and_bad_entry_isolated(self):
        out = run_bridge([
            "Valid: 410 U.S. 113.",
            None,  # invalid entry must not kill the batch
            "Also valid: 384 U.S. 436.",
        ])
        self.assertEqual(len(out), 3)
        self.assertTrue(any("error" in c for c in out[1]))
        self.assertTrue(any(c.get("page") == "436" for c in out[2]))

    def test_protocol_error_nonzero_exit(self):
        proc = subprocess.run(
            [PYTHON, str(BRIDGE)],
            input=json.dumps({"wrong_key": []}),
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
