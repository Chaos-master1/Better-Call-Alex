"""Staged corpus builder.

Stages (each resumable, idempotent):
  clusters-dockets   stream dockets.bz2 -> docket_court map (sidecar DB)
  clusters-join      stream clusters CSV -> sidecar clusters + join coverage report
  small              courts, judges, citation_strings into corpus.sqlite
  citormap           stream citation-map.bz2 -> staging table in corpus.sqlite
  parentheticals     parentheticals rows + FTS5 index
  shard --index N    one worker: byte range of opinions.csv -> .shards/shard_N.sqlite
  merge              shards -> main opinions; cites built from citormap x anchors;
                     FTS5 rebuild; indexes
"""

import argparse
import csv
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

from common import (
    BOUNDARY_RE,
    BULK,
    CLUSTERS_DB,
    CORPUS_DB,
    RAW,
    SHARDS,
    CSV_KWARGS,
    db_connect,
    done_marker,
    find_resync_offset,
    guard_int,
    init_corpus,
    is_done,
    mark_done,
    open_csv_bz2,
    open_csv_plain,
    parse_bool,
    progress_logger,
)
import textclean

DATA_REPORT = Path(__file__).resolve().parent.parent / "docs" / "g0-join-coverage.json"

# canonical boundary is the date-anchored one from common.py; keep the old
# name as an alias so internal references stay readable and diff is minimal.
BOUNDARY_LINE_RE = BOUNDARY_RE
LEADING_ID_RE = re.compile(rb'^"(\d+)"')

OPINION_HEADER = [
    "id", "date_created", "date_modified", "author_str", "per_curiam",
    "joined_by_str", "type", "sha1", "page_count", "download_url", "local_path",
    "plain_text", "html", "html_lawbox", "html_columbia", "html_anon_2020",
    "xml_harvard", "xml_scan", "html_with_citations", "extracted_by_ocr",
    "author_id", "cluster_id",
]

SHARD_SCHEMA = """
CREATE TABLE opinions (
    id INTEGER PRIMARY KEY, cluster_id INTEGER, court_id TEXT,
    date_filed TEXT, case_name TEXT, case_name_short TEXT,
    precedential_status TEXT, citation_count INTEGER,
    author_id INTEGER, author_str TEXT, type TEXT,
    page_count INTEGER, ocr INTEGER, blocked INTEGER, text TEXT
);
CREATE TABLE anchors (
    citing_id INTEGER NOT NULL, cited_id INTEGER NOT NULL,
    char_pos INTEGER, context TEXT,
    PRIMARY KEY (citing_id, cited_id)
) WITHOUT ROWID;
"""


def header_index(header):
    return {name: i for i, name in enumerate(header)}


# ---------------------------------------------------------------- dockets

def stage_clusters_dockets():
    SHARDS.parent.mkdir(parents=True, exist_ok=True)
    if is_done(CLUSTERS_DB):
        print("[dockets] already done")
        return
    src = BULK / "dockets-2026-06-30.csv.bz2"
    conn = db_connect(CLUSTERS_DB)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("CREATE TABLE IF NOT EXISTS docket_court (id INTEGER PRIMARY KEY, court_id TEXT)")
    tick = progress_logger("dockets", every=1_000_000)
    batch = []
    for i, row in enumerate(open_csv_bz2(src)):
        if i == 0:
            idx = header_index(row)
            i_id, i_court = idx["id"], idx["court_id"]
            continue
        did = guard_int(row[i_id])
        if did is not None:
            batch.append((did, row[i_court] or None))
        tick()
        if len(batch) >= 500_000:
            conn.executemany("INSERT OR REPLACE INTO docket_court VALUES (?,?)", batch)
            conn.commit()
            batch.clear()
    if batch:
        conn.executemany("INSERT OR REPLACE INTO docket_court VALUES (?,?)", batch)
        conn.commit()
    n = conn.execute("SELECT count(*) FROM docket_court").fetchone()[0]
    nc = conn.execute(
        "SELECT count(*) FROM docket_court WHERE court_id IS NOT NULL AND court_id != ''"
    ).fetchone()[0]
    print(f"[dockets] loaded {n:,} ({nc:,} with court_id)")
    conn.close()
    mark_done(CLUSTERS_DB)


# ---------------------------------------------------------------- clusters join

