"""G4 statutes ETL: US Code + eCFR into corpus.sqlite (CLAUDE.md §5.7).

Sources:
  uscode.house.gov release points — the Code itself. Title XML zips in the
    OLRC "usc-md" <section>/<level> format:
      https://uscode.house.gov/download/releasepoints/us/pl/{congress}/{law}/xml_usc{title:02d}@{congress}-{law}.zip
    This host is not reachable from every network; the download stage fails
    fast with a remediation hint when it is not.
  eCFR versioner API — the regulations (CFR), per title:
      https://www.ecfr.gov/api/versioner/v1/full/{date}/title-{title}.xml
    Parsed with iterparse (constant per-section memory via elem.clear();
    the title XML itself is bounded by MAX_XML_BYTES, not streamed).

Storage (CLAUDE.md reserved schema):
  statutes(source, title, section, heading, text, effective_date)
  statutes_fts — external-content FTS5 over statutes(heading, text),
  rebuilt after each load (the table is small next to opinions).

Safety:
  - URLs are built only from strict-validated components, for the two
    allow-listed hosts, with redirects refused and the resolved IP checked
    against the public range; nothing else reaches fetch().
  - XML is rejected if a DTD/ENTITY declaration is present (entity
    expansion); the official feeds do not ship DTDs.
  - Every SQL statement is a single-line literal with bound parameters;
    nothing user-derived is ever concatenated into a statement.

Stages (each idempotent, INSERT OR REPLACE on (source, title, section)):
  ensure               create statutes + statutes_fts
  ecfr-title --title N [--date D] [--part P]
  usc-title  --title N --congress C --law L
  usc-file   --title N --file PATH   load a previously downloaded title zip
                                     (used where uscode.house.gov is
                                     unreachable; the official govinfo
                                     package of the same OLRC XML parses
                                     identically)
  usc-govinfo --title N --file PATH  load a govinfo USCODE-{year}-title{n}
                                     package zip (html granules) — same
                                     statutory text, per-section documentid
                                     keys
  spot-check --n 20 [--date D]   re-fetch n live eCFR sections and compare
  stats
"""
import argparse
import gzip
import io
import json
import re
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path

import defusedxml.ElementTree as SafeET

from common import CORPUS_DB, db_connect

REPO = Path(__file__).resolve().parent.parent
LOGS = REPO / "logs"

ECFR_HOST = "https://www.ecfr.gov/"
USC_HOST = "https://uscode.house.gov/"
ECFR_FULL_URL = ECFR_HOST + "api/versioner/v1/full/{date}/title-{title}.xml"
USC_RELEASE_URL = USC_HOST + ("download/releasepoints/us/pl/{congress}/{law}"
                              "/xml_usc{title:02d}@{congress}-{law}.zip")

ALLOWED_HOSTS = ("www.ecfr.gov", "uscode.house.gov")
INT_RE = re.compile(r"^\d{1,3}$")
# URL path/query components. SECTION_RE additionally allows parens: real
# section ids carry subsection pins ("1026.36(a)"), which are URL-safe and
# must not be rejected into fake spot-check mismatches.
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
COMPONENT_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
SECTION_RE = re.compile(r"^[A-Za-z0-9._()/-]{1,80}$")

FETCH_TIMEOUT = 180
FETCH_ATTEMPTS = 3
MAX_XML_BYTES = 400_000_000

STATUTES_SCHEMA = """
CREATE TABLE IF NOT EXISTS statutes (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('usc', 'ecfr')),
    title TEXT NOT NULL,
    section TEXT NOT NULL,
    heading TEXT NOT NULL,
    text TEXT NOT NULL,
    effective_date TEXT,
    UNIQUE(source, title, section)
);
CREATE INDEX IF NOT EXISTS idx_statutes_title ON statutes(title);
CREATE VIRTUAL TABLE IF NOT EXISTS statutes_fts USING fts5(
    heading, text, content='statutes', content_rowid='id',
    tokenize='porter unicode61'
);
"""


# ----------------------------------------------------------------- URLs

