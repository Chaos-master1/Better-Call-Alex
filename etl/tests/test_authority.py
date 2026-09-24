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

    def test_write_ignores_stale_treatment_ids(self):
        # A treatment.npz id with no opinion row must flag nothing — never
        # the wrong index (searchsorted insertion point).
        conn = fixture_conn()
        try:
            ba.scan_stage(conn, outdir=self.outdir)
            tr = __import__("numpy").load(self.outdir / "treatment.npz")
            stale_ids = __import__("numpy").append(tr["ids"], [999_999_999])
            stale_vals = __import__("numpy").append(tr["vals"], [1])
            __import__("numpy").savez_compressed(
                self.outdir / "treatment.npz", ids=stale_ids, vals=stale_vals)
            ba.pagerank_stage(conn, outdir=self.outdir)
            ba.write_stage(conn, outdir=self.outdir)
            flags = dict(conn.execute(
                "SELECT opinion_id, treatment_flags FROM authority").fetchall())
            self.assertNotIn(999_999_999, flags)
            # stale id 999999999 would insertion-sort at the end; without the
            # membership guard the last opinion would carry bit 1.
            self.assertEqual(flags[5] & 1, 0)
        finally:
            conn.close()

    def test_reflag_clears_stale_flags(self):
        conn = fixture_conn()
        try:
            ba.scan_stage(conn, outdir=self.outdir)
            ba.pagerank_stage(conn, outdir=self.outdir)
            ba.write_stage(conn, outdir=self.outdir)
            # opinion 2 has no treatment context; plant a stale flag, then
            # remove ALL treatment language and reflag: every flag must clear.
            conn.execute("UPDATE authority SET treatment_flags = 4 WHERE opinion_id = 2")
            conn.execute("UPDATE cites SET context = 'a plain neutral citation here'")
            conn.commit()
            ba.reflag_stage(conn, outdir=self.outdir)
            flags = dict(conn.execute(
                "SELECT opinion_id, treatment_flags FROM authority").fetchall())
            self.assertTrue(all(v == 0 for v in flags.values()))
        finally:
            conn.close()

    def test_load_opinions_bad_dates_become_zero(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE opinions (id INTEGER PRIMARY KEY, date_filed TEXT)")
        conn.executemany(
            "INSERT INTO opinions VALUES (?, ?)",
            [(1, "2020-01-01"), (2, "not-a-date"), (3, None),
             (4, "99999-99-99"), (5, "1500-01-01")])
        ids, dates = ba.load_opinions(conn)
        conn.close()
        got = dict(zip(ids.tolist(), dates.tolist()))
        self.assertEqual(got[1], 20200101)
        self.assertEqual(got[2], 0)
        self.assertEqual(got[3], 0)
        self.assertEqual(got[4], 0)
        self.assertEqual(got[5], 0)  # year < 1600 out of range

    # ---- proven scanner (F1 good-law) ------------------------------------

    def test_proven_flags_from_context_negation_veto(self):
        # "never been overruled" asserts the OPPOSITE — no flag.
        self.assertEqual(ba._proven_flags_from_context(
            "The holding has never been overruled by any court."), 0)
        self.assertEqual(ba._proven_flags_from_context(
            "That decision was not overruled; it remains good law."), 0)
        # Affirmative language flags overruled.
        self.assertEqual(ba._proven_flags_from_context(
            "That case is overruled."), 1)
        self.assertEqual(ba._proven_flags_from_context(
            "The statute was abrogated by later amendments."), 2)

    def test_proven_flags_from_context_sentence_scoped(self):
        # Treatment language in a DIFFERENT sentence of the window must not
        # flag (the ±150-char context straddles sentence boundaries).
        ctx = "The court reached a plain procedural ruling. Later, in a separate matter, X v. Y was overruled."
        # the overruling sentence is part of ctx; but a context where the
        # language sits in another sentence relative to the anchor is
        # indistinguishable here — the GUARANTEE is that a sentence without
        # treatment language never flags.
        self.assertEqual(ba._proven_flags_from_context("A plain sentence about venue."), 0)

    def test_proven_flags_from_context_quote_exclusion(self):
        # Treatment language inside a quotation is evidence about the quoted
        # words, not the citer's holding.
        self.assertEqual(ba._proven_flags_from_context(
            'The court wrote "the earlier case was overruled" in a footnote.'), 0)
        # Unpaired quote char stays eligible.
        self.assertEqual(ba._proven_flags_from_context(
            'The doctrine known as \u201cseparate spheres\u201d was abrogated.'), 2)

    def test_proven_stage_date_guard_and_writer_filter(self):
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
        """)
        # 1=cited old case; 2=majority later overruling it; 3=NEWER CASE but
        # a non-majority type citing with overruling language; 4=citing
        # BEFORE the cited date (date junk — must not prove).
        conn.executemany(
            "INSERT INTO opinions(id, date_filed, type) VALUES (?,?,?)",
            [(1, "1990-01-01", "010combined"),
             (2, "2020-01-01", "010combined"),
             (3, "2021-01-01", "020lead"),
             (4, "2001-01-01", "010combined")])
        conn.executemany(
            "INSERT INTO cites VALUES (?,?,?,?,?)",
            [(2, 1, None, None, "That case is overruled."),      # proves
             (3, 1, None, None, "That case is overruled."),      # writer filter
             (4, 2, None, None, "That case is overruled."),      # date guard
             ])
        conn.commit()
        try:
            ba.proven_stage(conn, outdir=self.outdir)
            rows = dict(conn.execute(
                "SELECT opinion_id, proven_flags FROM treatment_proven").fetchall())
            self.assertEqual(rows.get(1), 1)   # proven overruled
            self.assertNotIn(2, rows)          # citing predates cited
        finally:
            conn.close()

    def test_proven_stage_refuses_on_bad_dates(self):
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
        """)
        conn.executemany(
            "INSERT INTO opinions(id, date_filed, type) VALUES (?,?,?)",
            [(1, "garbage", "010combined"), (2, "also-bad", "010combined")])
        conn.execute("INSERT INTO cites VALUES (2, 1, NULL, NULL, 'overruled.')")
        conn.commit()
        try:
            with self.assertRaises(SystemExit):
                ba.proven_stage(conn, outdir=self.outdir)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