def stage_clusters_join():
    if not is_done(CLUSTERS_DB):
        sys.exit("run `clusters-dockets` first")
    conn = db_connect(CLUSTERS_DB)
    joined_marker = CLUSTERS_DB.with_suffix(".joined.done")
    if not joined_marker.exists():
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute("PRAGMA cache_size=-262144")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS raw_clusters (
                id INTEGER PRIMARY KEY, date_filed TEXT, case_name TEXT,
                case_name_short TEXT, precedential_status TEXT,
                citation_count INTEGER, blocked INTEGER DEFAULT 0,
                docket_id INTEGER
            )"""
        )
        src = RAW / "opinion-clusters-2026-06-30.csv"
        n_raw = conn.execute("SELECT count(*) FROM raw_clusters").fetchone()[0]
        if n_raw == 0:
            tick = progress_logger("clusters", every=1_000_000)
            batch = []
            for i, row in enumerate(open_csv_plain(src)):
                if i == 0:
                    idx = header_index(row)
                    continue
                cid = guard_int(row[idx["id"]])
                if cid is None:
                    continue
                batch.append((
                    cid,
                    row[idx["date_filed"]] or None,
                    row[idx["case_name"]] or None,
                    row[idx["case_name_short"]] or None,
                    row[idx["precedential_status"]] or None,
                    guard_int(row[idx["citation_count"]], 0),
                    parse_bool(row[idx["blocked"]]),
                    guard_int(row[idx["docket_id"]]),
                ))
                tick()
                if len(batch) >= 500_000:
                    conn.executemany("INSERT OR REPLACE INTO raw_clusters VALUES (?,?,?,?,?,?,?,?)", batch)
                    conn.commit()
                    batch.clear()
            if batch:
                conn.executemany("INSERT OR REPLACE INTO raw_clusters VALUES (?,?,?,?,?,?,?,?)", batch)
                conn.commit()

        print("[clusters] joining docket->court on disk...")
        t0 = time.time()
        conn.execute("DROP TABLE IF EXISTS clusters")
        conn.execute(
            """CREATE TABLE clusters (
                id INTEGER PRIMARY KEY, date_filed TEXT, case_name TEXT,
                case_name_short TEXT, precedential_status TEXT,
                citation_count INTEGER, blocked INTEGER DEFAULT 0,
                docket_id INTEGER, court_id TEXT
            )"""
        )
        conn.execute(
            """INSERT INTO clusters
               SELECT r.id, r.date_filed, r.case_name, r.case_name_short,
                      r.precedential_status, r.citation_count, r.blocked,
                      r.docket_id, d.court_id
               FROM raw_clusters r
               LEFT JOIN docket_court d ON d.id = r.docket_id"""
        )
        conn.commit()
        total, resolved = conn.execute(
            "SELECT count(*), count(court_id) FROM clusters"
        ).fetchone()
        pct = resolved / max(total, 1) * 100
        report = {
            "clusters_total": total,
            "court_id_resolved": resolved,
            "join_coverage_pct": round(pct, 2),
            "join_seconds": round(time.time() - t0),
        }
        DATA_REPORT.parent.mkdir(exist_ok=True)
        DATA_REPORT.write_text(json.dumps(report, indent=2))
        print(f"[clusters] JOIN COVERAGE docket->court: {resolved:,}/{total:,} = {pct:.2f}%"
              f" ({report['join_seconds']}s)")
        mark_done(joined_marker)
    else:
        n = conn.execute("SELECT count(*) FROM clusters").fetchone()[0]
        print(f"[clusters] already joined ({n:,} rows)")
    conn.close()


# ---------------------------------------------------------------- small tables

def stage_small():
    fresh = not CORPUS_DB.exists() or CORPUS_DB.stat().st_size == 0
    conn = db_connect(CORPUS_DB)
    if fresh:
        init_corpus(conn)

    if not is_done(BULK / "courts.done"):
        rows = []
        for i, r in enumerate(open_csv_bz2(BULK / "courts-2026-06-30.csv.bz2")):
            if i == 0:
                idx = header_index(r)
                continue
            rows.append((r[idx["id"]], r[idx["full_name"]], r[idx["jurisdiction"]],
                         r[idx["citation_string"]] or None, r[idx["parent_court_id"]] or None))
        conn.executemany(
            "INSERT OR REPLACE INTO courts(id,name,jurisdiction,citation_string,parent_id)"
            " VALUES (?,?,?,?,?)", rows)
        conn.commit()
        mark_done(BULK / "courts.done")
        print(f"[courts] {len(rows)}")

    if not is_done(BULK / "judges.done"):
        rows = []
        for i, r in enumerate(open_csv_bz2(BULK / "people-db-people-2026-06-30.csv.bz2")):
            if i == 0:
                idx = header_index(r)
                continue
            jid = guard_int(r[idx["id"]])
            if jid is not None:
                rows.append((jid, r[idx["name_first"]], r[idx["name_last"]],
                             guard_int(r[idx["fjc_id"]])))
        conn.executemany(
            "INSERT OR REPLACE INTO judges(id,name_first,name_last,fjc_id) VALUES (?,?,?,?)", rows)
        conn.commit()
        mark_done(BULK / "judges.done")
        print(f"[judges] {len(rows)}")

    if not is_done(BULK / "citations.done"):
        tick = progress_logger("citations", every=1_000_000)
        batch = []
        for i, r in enumerate(open_csv_bz2(BULK / "citations-2026-06-30.csv.bz2")):
            if i == 0:
                idx = header_index(r)
                continue
            cl = guard_int(r[idx["cluster_id"]])
            if cl is not None:
                vol = r[idx["volume"]].strip()
                pg = r[idx["page"]].strip()
                # normalize numeric fields to match lookup (P1-3)
                try:
                    vol = str(int(vol)) if vol else vol
                except ValueError:
                    pass
                try:
                    pg = str(int(pg)) if pg else pg
                except ValueError:
                    pg = "".join(ch for ch in pg if ch.isdigit()) or pg
                    try:
                        pg = str(int(pg)) if pg else pg
                    except ValueError:
                        pass
                batch.append((cl, vol, r[idx["reporter"]].strip(),
                              pg, r[idx["type"]]))
            tick()
            if len(batch) >= 1_000_000:
                conn.executemany("INSERT INTO citation_strings VALUES (?,?,?,?,?)", batch)
                conn.commit()
                batch.clear()
        if batch:
            conn.executemany("INSERT INTO citation_strings VALUES (?,?,?,?,?)", batch)
            conn.commit()
        n = conn.execute("SELECT count(*) FROM citation_strings").fetchone()[0]
        print(f"[citation_strings] {n:,}")
        mark_done(BULK / "citations.done")
    conn.close()


# ---------------------------------------------------------------- citation-map

def stage_citormap():
    conn = db_connect(CORPUS_DB)
    if not is_done(BULK / "citormap.done"):
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute("""CREATE TABLE IF NOT EXISTS citormap (
            citing_opinion_id INTEGER, cited_opinion_id INTEGER, depth INTEGER)""")
        tick = progress_logger("citormap", every=10_000_000)
        batch = []
        for i, r in enumerate(open_csv_bz2(BULK / "citation-map-2026-06-30.csv.bz2")):
            if i == 0:
                idx = header_index(r)
                continue
            c = guard_int(r[idx["citing_opinion_id"]])
            d = guard_int(r[idx["cited_opinion_id"]])
            if c is not None and d is not None:
                batch.append((c, d, guard_int(r[idx["depth"]])))
            tick()
            if len(batch) >= 2_000_000:
                conn.executemany("INSERT INTO citormap VALUES (?,?,?)", batch)
                conn.commit()
                batch.clear()
        if batch:
            conn.executemany("INSERT INTO citormap VALUES (?,?,?)", batch)
            conn.commit()
        n = conn.execute("SELECT count(*) FROM citormap").fetchone()[0]
        print(f"[citormap] {n:,} edges")
        mark_done(BULK / "citormap.done")
    else:
        print("[citormap] already done")
    conn.close()


# ---------------------------------------------------------------- parentheticals

def stage_parentheticals():
    import bz2

    conn = db_connect(CORPUS_DB)
    if not is_done(BULK / "parentheticals.done"):
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        fh = csv.reader(
            bz2.open(str(BULK / "parentheticals-2026-06-30.csv.bz2"), "rt",
                     encoding="utf-8", errors="replace"),
            **CSV_KWARGS)
        idx = header_index(next(fh))
        tick = progress_logger("parentheticals", every=1_000_000)
        buf = []
        rid = 0
        for r in fh:
            txt = r[idx["text"]]
            if not txt:
                continue
            rid += 1
            buf.append((rid, guard_int(r[idx["described_opinion_id"]]),
                        guard_int(r[idx["describing_opinion_id"]]), txt,
                        float(r[idx["score"]] or 0)))
            tick()
            if len(buf) >= 500_000:
                conn.executemany(
                    "INSERT INTO parentheticals(rowid,described_id,describing_id,text,score)"
                    " VALUES (?,?,?,?,?)", buf)
                conn.commit()
                buf.clear()
        if buf:
            conn.executemany(
                "INSERT INTO parentheticals(rowid,described_id,describing_id,text,score)"
                " VALUES (?,?,?,?,?)", buf)
            conn.commit()
        conn.execute("INSERT INTO parentheticals_fts(parentheticals_fts) VALUES ('rebuild')")
        conn.commit()
        n = conn.execute("SELECT count(*) FROM parentheticals").fetchone()[0]
        print(f"[parentheticals] {n:,}")
        mark_done(BULK / "parentheticals.done")
    else:
        print("[parentheticals] already done")
    conn.close()


# ---------------------------------------------------------------- shard worker

def find_resync(f, start):
    """Shard resync: delegate to the canonical BOUNDARY_RE in common.py."""
    # 64 MB lookahead is enough for any record; use a huge end sentinel.
    # The caller (iter_records) bounds the shard by nominal_end and stops
    # yielding once the next boundary is at/after that offset — so the
    # sentinel here does not change semantics, it just reuses the single
    # canonical scanner.
    end = start + 256 * 1024 * 1024
    off = find_resync_offset(f, start, end)
    return off if off != end else None


def iter_records(path, index, total):
    """Yield (fields_list_or_None, expected_leading_id) per CSV record within byte range."""
    size = path.stat().st_size
    nominal_start = 0 if index == 0 else (size // total) * index
    nominal_end = size if index == total - 1 else (size // total) * (index + 1)
    f = open(path, "rb")
    try:
        if index == 0:
            f.readline()  # header
            real_start = f.tell()
        else:
            off = find_resync(f, nominal_start)
            if off is None:
                raise RuntimeError(f"shard {index}: no boundary after {nominal_start:,}")
            real_start = off
        pos = real_start
        f.seek(real_start)
        rec = []

        def parse(lines):
            m = LEADING_ID_RE.match(lines[0])
            expected = int(m.group(1)) if m else None
            raw = b"".join(lines).decode("utf-8", errors="replace")
            fields = next(csv.reader([raw], **CSV_KWARGS), [])
            return fields, expected

        while True:
            line_start = pos
            line = f.readline()
            if not line:
                if rec:
                    yield parse(rec)
                return
            is_boundary = bool(BOUNDARY_LINE_RE.match(line))
            if is_boundary and line_start >= nominal_end:
                if rec:
                    yield parse(rec)
                return
            if is_boundary and rec:
                yield parse(rec)
                rec = []
            rec.append(line)
            pos += len(line)
    finally:
        f.close()


def stage_shard(index, total):
    SHARDS.mkdir(parents=True, exist_ok=True)
    out_path = SHARDS / f"shard_{index}.sqlite"
    if is_done(out_path):
        print(f"[shard {index}] already done")
        return
    if out_path.exists():
        out_path.unlink()

    side = db_connect(CLUSTERS_DB, readonly=True)
    conn = sqlite3.connect(str(out_path))
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA cache_size=-262144")
    conn.executescript(SHARD_SCHEMA)

    tick = progress_logger(f"shard {index}", every=20_000)
    misaligned_run = 0
    n_rows = n_anchor = 0
    t0 = time.time()
    op_batch, an_batch = [], {}
    cache_cid, cache_row = None, None

    for fields, expected in iter_records(RAW / "opinions-2026-06-30.csv", index, total):
        oid = guard_int(fields[0]) if fields else None
        if oid is None or expected != oid:
            misaligned_run += 1
            if misaligned_run > 50:
                raise RuntimeError(f"shard {index}: desynced, aborting")
            continue
        misaligned_run = 0
        fmap = dict(zip(OPINION_HEADER, fields))
        cluster_id = guard_int(fmap.get("cluster_id"))
        if cluster_id == cache_cid:
            crow = cache_row
        else:
            crow = side.execute(
                "SELECT date_filed, case_name, case_name_short, precedential_status,"
                " citation_count, blocked, court_id FROM clusters WHERE id=?",
                (cluster_id,)).fetchone()
            cache_cid, cache_row = cluster_id, crow
        text, anchors = textclean.extract_text(fmap)
        op_batch.append((
            oid, cluster_id,
            crow[6] if crow else None,
            crow[0] if crow else None,
            crow[1] if crow else None,
            crow[2] if crow else None,
            crow[3] if crow else None,
            crow[4] if crow else 0,
            guard_int(fmap.get("author_id")),
            fmap.get("author_str"),
            fmap.get("type"),
            guard_int(fmap.get("page_count")),
            parse_bool(fmap.get("extracted_by_ocr")),
            (crow[5] if crow else 0) or 0,
            text,
        ))
        for cited, start, _end in anchors:
            key = (oid, cited)
            if key not in an_batch:
                pre, post = textclean.context_window(text, start, _end)
                ctx = (pre + " … " + post).strip(" …")[:600]
                an_batch[key] = (start, ctx)
                n_anchor += 1
        tick()
        n_rows += 1
        if len(op_batch) >= 2000:
            flush(conn, op_batch, an_batch)
            op_batch, an_batch = [], {}

    if op_batch or an_batch:
        flush(conn, op_batch, an_batch)
    conn.commit()
    conn.close()
    side.close()
    mark_done(out_path)
    print(f"[shard {index}] DONE {n_rows:,} opinions, {n_anchor:,} anchored cites "
          f"in {(time.time()-t0)/60:.1f} min")


def flush(conn, op_batch, an_batch):
    conn.executemany("INSERT OR REPLACE INTO opinions VALUES (" + ",".join(["?"] * 15) + ")",
                     op_batch)
    if an_batch:
        conn.executemany("INSERT OR IGNORE INTO anchors VALUES (?,?,?,?)",
                         [(k[0], k[1], v[0], v[1]) for k, v in an_batch.items()])


# ---------------------------------------------------------------- merge

def stage_merge(total):
    missing = [i for i in range(total) if not is_done(SHARDS / f"shard_{i}.sqlite")]
    if missing:
        sys.exit(f"merge aborted — incomplete shards: {missing}")

    conn = db_connect(CORPUS_DB)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-1048576")  # 1 GB
    init_corpus(conn)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS anchors (
            citing_id INTEGER NOT NULL, cited_id INTEGER NOT NULL,
            char_pos INTEGER, context TEXT);
    """)

    conn.execute(
        """CREATE TABLE IF NOT EXISTS _merge_shards (
               i INTEGER PRIMARY KEY
           ) WITHOUT ROWID"""
    )
    merged = {r[0] for r in conn.execute("SELECT i FROM _merge_shards")}

    m_opinions = SHARDS / "merge.opinions.done"
    if not m_opinions.exists():
        print(f"[merge] inserting opinions ({len(merged)}/{total} already done)...", flush=True)
        for i in range(total):
            if i in merged:
                continue
            path = str(SHARDS / f"shard_{i}.sqlite").replace("'", "''")
            conn.execute(f"ATTACH DATABASE '{path}' AS sh{i}")
            min_id = conn.execute(f"SELECT min(id) FROM sh{i}.opinions").fetchone()[0]
            if min_id is not None and conn.execute(
                "SELECT 1 FROM main.opinions WHERE id=?", (min_id,)
            ).fetchone():
                conn.execute("INSERT OR IGNORE INTO _merge_shards VALUES (?)", (i,))
                conn.commit()
                conn.execute(f"DETACH DATABASE sh{i}")
                print(f"  shard {i}: already present, skipped", flush=True)
                continue
            t0 = time.time()
            conn.execute("BEGIN")
            conn.execute(f"INSERT INTO main.opinions SELECT * FROM sh{i}.opinions")
            conn.execute(
                f"INSERT INTO main.anchors SELECT citing_id,cited_id,char_pos,context"
                f" FROM sh{i}.anchors")
            conn.execute("INSERT INTO main._merge_shards VALUES (?)", (i,))
            conn.commit()
            conn.execute(f"DETACH DATABASE sh{i}")
            print(f"  shard {i}: {time.time()-t0:.0f}s", flush=True)
        mark_done(m_opinions)
    n_ops = conn.execute("SELECT count(*) FROM opinions").fetchone()[0]
    print(f"[merge] opinions={n_ops:,}")

    m_cites = SHARDS / "merge.cites.done"
    if not m_cites.exists():
        print("[merge] building cites from citormap × anchors...")
        t0 = time.time()
        conn.execute("DELETE FROM cites")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_anchors"
                     " ON anchors(citing_id, cited_id)")
        conn.execute("""
            INSERT INTO cites(citing_id, cited_id, depth, char_pos, context)
            SELECT m.citing_opinion_id, m.cited_opinion_id, m.depth, a.char_pos, a.context
            FROM citormap m
            LEFT JOIN anchors a
              ON a.citing_id = m.citing_opinion_id AND a.cited_id = m.cited_opinion_id
        """)
        conn.commit()
        print(f"  map edges: {(time.time()-t0)/60:.1f} min")
        t0 = time.time()
        conn.execute("CREATE INDEX IF NOT EXISTS ix_citemap_pair"
                     " ON citormap(citing_opinion_id, cited_opinion_id)")
        conn.execute("""
            INSERT INTO cites(citing_id, cited_id, depth, char_pos, context)
            SELECT a.citing_id, a.cited_id, NULL, a.char_pos, a.context
            FROM anchors a
            WHERE NOT EXISTS (SELECT 1 FROM citormap m WHERE
                  m.citing_opinion_id = a.citing_id AND m.cited_opinion_id = a.cited_id)
        """)
        conn.commit()
        print(f"  anchor-only edges: {(time.time()-t0)/60:.1f} min")
        mark_done(m_cites)
    n_cites = conn.execute("SELECT count(*) FROM cites").fetchone()[0]
    n_ctx = conn.execute("SELECT count(*) FROM cites WHERE context IS NOT NULL").fetchone()[0]
    n_pos = conn.execute("SELECT count(*) FROM cites WHERE char_pos IS NOT NULL").fetchone()[0]
    print(f"[merge] cites={n_cites:,} ({n_ctx:,} with context, {n_pos:,} with char_pos)")

    m_fts = SHARDS / "merge.fts.done"
    if not m_fts.exists():
        print("[merge] rebuilding FTS5 index (long)...")
        t0 = time.time()
        conn.execute("INSERT INTO opinions_fts(opinions_fts) VALUES ('rebuild')")
        conn.commit()
        print(f"[merge] FTS5 rebuilt in {(time.time()-t0)/60:.1f} min")
        mark_done(m_fts)

    m_final = SHARDS / "merge.final.done"
    if not m_final.exists():
        print("[merge] indexes + analyze...")
        conn.executescript("""
            CREATE INDEX IF NOT EXISTS idx_cites_cited ON cites(cited_id);
            CREATE INDEX IF NOT EXISTS idx_cites_citing ON cites(citing_id);
            CREATE INDEX IF NOT EXISTS idx_cs_vrp ON citation_strings(volume, reporter, page);
            CREATE INDEX IF NOT EXISTS idx_cs_cluster ON citation_strings(cluster_id);
            CREATE INDEX IF NOT EXISTS idx_paren_described ON parentheticals(described_id);
            CREATE INDEX IF NOT EXISTS idx_opinions_cluster ON opinions(cluster_id);
            DROP INDEX IF EXISTS ux_anchors;
            DROP TABLE IF EXISTS citormap;
            DROP TABLE IF EXISTS anchors;
            ANALYZE;
        """)
        conn.commit()
        mark_done(m_final)

    conn.close()
    print("[merge] complete")


# ---------------------------------------------------------------- CLI

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=[
        "clusters-dockets", "clusters-join", "small", "citormap",
        "parentheticals", "shard", "merge"])
    ap.add_argument("--index", type=int)
    ap.add_argument("--total", type=int, default=12)
    args = ap.parse_args()
    fn = {
        "clusters-dockets": stage_clusters_dockets,
        "clusters-join": stage_clusters_join,
        "small": stage_small,
        "citormap": stage_citormap,
        "parentheticals": stage_parentheticals,
        "merge": lambda: stage_merge(args.total),
        "shard": lambda: stage_shard(args.index, args.total),
    }[args.stage]
    fn()


if __name__ == "__main__":
    main()
