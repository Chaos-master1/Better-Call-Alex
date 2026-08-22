"""Shared ETL utilities. Stdlib only.

CourtListener bulk CSVs are Postgres COPY output:
    FORMAT csv, ENCODING utf8, ESCAPE '\\', HEADER
i.e. backslash-escaped quotes, NOT RFC-4180 doubled quotes.
Default parsers mis-read them. See CLAUDE.md §4.
"""

import csv
import json
import os
import re
import sqlite3
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"
RAW = DATA / "raw"
BULK = DATA / "bulk"
SHARDS = DATA / ".shards"

CORPUS_DB = DATA / "corpus.sqlite"
CLUSTERS_DB = DATA / ".clusters.sqlite"  # sidecar: clusters + dockets join

csv.field_size_limit(10**9)

CSV_KWARGS = dict(doublequote=False, escapechar="\\", quoting=csv.QUOTE_MINIMAL)


def open_csv_bz2(path):
    import bz2

    return csv.reader(bz2.open(path, "rt", encoding="utf-8", errors="replace"), **CSV_KWARGS)


def open_csv_plain(path):
    return csv.reader(open(path, "rt", encoding="utf-8", errors="replace", newline=""), **CSV_KWARGS)


# --- record-boundary resync for byte-range shards (CLAUDE.md §4) ---
BOUNDARY_RE = re.compile(rb'^"\d+","\d{4}-', re.M)


def find_resync_offset(f, start, end, chunk=4 * 1024 * 1024):
    """Return the first real record boundary at/after `start` (exclusive of header row),
    or `end` if none found. `f` is a seekable binary file."""
    f.seek(start)
    overlap = 64  # keep tail of previous chunk for ^ anchoring
    pos = start
    prev_tail = b""
    while pos < end:
        buf = f.read(min(chunk, end - pos))
        if not buf:
            break
        window = prev_tail + buf
        m = BOUNDARY_RE.search(window)
        if m and (start + len(prev_tail) + m.start()) > start:
            return start + len(prev_tail) + m.start()
        prev_tail = window[-overlap:]
        pos += len(buf)
    return end


def guard_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_bool(value):
    return 1 if value in ("t", "T", "true", "True", "1") else 0


def done_marker(path: Path):
    return path.with_suffix(path.suffix + ".done")


def is_done(path: Path) -> bool:
    return done_marker(path).exists()


def mark_done(path: Path):
    done_marker(path).touch()


def progress_logger(label, total=None, every=100_000):
    import sys
    import time

    state = {"n": 0, "t0": time.time(), "last": time.time()}

    def tick(n=1):
        state["n"] += n
        now = time.time()
        if now - state["last"] >= 30:
            rate = state["n"] / max(now - state["t0"], 1e-9)
            msg = f"[{label}] {state['n']:,} rows ({rate:,.0f}/s)"
            if total:
                msg += f" — {state['n'] / total * 100:.1f}%"
            print(msg, flush=True)
            state["last"] = now

    return tick


def db_connect(path, readonly=False):
    path = Path(path)
    if readonly:
        assert path.exists(), f"{path} missing"
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    else:
        conn = sqlite3.connect(str(path), timeout=120)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA cache_size=-200000")  # ~200MB
        conn.execute("PRAGMA temp_store=MEMORY")
    return conn


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS opinions (
    id INTEGER PRIMARY KEY,
    cluster_id INTEGER,
    court_id TEXT,
    date_filed TEXT,
    case_name TEXT,
    case_name_short TEXT,
    precedential_status TEXT,
    citation_count INTEGER DEFAULT 0,
    author_id INTEGER,
    author_str TEXT,
    type TEXT,
    page_count INTEGER,
    ocr INTEGER DEFAULT 0,
    blocked INTEGER DEFAULT 0,
    text TEXT
);
CREATE TABLE IF NOT EXISTS cites (
    citing_id INTEGER NOT NULL,
    cited_id INTEGER NOT NULL,
    depth INTEGER,
    char_pos INTEGER,
    context TEXT
);
CREATE TABLE IF NOT EXISTS citation_strings (
    cluster_id INTEGER NOT NULL,
    volume TEXT,
    reporter TEXT,
    page TEXT,
    type TEXT
);
CREATE TABLE IF NOT EXISTS parentheticals (
    described_id INTEGER,
    describing_id INTEGER,
    text TEXT,
    score REAL
);
CREATE TABLE IF NOT EXISTS courts (
    id TEXT PRIMARY KEY,
    name TEXT,
    jurisdiction TEXT,
    citation_string TEXT,
    parent_id TEXT,
    level INTEGER
);
CREATE TABLE IF NOT EXISTS judges (
    id INTEGER PRIMARY KEY,
    name_first TEXT,
    name_last TEXT,
    fjc_id INTEGER
);
CREATE TABLE IF NOT EXISTS authority (
    opinion_id INTEGER PRIMARY KEY,
    pagerank REAL,
    recent_cites_2y INTEGER,
    treatment_flags INTEGER
);

-- FTS5 external-content index over opinions.text; built once at merge time.
CREATE VIRTUAL TABLE IF NOT EXISTS opinions_fts USING fts5(
    text, content='opinions', content_rowid='id',
    tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS parentheticals_fts USING fts5(
    text, content='parentheticals', content_rowid='rowid',
    tokenize='porter unicode61'
);
"""


def init_corpus(conn):
    conn.executescript(SCHEMA_SQL)
    conn.commit()
