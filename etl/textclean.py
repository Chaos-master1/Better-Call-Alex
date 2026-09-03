import html as _html
import re

ANCHOR_RE = re.compile(
    r'<a\b[^>]*?href="[^"]*?/opinion/(\d+)[^"]*"[^>]*>(.*?)</a\s*>',
    re.I | re.S,
)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.I | re.S)
TAG_RE = re.compile(r"<[^<>]+>")
WS_RE = re.compile(r"\s+")

MARKER = "\x00"

TEXT_SOURCE_ORDER = (
    "plain_text",
    "html_with_citations",
    "html_anon_2020",
    "xml_harvard",
    "html_lawbox",
    "html",
    "html_columbia",
    "xml_scan",
)

HTML_SOURCES = frozenset(TEXT_SOURCE_ORDER) - {"plain_text"}


def pick_source(fields):
    for col in TEXT_SOURCE_ORDER:
        v = fields.get(col)
        if v and v.strip():
            return col, v
    return None, ""


def clean_html(src):
    """HTML/XML -> plain text. Returns (text, anchors) where anchors is a list of
    (cited_opinion_id, start_char, end_char) into the returned text."""
    s = COMMENT_RE.sub(" ", src)
    s = SCRIPT_STYLE_RE.sub(" ", s)

    anchor_ids = []

    def repl(m):
        # Every mention is kept: pair-granular dedup downstream used to
        # discard a second, treatment-bearing mention of the same case.
        anchor_ids.append(int(m.group(1)))
        return MARKER + m.group(2) + MARKER

    s = ANCHOR_RE.sub(repl, s)
    s = TAG_RE.sub(" ", s)
    s = _html.unescape(s)
    s = WS_RE.sub(" ", s)

    parts = s.split(MARKER)
    if len(parts) % 2 == 0:
        # Unbalanced markers (an anchor's own text contained a NUL byte):
        # keep the text, drop the anchors. Never abort the shard over one
        # pathological value — the caller counts the quarantine.
        return "".join(parts), []
    out = []
    out_len = 0
    anchors = []
    ids_iter = iter(anchor_ids)
    for i, part in enumerate(parts):
        if i % 2 == 1:
            cid = next(ids_iter)
            start = out_len
            stripped = part.strip()
            if stripped:
                lead_ws = len(part) - len(part.lstrip())
                start = out_len + lead_ws
                out.append(stripped)
                out_len = start + len(stripped)
                if cid > 0:
                    anchors.append((cid, start, out_len))
            elif cid > 0:
                anchors.append((cid, out_len, out_len))
        else:
            out.append(part)
            out_len += len(part)
    return "".join(out), anchors


def extract_text(fields):
    """fields: dict of opinion csv columns -> (text, anchors)."""
    col, src = pick_source(fields)
    if not src:
        return "", []
    if col == "plain_text":
        return WS_RE.sub(" ", src).strip(), []
    return clean_html(src)


def context_window(text, start, end, pad=150):
    lo = max(0, start - pad)
    hi = min(len(text), end + pad)
    return text[lo:start].strip(), text[end:hi].strip()
