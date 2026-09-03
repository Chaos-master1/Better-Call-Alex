import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from textclean import clean_html, extract_text, context_window


class TestAnchorMultiMention(unittest.TestCase):
    def test_repeated_cite_keeps_every_position(self):
        html = (
            "<p>First mention <a href=\"/opinion/7/x/\">Case X</a> neutrally.</p>"
            "<p>Later <a href=\"/opinion/7/x/\">Case X</a> was overruled here.</p>"
        )
        text, anchors = clean_html(html)
        self.assertEqual([c for c, _, _ in anchors], [7, 7])
        self.assertNotEqual(anchors[0][1], anchors[1][1])
        self.assertEqual(text[anchors[1][1]:anchors[1][2]], "Case X")

    def test_nul_byte_in_source_keeps_text_drops_anchors(self):
        html = "<p>Safe lead.</p><a href=\"/opinion/9/y/\">Bad\x00cite</a> tail."
        text, anchors = clean_html(html)
        self.assertEqual(anchors, [])
        self.assertIn("Safe lead.", text)
        self.assertIn("tail.", text)


class TestCleanHtml(unittest.TestCase):
    def test_anchor_positions(self):
        html = (
            "<p>Earlier text here.</p>See <a href=\"/opinion/1184769/mcguffey-v-turner/\" "
            "aria-description=\"Citation for case: McGuffey v. Turner\">18 Utah 2d 354</a>, "
            "and also <a href=\"/opinion/486398/ramon-chaparro-v-otis-r-bowen/#1011\">"
            "Ramon Chaparro v. Bowen</a>. Done."
        )
        text, anchors = clean_html(html)
        self.assertEqual(
            text.strip(),
            "Earlier text here. See 18 Utah 2d 354, and also Ramon Chaparro v. Bowen. Done.",
        )
        self.assertEqual(len(anchors), 2)
        cid, start, end = anchors[0]
        self.assertEqual(cid, 1184769)
        self.assertEqual(text[start:end], "18 Utah 2d 354")
        cid2, s2, e2 = anchors[1]
        self.assertEqual(cid2, 486398)
        self.assertEqual(text[s2:e2], "Ramon Chaparro v. Bowen")

    def test_entities_and_scripts(self):
        html = ("<script>var x = '<b>not real</b>';</script><p>A &amp; B&nbsp;C</p>"
                "<!-- comment -->")
        text, anchors = clean_html(html)
        self.assertNotIn("not real", text)
        self.assertIn("A &amp;".replace("&amp;", "&"), text)
        self.assertIn("B", text)
        self.assertNotIn("comment", text)

    def test_duplicate_anchor_keeps_both_positions(self):
        # Changed contract (Phase 2): every mention keeps its position so a
        # treatment-bearing second mention survives to the cites context.
        html = "<p><a href=\"/opinion/5/x\">Case A</a> then <a href=\"/opinion/5/x\">Case A</a></p>"
        text, anchors = clean_html(html)
        self.assertEqual(len(anchors), 2)
        self.assertEqual([c for c, _, _ in anchors], [5, 5])

    def test_extract_text_plain(self):
        fields = {"plain_text": "Line one\n   Line two &amp; more", "html": "<p>x</p>"}
        text, anchors = extract_text(fields)
        self.assertEqual(text, "Line one Line two &amp; more")
        self.assertEqual(anchors, [])

    def test_extract_text_coalesce_order(self):
        fields = {"plain_text": "", "html_with_citations": "<p>HWC wins</p>",
                  "xml_harvard": "<x>harvard</x>"}
        text, _ = extract_text(fields)
        self.assertIn("HWC wins", text)

    def test_extract_text_all_empty(self):
        text, anchors = extract_text({k: "" for k in
                                      ["plain_text", "html", "xml_scan"]})
        self.assertEqual(text, "")
        self.assertEqual(anchors, [])

    def test_context_window(self):
        text = "".join(str(i % 10) for i in range(1000))
        pre, post = context_window(text, 500, 510, pad=10)
        self.assertEqual(len(pre), 10)
        self.assertEqual(pre, "4905015203"[0:10] if False else text[490:500])
        self.assertEqual(post, text[510:520])


if __name__ == "__main__":
    unittest.main()