def ecfr_url(date: str, title: str, part: str | None = None) -> str:
    if not DATE_RE.match(date or ""):
        raise SystemExit(f"bad --date {date!r}; expected YYYY-MM-DD")
    if not INT_RE.match(str(title)):
        raise SystemExit(f"bad --title {title!r}; expected an integer")
    url = ECFR_FULL_URL.format(date=date, title=int(title))
    if part:
        if not COMPONENT_RE.match(part):
            raise SystemExit(f"bad --part {part!r}")
        url += "?part=" + part
    return url


def usc_url(title: str, congress: str, law: str) -> str:
    for name, v in (("title", title), ("congress", congress), ("law", law)):
        if not INT_RE.match(str(v)):
            raise SystemExit(f"bad --{name} {v!r}; expected an integer")
    return USC_RELEASE_URL.format(congress=int(congress), law=int(law), title=int(title))


def section_url(date: str, title: str, section: str) -> str:
    if not SECTION_RE.match(str(section)):
        raise SystemExit(f"bad section id {section!r}")
    return ecfr_url(date, title) + "?section=" + str(section)


# ----------------------------------------------------------------- fetch

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Redirects are refused: every fetch must land on an allow-listed host.
    Returning None here would hand the 3xx body back as if it were the feed,
    so refuse loudly instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            newurl, code, f"redirect refused ({code} to {newurl})",
            headers, fp)


_OPENER = urllib.request.build_opener(_NoRedirect)


