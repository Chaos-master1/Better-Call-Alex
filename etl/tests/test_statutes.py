"""G4 statutes ETL tests — corpus-free: parser fixtures + table behavior.

The fixtures mirror the real feed shapes: the eCFR DIV8/SECTION sample was
captured from the live versioner API, and the usc-md sample follows the
OLRC release-point XML format.
"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import statutes

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "statutes"


class TestEcfrParser(unittest.TestCase):
    def test_sections_extracted_with_heading_and_body(self):
        data = (FIXTURES / "ecfr-sample.xml").read_bytes()
        rows = list(statutes.parse_ecfr_sections(data))
        self.assertEqual(len(rows), 1)  # the number-less section is skipped
        r = rows[0]
        self.assertEqual(r["source"], "ecfr")
        self.assertEqual(r["num"], "1026.36")
        self.assertIn("Prohibited acts or practices", r["heading"])
        self.assertIn("(a) Definitions.", r["text"])
        self.assertIn("any consumer credit transaction", r["text"])
        self.assertIn("A note inside the section body.", r["text"])
        self.assertEqual(r["text"].count("A note inside the section body."), 1)

    def test_dtd_is_rejected(self):
        with self.assertRaises(SystemExit):
            list(statutes.parse_ecfr_sections(
                b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x/>'))


class TestUscParser(unittest.TestCase):
    def test_sections_extracted_with_num_heading_text(self):
        data = (FIXTURES / "usc-sample.xml").read_bytes()
        rows = list(statutes.parse_usc_sections(data))
        self.assertEqual(len(rows), 2)  # number-less section is skipped
        first = rows[0]
        self.assertEqual(first["source"], "usc")
        self.assertEqual(first["num"], "1983")
        self.assertEqual(first["heading"], "Civil action for deprivation of rights")
        self.assertIn("under color of any statute", first["text"])
        self.assertIn("Pub. L. 107", first["text"])  # notes ride inside text
        # ...exactly once: the <note> container must not double-count its
        # inner <content> (the eCFR parser's container rule, applied here).
        self.assertEqual(first["text"].count("Pub. L. 107"), 1)
        self.assertIsNone(first["effective_date"])
        second = rows[1]
        self.assertEqual(second["num"], "1985a")
        self.assertEqual(second["effective_date"], "Jan. 6, 1997")


class TestStatutesTables(unittest.TestCase):
    def _tmp_db(self):
        fd, path = tempfile.mkstemp(suffix=".sqlite")
        self.addCleanup(__import__("os").close, fd)
        self.addCleanup(__import__("os").remove, path)
        return sqlite3.connect(path)

    def test_ensure_is_idempotent_and_fts_matches(self):
        conn = self._tmp_db()
        conn.executescript(statutes.STATUTES_SCHEMA)
        conn.executescript(statutes.STATUTES_SCHEMA)  # idempotent
        rows = list(statutes.parse_usc_sections(
            (FIXTURES / "usc-sample.xml").read_bytes()))
        n = statutes.insert_rows(conn, rows, "42")
        self.assertEqual(n, 2)
        # (source, title, section) is unique: a reload replaces, not duplicates
        n2 = statutes.insert_rows(conn, rows, "42")
        self.assertEqual(n2, 2)
        statutes.rebuild_fts(conn)
        hits = conn.execute(
            "SELECT count(*) FROM statutes_fts WHERE statutes_fts MATCH ?",
            ("deprivation",)).fetchone()[0]
        self.assertGreaterEqual(hits, 1)
        row = conn.execute(
            "SELECT heading FROM statutes WHERE source='usc' AND title='42' AND section='1983'"
        ).fetchone()
        self.assertEqual(row[0], "Civil action for deprivation of rights")
        conn.close()

    def test_url_builders_reject_bad_components(self):
        with self.assertRaises(SystemExit):
            statutes.ecfr_url("not-a-date", "42")
        with self.assertRaises(SystemExit):
            statutes.ecfr_url("2026-08-31", "../etc")
        with self.assertRaises(SystemExit):
            statutes.usc_url("42", "119", "73; rm -rf")
        with self.assertRaises(SystemExit):
            statutes.section_url("2026-08-31", "42", "1983 OR 1=1")
        # and the happy paths
        self.assertIn("title-42.xml", statutes.ecfr_url("2026-08-31", "42"))
        self.assertIn("xml_usc42@119-73.zip", statutes.usc_url("42", "119", "73"))
        self.assertTrue(statutes.section_url("2026-08-31", "42", "1026.36").endswith("?section=1026.36"))
        # subsection pins are real section ids, not injection
        self.assertTrue(statutes.section_url("2026-08-31", "42", "1026.36(a)").endswith("?section=1026.36(a)"))
        with self.assertRaises(SystemExit):
            statutes.section_url("2026-08-31", "42", "1983 OR 1=1")


class TestUscLoadPath(unittest.TestCase):
    """The archive path load_usc_title walks: zip → member → parse → store.
    Previously 100% broken (`with` over a returned tuple) with zero coverage
    because every test stopped at the parser."""

    def _zipped_fixture(self):
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("xml_usc42@119-73.xml",
                         (FIXTURES / "usc-sample.xml").read_bytes())
        return buf.getvalue()

    def test_zip_member_extraction(self):
        name, xdata = statutes.zipfile_member(self._zipped_fixture())
        self.assertTrue(name.endswith(".xml"))
        self.assertIn(b"<section", xdata)

    def test_load_usc_bytes_stores_both_sections(self):
        conn = sqlite3.connect(":memory:")
        conn.executescript(statutes.STATUTES_SCHEMA)
        n = statutes.load_usc_bytes(conn, "42", self._zipped_fixture())
        self.assertEqual(n, 2)
        row = conn.execute(
            "SELECT heading FROM statutes WHERE source='usc' AND title='42' AND section='1983'"
        ).fetchone()
        self.assertEqual(row[0], "Civil action for deprivation of rights")
        conn.close()

    def test_zip_without_xml_member_fails_fast(self):
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("readme.txt", "no xml here")
        with self.assertRaises(SystemExit):
            statutes.zipfile_member(buf.getvalue())


class TestFetchGuards(unittest.TestCase):
    def test_redirect_is_refused_loudly(self):
        handler = statutes._NoRedirect()
        with self.assertRaises(Exception) as cm:
            handler.redirect_request(None, None, 302, "Found", {}, "https://evil.example/")
        self.assertIn("redirect refused", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
