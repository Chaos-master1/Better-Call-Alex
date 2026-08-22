"""G0 gate verification (CLAUDE.md §8).

Run after merge:
    uv run python etl/tests/test_g0.py

Gate criteria:
  1. Row counts within 10% of ~11.3M opinions
  2. alex lookup "410 U.S. 113" -> Roe v. Wade w/ court, date, cited-by count
  3. 20 hand-checked opinions: non-empty text + correct court
  4. clusters.docket_id -> dockets.court_id join coverage reported
"""

import json
import sqlite3
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "etl"))

from common import CORPUS_DB, DATA_REPORT  # noqa: E402

EXPECTED_OPINIONS = 11_300_000
TOLERANCE = 0.10

HAND_CHECKS = [
    # (citation, expected_case_name_fragment, expected_court_id)
    ("410 U.S. 113", "Roe", None),
    ("347 U.S. 483", "Brown", None),
    ("384 U.S. 436", "Miranda", None),
    ("372 U.S. 335", "Gideon", None),
    ("376 U.S. 254", "Times", None),
    ("5 U.S. 137", "Marbury", None),
    ("467 U.S. 837", "Chevron", None),
    ("491 U.S. 397", "Johnson", None),
    ("389 U.S. 347", "Katz", None),
    ("392 U.S. 1", "Terry", None),
    ("393 U.S. 503", "Tinker", None),
    ("395 U.S. 444", "Brandenburg", None),
    ("413 U.S. 15", "Miller", None),
    ("438 U.S. 265", "Bakke", None),
    ("539 U.S. 558", "Lawrence", None),
    ("558 U.S. 310", "Citizens United", None),
    ("554 U.S. 570", "Heller", None),
    ("381 U.S. 479", "Griswold", None),
    ("368 U.S. 57", "Mapp", None),
    ("163 U.S. 537", "Plessy", None),
]


def corpus() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{CORPUS_DB}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only=1")
    return conn


@unittest.skipUnless(CORPUS_DB.exists(), "corpus.sqlite not built yet")
class TestG0(unittest.TestCase):
    conn = None

    @classmethod
    def setUpClass(cls):
        if CORPUS_DB.exists():
            cls.conn = corpus()

    def tearDown(self):
        pass

    # ---- criterion 1: scale -------------------------------------------------

    def test_row_counts_within_tolerance(self):
        n = self.conn.execute("SELECT count(*) FROM opinions").fetchone()[0]
        lo = EXPECTED_OPINIONS * (1 - TOLERANCE)
        hi = EXPECTED_OPINIONS * (1 + TOLERANCE)
        self.assertGreaterEqual(n, lo, f"opinions={n:,} below floor {lo:,.0f}")
        self.assertLessEqual(n, hi, f"opinions={n:,} above ceiling {hi:,.0f}")

    def test_supporting_tables_populated(self):
        checks = {
            "cites": 100_000_000,
            "citation_strings": 1_000_000,
            "courts": 500,
            "judges": 10_000,
        }
        for table, floor in checks.items():
            n = self.conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            self.assertGreater(n, floor, f"{table}={n:,} below floor {floor:,}")
        n = self.conn.execute("SELECT count(*) FROM parentheticals").fetchone()[0]
        self.assertGreater(n, 100_000)

    # ---- criterion 2: citation resolution ----------------------------------

    def test_roe_lookup(self):
        sys.path.insert(0, str(REPO / "app"))
        from cli import lookup  # noqa: E402
        from db import openCorpus  # noqa: E402

        appdb = openCorpus()
        try:
            r = lookup(appdb, "410 U.S. 113")
        finally:
            appdb.close()
        self.assertIsNotNone(r, "lookup failed")
        self.assertIn("Roe", r["case_name"])
        self.assertTrue(r["date_filed"], "missing date_filed")
        self.assertTrue(r["court_name"] or r["court_id"], "missing court")
        self.assertGreater(r["cited_by"], 10_000, f"cited_by={r['cited_by']} implausibly low")

    def test_fts_match_works(self):
        rows = self.conn.execute(
            """SELECT o.id, o.case_name FROM opinions_fts f
               JOIN opinions o ON o.id = f.rowid
               WHERE opinions_fts MATCH 'privacy AND abortion' LIMIT 3"""
        ).fetchall()
        self.assertEqual(len(rows), 3)

    # ---- criterion 3: hand-checked opinions --------------------------------

    def test_hand_checked_opinions(self):
        q = """
            SELECT o.id, o.case_name, o.court_id, c.name AS court_name,
                   length(o.text) AS tlen
            FROM citation_strings cs
            LEFT JOIN opinions o ON o.cluster_id = cs.cluster_id
            LEFT JOIN courts c ON c.id = o.court_id
            WHERE cs.volume=? AND cs.reporter=? AND cs.page=?
        """
        failures = []
        checked = 0
        for cite, name_frag, court_exp in HAND_CHECKS:
            parts = cite.split(" ")
            vol, page = parts[0], parts[-1]
            rep = " ".join(parts[1:-1])
            row = self.conn.execute(q, (str(int(vol)), rep, str(int(page)))).fetchone()
            if row is None:
                failures.append(f"{cite}: NOT RESOLVED")
                continue
            oid, case_name, court_id, court_name, tlen = row
            if oid is None:
                failures.append(f"{cite} ({name_frag}): no opinion joined")
            elif case_name is None or name_frag.lower() not in case_name.lower():
                failures.append(f"{cite}: case_name={case_name!r} lacks '{name_frag}'")
            elif not tlen or tlen < 500:
                failures.append(f"{cite}: text too short ({tlen})")
            elif court_id is None or court_name is None:
                failures.append(f"{cite}: court unresolved ({court_id})")
            elif court_exp and court_id != court_exp:
                failures.append(f"{cite}: court_id={court_id}, expected {court_exp}")
            else:
                checked += 1
                print(f"  ok {cite:>16}  {case_name[:60]:<60} court={court_id} text={tlen:,}ch")
        self.assertEqual(len(HAND_CHECKS), 20, "hand list must have 20 entries")
        self.assertFalse(failures, "hand-check failures:\n" + "\n".join(failures))
        self.assertGreaterEqual(checked, 20)

    def test_char_offsets_valid_sample(self):
        rows = self.conn.execute(
            """SELECT ci.citing_id, ci.char_pos FROM cites ci
               WHERE ci.char_pos IS NOT NULL LIMIT 200"""
        ).fetchall()
        bad = 0
        for citing, pos in rows:
            tlen = self.conn.execute(
                "SELECT length(text) FROM opinions WHERE id=?", (citing,)
            ).fetchone()
            if tlen is None or pos > tlen[0]:
                bad += 1
        self.assertEqual(bad, 0, f"{bad}/200 sampled char_pos exceed text length")

    # ---- criterion 4: join coverage report ----------------------------------

    def test_join_coverage_reported(self):
        self.assertTrue(DATA_REPORT.exists(), "g0-join-coverage.json missing")
        report = json.loads(DATA_REPORT.read_text())
        pct = report.get("join_coverage_pct")
        print(f"\n  docket->court join coverage: {pct}% "
              f"({report.get('court_id_resolved', 0):,}/{report.get('clusters_total', 0):,})")
        self.assertIsInstance(pct, float)


if __name__ == "__main__":
    unittest.main(verbosity=2)