def _public_ip_guard(host: str) -> None:
    """Resolve the host and refuse non-public addresses (loopback, RFC1918,
    link-local, cloud metadata ranges) so a hostile DNS answer cannot pivot
    a fetch at the local network.
    Residual risk (documented, not fixed): resolve-then-fetch is TOCTOU —
    the opener re-resolves after this check. Pinning would require a custom
    HTTPS connect with SNI override; the allow-list keeps the residual
    exposure to the two official hosts."""
    import ipaddress
    import socket
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise SystemExit(f"DNS resolution failed for {host!r}: {e}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise SystemExit(f"blocked non-public address {ip} for {host!r}")


def fetch(url: str) -> bytes:
    """GET with gzip tolerated, a small retry budget, redirects refused, and
    an allow-list + resolved-IP boundary check on the destination."""
    parsed = urllib.request.urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme != "https" or host not in ALLOWED_HOSTS:
        raise SystemExit(f"blocked fetch of {url!r}")
    _public_ip_guard(host)
    last_err: Exception | None = None
    for attempt in range(FETCH_ATTEMPTS):
        try:
            req = urllib.request.Request(
                url, headers={"Accept-Encoding": "gzip", "User-Agent": "better-call-alex-g4/1.0"})
            with _OPENER.open(req, timeout=FETCH_TIMEOUT) as resp:
                data = resp.read(MAX_XML_BYTES)
                if resp.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_err = e
            wait = 5 * (attempt + 1)
            print(f"  fetch failed ({e}) — retry {attempt + 1}/{FETCH_ATTEMPTS} in {wait}s",
                  flush=True)
            time.sleep(wait)
    raise SystemExit(
        f"download failed after {FETCH_ATTEMPTS} attempts: {url}\n"
        f"last error: {last_err}\n"
        "If uscode.house.gov is unreachable from this network, run the eCFR "
        "stages here and load US Code titles from a host that reaches OLRC."
    )


# ----------------------------------------------------------------- parsing

def collapse_ws(s: str) -> str:
    return " ".join(s.split())


def reject_dtd(data: bytes) -> bytes:
    """Entity-expansion guard: the official feeds ship no DTDs, so any
    <!DOCTYPE / <!ENTITY in the prolog means the bytes are not what we
    asked for."""
    head = data[:4096].lower()
    if b"<!doctype" in head or b"<!entity" in head:
        raise SystemExit("rejected XML containing a DTD/ENTITY declaration")
    return data


# Paragraph-level tags only: NOTE etc. are containers — sweeping them too
# would double-count their inner paragraphs.
BODY_TAGS = {"P", "FP", "PSPACE", "EXTRACT", "CITA", "HD", "HD1", "HD2"}


def parse_ecfr_sections(data: bytes):
    """Stream an eCFR title XML, yielding statute rows for every SECTION.

    eCFR encodes sections as DIV8 (occasionally DIV9) nodes with
    TYPE="SECTION", a N attribute holding the section number (e.g.
    "1026.36"), a HEAD child, and P/FP/PSPACE body paragraphs.
    """
    reject_dtd(data)
    stream = SafeET.iterparse(io.BytesIO(data), events=("end",))
    for _event, elem in stream:
        if elem.get("TYPE", "") != "SECTION":
            continue
        num = elem.get("N") or ""
        heading = ""
        head = elem.find("HEAD")
        if head is not None:
            heading = collapse_ws("".join(head.itertext()))
        parts: list[str] = []
        for child in elem.iter():
            tag = child.tag.rsplit("}", 1)[-1]
            if tag in BODY_TAGS:
                txt = collapse_ws("".join(child.itertext()))
                if txt:
                    parts.append(txt)
        text = " ".join(parts)
        if num and (heading or text):
            yield {"source": "ecfr", "num": num, "heading": heading,
                   "text": text, "effective_date": None}
        elem.clear()


def _local(tag: str) -> str:
    """Namespace-agnostic tag name: `{ns}section` → `section`."""
    return tag.rsplit("}", 1)[-1]


def _first_child(el, name: str):
    for child in el:
        if _local(child.tag) == name:
            return child
    return None


USC_BODY_TAGS = ("content", "P", "FP", "note", "text")


def _gather_body(el, parts: list, claimed: bool) -> None:
    """Collect body text without double-counting containers (the eCFR
    parser's rule, applied here too): text is claimed at the HIGHEST
    candidate element, so a <note> contributes its itertext once and its
    inner <content>/<heading> children are not appended a second time."""
    if not claimed and _local(el.tag) in USC_BODY_TAGS:
        txt = collapse_ws("".join(el.itertext()))
        if txt:
            parts.append(txt)
        claimed = True
    for child in el:
        _gather_body(child, parts, claimed)


def parse_usc_sections(data: bytes):
    """Parse an OLRC usc-md title XML into statute rows.

    Sections are <section identifier="sec_1983"> nodes with <num value>,
    <heading>, and nested <level>/<content> text. An inline effective date,
    when the OLRC records one, rides in an <effective_date> element. Tag
    matching ignores namespaces: some usc-md producers bind one.
    """
    reject_dtd(data)
    root = SafeET.fromstring(data)
    for sec in root.iter():
        if _local(sec.tag) != "section":
            continue
        num_el = _first_child(sec, "num")
        num = (num_el.get("value") if num_el is not None else "") or ""
        if not num:
            ident = sec.get("identifier", "")
            num = ident[len("sec_"):] if ident.startswith("sec_") else ident
        head_el = _first_child(sec, "heading")
        heading = collapse_ws("".join(head_el.itertext())) if head_el is not None else ""
        eff_el = _first_child(sec, "effective_date")
        eff = collapse_ws("".join(eff_el.itertext())) if eff_el is not None else None
        parts: list[str] = []
        for child in sec:
            if child is head_el:
                continue
            _gather_body(child, parts, claimed=False)
        text = " ".join(parts)
        if num and (heading or text):
            yield {"source": "usc", "num": num, "heading": heading,
                   "text": text, "effective_date": eff or None}


# ----------------------------------------------------------------- loading

INSERT_OR_REPLACE = ("INSERT OR REPLACE INTO statutes"
                     " (source, title, section, heading, text, effective_date)"
                     " VALUES (?, ?, ?, ?, ?, ?)")


def insert_rows(conn: sqlite3.Connection, rows, title: str) -> int:
    batch: list[tuple] = []
    n = 0
    for r in rows:
        batch.append((r["source"], title, r["num"], r["heading"], r["text"],
                      r["effective_date"]))
        if len(batch) >= 5_000:
            conn.executemany(
                "INSERT OR REPLACE INTO statutes (source, title, section, heading, text, effective_date) VALUES (?, ?, ?, ?, ?, ?)",
                batch)
            conn.commit()
            n += len(batch)
            batch = []
    if batch:
        conn.executemany(
            "INSERT OR REPLACE INTO statutes (source, title, section, heading, text, effective_date) VALUES (?, ?, ?, ?, ?, ?)",
            batch)
        conn.commit()
        n += len(batch)
    return n


def rebuild_fts(conn: sqlite3.Connection) -> None:
    conn.execute("INSERT INTO statutes_fts(statutes_fts) VALUES ('rebuild')")
    conn.commit()


def load_ecfr_title(conn: sqlite3.Connection, title: str, date: str, part: str | None) -> int:
    url = ecfr_url(date, title, part)
    print(f"[ecfr] title {title} as of {date} <- {url}", flush=True)
    data = fetch(url)
    n = insert_rows(conn, parse_ecfr_sections(data), title)
    rebuild_fts(conn)
    print(f"[ecfr] title {title}: {n} sections stored", flush=True)
    return n


def load_usc_title(conn: sqlite3.Connection, title: str, congress: str, law: str) -> int:
    url = usc_url(title, congress, law)
    print(f"[usc] title {title} at release point pl {congress}-{law} <- {url}", flush=True)
    return load_usc_bytes(conn, title, fetch(url))


def load_usc_file(conn: sqlite3.Connection, title: str, path: str) -> int:
    """USC load from a title zip already on disk (network-free stage).

    For networks where uscode.house.gov is unreachable: the official
    govinfo package (USCODE-{year}-title{n}) ships the same OLRC usc-md
    XML, and is fetched out of band; this stage validates and parses it
    through the identical load path so provenance is unchanged."""
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"no such file: {path}")
    print(f"[usc] loading archive {p.name} ({p.stat().st_size:,} bytes)", flush=True)
    name, xdata = zipfile_member_path(p)
    print(f"[usc] archive member: {name} ({len(xdata):,} bytes)", flush=True)
    n = insert_rows(conn, parse_usc_sections(xdata), title)
    rebuild_fts(conn)
    print(f"[usc] title {title}: {n} sections stored", flush=True)
    return n


