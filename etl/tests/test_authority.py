"""Unit tests for etl/build_authority.py on hand-built graphs.

Run: uv run python -m unittest discover -s etl/tests -p "test_authority.py"
"""

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import build_authority as ba  # noqa: E402


def fixture_conn():
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE opinions (
            id INTEGER PRIMARY KEY, cluster_id INTEGER, court_id TEXT,
            date_filed TEXT, case_name TEXT, case_name_short TEXT,
            precedential_status TEXT, citation_count INTEGER,
            author_id INTEGER, author_str TEXT, type TEXT,
            page_count INTEGER, ocr INTEGER, blocked INTEGER, text TEXT);
        CREATE TABLE cites (
            citing_id INTEGER NOT NULL, cited_id INTEGER NOT NULL,
            depth INTEGER, char_pos INTEGER, context TEXT);
        CREATE TABLE authority (
            opinion_id INTEGER PRIMARY KEY, pagerank REAL,
            recent_cites_2y INTEGER, treatment_flags INTEGER);
    """)
    conn.executemany(
        "INSERT INTO opinions(id, date_filed, case_name) VALUES (?,?,?)",
        [(1, "2020-01-01", "Older v. Anchor"),
         (2, "2025-06-01", "Recent v. Two"),
         (3, "2024-07-15", "Cutoff v. Three"),
         (4, "2019-05-05", "Ancient v. Four"),
         (5, "2026-01-02", "Newest v. Five")])
    conn.executemany(
        "INSERT INTO cites VALUES (?,?,?,?,?)",
        [(2, 1, None, None, None),
         (3, 1, None, None, None),
         (3, 2, None, None, None),
         (4, 3, None, None, None),
         (5, 1, None, None, "It is overruled by later authority."),
         (5, 1, None, None, "duplicate pair"),
         (4, 999, None, None, None),          # orphan: cited missing
         (998, 1, None, None, None),          # orphan: citing missing
         (5, 4, None, None, "But see Ancient v. Four.")])
    return conn


class TestAuthority(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.outdir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _run_all(self):
        conn = fixture_conn()
        try:
            ba.scan_stage(conn, outdir=self.outdir)
            ba.pagerank_stage(conn, outdir=self.outdir)
            ba.write_stage(conn, outdir=self.outdir)
        finally:
            conn.close()

    def _authority(self):
        conn = fixture_conn()
        ba.scan_stage(conn, outdir=self.outdir)
        ba.pagerank_stage(conn, outdir=self.outdir)
        ba.write_stage(conn, outdir=self.outdir)
        rows = dict(
            (r[0], r[1:]) for r in
            conn.execute("SELECT opinion_id, pagerank, recent_cites_2y,"
                         " treatment_flags FROM authority"))
        conn.close()
        return rows

    def test_scan_dedupes_and_drops_orphans(self):
        conn = fixture_conn()
        try:
            ba.scan_stage(conn, outdir=self.outdir)
        finally:
            conn.close()
        src, dst = ba.load_edges(self.outdir)
        pairs = set(zip(src.tolist(), dst.tolist()))
        expected = {(2, 1), (3, 1), (3, 2), (4, 3), (5, 1), (5, 4)}
        self.assertEqual(pairs, expected)

    def test_pagerank_mass_one_and_anchor_is_max(self):
        conn = fixture_conn()
        try:
            ba.scan_stage(conn, outdir=self.outdir)
        finally:
            conn.close()
        nodes, _ = ba.load_opinions(fixture_conn())
        src, dst = ba.load_edges(self.outdir)
        r, iters = ba.pagerank_arrays(nodes, src, dst, tol=1e-6)
        self.assertAlmostEqual(float(r.sum()), 1.0, places=6)
        # node 1 receives three citations -> highest rank
        self.assertEqual(int(nodes[int(r.argmax())]), 1)
        self.assertGreater(iters, 0)

    def test_recency_cutoff_respected(self):
        rows = self._authority()
        # citing dates >= 20240630: 2->1, 3->1, 3->2, 5->1, 5->4
        self.assertEqual(rows[1][1], 3)
        self.assertEqual(rows[2][1], 1)
        self.assertEqual(rows[4][1], 1)
        self.assertEqual(rows[3][1], 0)

    def test_treatment_flags_bits(self):
        rows = self._authority()
        self.assertEqual(rows[1][2] & 1, 1)      # overruled
        self.assertEqual(rows[4][2] & 8, 8)      # but see
        self.assertEqual(rows[2][2], 0)
        self.assertEqual(rows[3][2], 0)

    def test_no_authority_rows_for_non_opinions(self):
        rows = self._authority()
        self.assertEqual(set(rows), {1, 2, 3, 4, 5})

    def test_pagerank_mass_written_sums_to_one(self):
        conn = fixture_conn()
        ba.scan_stage(conn, outdir=self.outdir)
        ba.pagerank_stage(conn, outdir=self.outdir)
        ba.write_stage(conn, outdir=self.outdir)
        total = conn.execute("SELECT sum(pagerank) FROM authority").fetchone()[0]
        self.assertAlmostEqual(total, 1.0, places=6)

    def test_scan_resume_is_idempotent(self):
        conn = fixture_conn()
        ba.scan_stage(conn, outdir=self.outdir)
        n1 = len(ba.load_edges(self.outdir))
        ba.scan_stage(conn, outdir=self.outdir)  # rerun: rowid checkpoint skips all
        n2 = len(ba.load_edges(self.outdir))
        self.assertEqual(n1, n2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
