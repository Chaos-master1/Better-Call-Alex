"""Unit tests for etl/common.py helpers (no corpus needed)."""
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import check_width, find_resync_offset


class TestResync(unittest.TestCase):
    DATA = (b'"1","2020-01-01",aaa\n'
            b'"2","2021-05-05",bbb\n'
            b'"3","2022-09-09",ccc\n')

    def test_mid_record_start_finds_next_boundary(self):
        f = io.BytesIO(self.DATA)
        off = find_resync_offset(f, 5, len(self.DATA))
        self.assertEqual(off, self.DATA.index(b'"2"'))
        f.close()

    def test_multi_chunk_offset_is_file_absolute(self):
        # chunk=16 forces the overlap path: the old start-relative math
        # returned a mid-record offset here instead of the boundary.
        f = io.BytesIO(self.DATA)
        off = find_resync_offset(f, 5, len(self.DATA), chunk=16)
        self.assertEqual(off, self.DATA.index(b'"2"'))
        f.close()

    def test_boundary_exactly_at_start_is_kept_not_skipped(self):
        f = io.BytesIO(self.DATA)
        start = self.DATA.index(b'"2"')
        self.assertEqual(find_resync_offset(f, start, len(self.DATA)), start)
        f.close()

    def test_no_boundary_returns_end(self):
        f = io.BytesIO(b"garbage without boundaries")
        self.assertEqual(find_resync_offset(f, 0, 7), 7)
        f.close()


class TestCheckWidth(unittest.TestCase):
    def test_matching_width_passes(self):
        self.assertTrue(check_width(["a", "b"], 2, "t"))

    def test_shifted_row_rejected_and_counted(self):
        stats: dict = {}
        self.assertFalse(check_width(["a"], 2, "t", stats))
        self.assertEqual(stats["width_reject"], 1)


if __name__ == "__main__":
    unittest.main()