def zipfile_member_path(p: Path):
    """First .xml member of a zip ON DISK, as (name, bytes) — reads only
    that member rather than the whole archive into memory."""
    import zipfile as _zf
    with _zf.ZipFile(p) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
        if not names:
            raise SystemExit(f"no XML member in archive: {zf.namelist()}")
        name = names[0]
        return name, zf.read(name)


# --------------------------- govinfo USCODE package (html granules) ----

# The govinfo USCODE package (USCODE-{year}-title{n}) ships one HTML granule
# per section with GPO field markers, e.g.
#   <!-- documentid:42_1983 ... currentthrough:20240103 -->
#   <h3 class="section-head">&sect;1983. Civil action ...</h3>
#   <p class="statutory-body">Every person who ...</p>
# The documentid IS the authoritative section key ("42_300gg-1" → "300gg-1"),
# so synthetic-looking filename suffixes ("-1", "-2") are real statutory ids,
# never disambiguators. Container granules (the title root, chapters, TOC
# pages) have no usable section docid and are skipped.
_DOCID_RE = re.compile(r"documentid:(\S+)")
_SECTION_KEY_RE = re.compile(r"^[1-9][0-9a-zA-Z-]{0,15}$")
_H3_RE = re.compile(r'<h3 class="section-head">(.*?)</h3>', re.S)
_P_RE = re.compile(r'<p class="(statutory-body|source-credit|note-body)">(.*?)</p>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def parse_usc_govinfo_granule(data: bytes):
    """One govinfo HTML granule → a statute row, or None for non-section
    granules (title root, chapter containers, TOC pages)."""
    import html as _html
    html = data.decode("utf-8", "replace")
    docid_m = _DOCID_RE.search(html)
    if not docid_m:
        return None
    rest = docid_m.group(1)
    if "_" not in rest:
        return None
    _prefix, section = rest.split("_", 1)
    if not _SECTION_KEY_RE.match(section):
        return None  # containers like "" or "-ch1"
    h3 = _H3_RE.search(html)
    if not h3:
        return None
    heading = collapse_ws(_html.unescape(_TAG_RE.sub("", h3.group(1))))
    # "§1983. Civil action ..." → "Civil action ..." (the num itself is the key)
    heading = re.sub(r"^\u00a7\s*[0-9A-Za-z][0-9A-Za-z.\-]*\.?\s*", "", heading)
    parts = [collapse_ws(_html.unescape(_TAG_RE.sub("", body)))
             for _cls, body in _P_RE.findall(html)]
    text = " ".join(p for p in parts if p)
    if not (heading or text):
        return None
    return {"source": "usc", "num": section, "heading": heading,
            "text": text, "effective_date": None}


def load_usc_govinfo_file(conn: sqlite3.Connection, title: str, path: str) -> int:
    """USC load from a govinfo USCODE-{year}-title{n} package zip on disk.

    uscode.house.gov is unreachable from some networks; this official
    package carries the same statutory text per section granule. Sections
    stream out of the archive one granule at a time (constant memory),
    INSERT OR REPLACE keeps the load idempotent, and FTS rebuilds once at
    the end."""
    import zipfile as _zf
    p = Path(path)
    if not p.is_file():
        raise SystemExit(f"no such file: {path}")
    print(f"[usc-govinfo] loading package {p.name} ({p.stat().st_size:,} bytes)",
          flush=True)
    n = 0
    batch: list[tuple] = []
    with _zf.ZipFile(p) as zf:
        for member in zf.infolist():
            if not member.filename.lower().endswith(".htm") or "/html/" not in member.filename:
                continue
            row = parse_usc_govinfo_granule(zf.read(member))
            if row is None:
                continue
            batch.append((row["source"], title, row["num"], row["heading"],
                          row["text"], row["effective_date"]))
            if len(batch) >= 2_000:
                conn.executemany(INSERT_OR_REPLACE, batch)
                conn.commit()
                n += len(batch)
                batch = []
    if batch:
        conn.executemany(INSERT_OR_REPLACE, batch)
        conn.commit()
        n += len(batch)
    rebuild_fts(conn)
    print(f"[usc-govinfo] title {title}: {n} sections stored", flush=True)
    return n


def load_usc_bytes(conn: sqlite3.Connection, title: str, zbytes: bytes) -> int:
    """USC load from already-fetched zip bytes (network-free; unit-tested).
    Split from load_usc_title so the archive path is exercisable offline."""
    name, xdata = zipfile_member(zbytes)
    print(f"[usc] archive member: {name} ({len(xdata):,} bytes)", flush=True)
    n = insert_rows(conn, parse_usc_sections(xdata), title)
    rebuild_fts(conn)
    print(f"[usc] title {title}: {n} sections stored", flush=True)
    return n


def zipfile_member(zbytes: bytes):
    """First .xml member of an in-memory zip, as (name, bytes)."""
    import zipfile as _zf
    with _zf.ZipFile(io.BytesIO(zbytes)) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
        if not names:
            raise SystemExit(f"no XML member in archive: {zf.namelist()}")
        name = names[0]
        return name, zf.read(name)


# ----------------------------------------------------------------- checks

def spot_check(conn: sqlite3.Connection, n: int, date: str) -> dict:
    """Re-fetch n live eCFR sections and compare against what we stored.
    The G4 gate: 20 sections spot-checked against the live eCFR API.
    The sample is a deterministic strided selection — reproducible without
    a PRNG."""
    rows = conn.execute("SELECT title, section, heading, text FROM statutes WHERE source='ecfr'").fetchall()
    if not rows:
        raise SystemExit("no eCFR sections loaded yet — run ecfr-title first")
    step = max(1, len(rows) // max(1, n))
    picks = rows[::step][:n]
    checked = 0
    matched = 0
    mismatches: list[dict] = []
    t0 = time.time()
    for title, section, heading, text in picks:
        try:
            data = fetch(section_url(date, title, section))
            live = list(parse_ecfr_sections(data))
        except (SystemExit, SafeET.ParseError) as e:
            mismatches.append({"title": title, "section": section,
                               "error": str(e)[:200]})
            continue
        checked += 1
        ok = bool(live) and (
            live[0]["num"] == section
            and collapse_ws(live[0]["heading"]) == collapse_ws(heading)
            and collapse_ws(live[0]["text"])[:120] == collapse_ws(text)[:120])
        if ok:
            matched += 1
        else:
            mismatches.append({"title": title, "section": section,
                               "stored_heading": heading[:120],
                               "live_heading": live[0]["heading"][:120] if live else None})
        print(f"  {title} § {section}: {'ok' if ok else 'MISMATCH'}", flush=True)
    report = {
        "source": "ecfr live spot-check",
        "date": date,
        "sample": f"strided, step={step}",
        "checked": checked,
        "matched": matched,
        "mismatches": mismatches,
        "seconds": round(time.time() - t0, 1),
        "pass": checked > 0 and matched == checked,
    }
    LOGS.mkdir(exist_ok=True)
    (LOGS / "g4-statutes-spotcheck.json").write_text(json.dumps(report, indent=1))
    print(f"[spot-check] {matched}/{checked} matched — report → "
          f"logs/g4-statutes-spotcheck.json", flush=True)
    return report


def stats(conn: sqlite3.Connection) -> dict:
    out = {}
    for source in ("usc", "ecfr"):
        row = conn.execute("SELECT count(*), count(DISTINCT title) FROM statutes WHERE source = ?", (source,)).fetchone()
        out[source] = {"sections": row[0], "titles": row[1]}
    print(json.dumps(out, indent=1))
    return out


# ----------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["ensure", "ecfr-title", "usc-title",
                                    "usc-file", "usc-govinfo", "spot-check", "stats"])
    ap.add_argument("--title", help="title number, e.g. 42")
    ap.add_argument("--congress", help="US Code release-point congress, e.g. 119")
    ap.add_argument("--law", help="US Code release-point law, e.g. 73")
    ap.add_argument("--part", help="optional eCFR ?part= filter (e.g. part-1026)")
    ap.add_argument("--file", help="path to a previously downloaded title zip (usc-file)")
    ap.add_argument("--date", default="2026-08-31", help="eCFR as-of date")
    ap.add_argument("--n", type=int, default=20, help="spot-check sample size")
    args = ap.parse_args()

    conn = db_connect(CORPUS_DB)
    try:
        if args.cmd == "ensure":
            conn.executescript(STATUTES_SCHEMA)
            conn.commit()
            print("statutes + statutes_fts ensured")
        elif args.cmd == "ecfr-title":
            if not args.title:
                raise SystemExit("--title is required")
            conn.executescript(STATUTES_SCHEMA)
            conn.commit()
            load_ecfr_title(conn, args.title, args.date, args.part)
        elif args.cmd == "usc-title":
            if not (args.title and args.congress and args.law):
                raise SystemExit("--title, --congress and --law are required")
            conn.executescript(STATUTES_SCHEMA)
            conn.commit()
            load_usc_title(conn, args.title, args.congress, args.law)
        elif args.cmd == "usc-file":
            if not (args.title and args.file):
                raise SystemExit("--title and --file are required")
            conn.executescript(STATUTES_SCHEMA)
            conn.commit()
            load_usc_file(conn, args.title, args.file)
        elif args.cmd == "usc-govinfo":
            if not (args.title and args.file):
                raise SystemExit("--title and --file are required")
            conn.executescript(STATUTES_SCHEMA)
            conn.commit()
            load_usc_govinfo_file(conn, args.title, args.file)
        elif args.cmd == "spot-check":
            spot_check(conn, args.n, args.date)
        elif args.cmd == "stats":
            stats(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
