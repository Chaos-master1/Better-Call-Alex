"""Authority builder (CLAUDE.md §3 retrieval step 4).

Populates the empty `authority` table:
    authority(opinion_id PK, pagerank REAL, recent_cites_2y INTEGER,
              treatment_flags INTEGER)

Stages (each resumable, run in order):
  scan      one streaming pass over cites:
            - valid edges (both endpoints in opinions) -> .npy chunks in
              data/.authority/ (orphan rates measured in docs/g0-audit.md)
            - negative-language treatment flags per cited opinion, from
              cites.context (INFERRED signal, never asserted fact — §5.5)
  pagerank  dedupe edges, power iteration on scipy.sparse CSR over all
            opinion ids (dangling mass redistributed uniformly)
  write     bulk-insert pagerank + recent_cites_2y + treatment_flags
  reflag    re-scan cites.context with the current scanner and refresh
            authority.treatment_flags wholesale (clears stale flags) —
            no edge/pagerank recompute

Recency anchor: SNAPSHOT_CUTOFF (2026-06-30 minus 2y), deterministic — §5.7.
Treatment bits: 1 overrul*-family (overrul*, disapprov*, supersed*,
                 "depart* from", "no longer good law/controlling/followed/
                 valid" — extended 2026-08-24 against the LegalBench/Casetext
                 Overruling set: recall .525 -> .774 at FPR .011 -> .014),
                2 abrogat*, 4 distinguish*, 8 "but see", 16 "declined to follow".
("reject" was tested and deliberately excluded: +2pp recall cost +1.3pp FPR.)
"""

import argparse
import csv
import json
import re
import sys
import time
from pathlib import Path

import numpy as np

from common import CORPUS_DB, DATA, db_connect, progress_logger

AUTH_DIR = DATA / ".authority"
SNAPSHOT_CUTOFF = 20240630  # 2026-06-30 snapshot minus 2 years, as YYYYMMDD

TREATMENT_RE = re.compile(
    r"(?P<ovr>\boverrul\w*)"
    r"|(?P<abg>abrogat\w*)"
    r"|(?P<dis>distinguish\w*)"
    r"|(?P<buts>\bbut see\b)"
    r"|(?P<dtf>\bdeclined to follow\b)"
    r"|(?P<disapp>\bdisapprov\w*)"
    r"|(?P<sup>\bsupersed\w*)"
    r"|(?P<dep>\bdepart\w* from\b)"
    r"|(?P<nlg>\bno longer (?:good law|controlling|followed|valid)\b)",
    re.I,
)
BIT = {
    "ovr": 1, "abg": 2, "dis": 4, "buts": 8, "dtf": 16,
    # overruling-family extensions fold into the overruled bit (bit 1):
    "disapp": 1, "sup": 1, "dep": 1, "nlg": 1,
}

# ---- proven scanner (treatment_proven) -------------------------------------
# The aggregate flag above unions ALL citing contexts of an opinion and is
# annotation-only. The PROVEN scanner (proven_stage) is the strike-grade
# signal: sentence-scoped, negation-vetoed, quote-excluded, date-guarded.
# Measured F1 audit (2026-09-24, live corpus):
#   - negation: Roe 26/260, Miranda 169/1756 overrul*-mention contexts are
#     negated (~10%) — "never been overruled" must never flag overruled;
#   - date bleed: 13% of overruled-flagged opinions carry citing dates
#     BEFORE the cited decision — the ±150-char context window straddles
#     sentence boundaries, so only the citation's own sentence counts.
PROVEN_MIN_DATE_COVERAGE = 0.90

NEGATION_RE = re.compile(
    r"(?:\b(?:not|never|no|nor|neither|without|hardly|scarcely)\b|n't)"
    r"[^.;]{0,60}?"
    r"(?:overrul\w*|abrogat\w*|disapprov\w*|supersed\w*|depart\w*\s+from"
    r"|no\s+longer\s+(?:good\s+law|controlling|followed|valid))"
    r"|(?:overrul\w*|abrogat\w*|disapprov\w*|supersed\w*)"
    r"[^.;]{0,40}?"
    r"\b(?:not|never|no|nor|neither)\b",
    re.I,
)


def _inside_quotation(sent: str) -> bool:
    """True when the FIRST treatment match sits inside a quotation:
    a matching quote pair around it ("... which was overruled in ...") is
    evidence about the quoted words, not the citer's holding. An unpaired
    quote char (nested markup, apostrophe handling) stays eligible."""
    m = TREATMENT_RE.search(sent)
    qpos = [q.start() for q in re.finditer(r'[\u201c"]', sent)]
    return len(qpos) >= 2 and qpos[0] < m.start() < qpos[-1]


def _proven_flags_from_context(ctx: str) -> int:
    """Strict per-edge treatment: sentence-scoped, negation-vetoed,
    quote-excluded. Returns a bitfield over BIT."""
    if not ctx:
        return 0
    b = 0
    for sent in re.split(r"(?<=[.!?])\s+", ctx):
        if not TREATMENT_RE.search(sent):
            continue
        if NEGATION_RE.search(sent):
            continue
        if _inside_quotation(sent):
            continue
        for m in TREATMENT_RE.finditer(sent):
            b |= BIT[m.lastgroup]
    return b


def load_opinions(conn):
    """All opinion ids (sorted int64) + filing dates as YYYYMMDD ints (0 if bad).

    Chunked into preallocated numpy arrays: list-of-Python-ints costs ~500 MB
    here and contributed to the OOM kill of 2026-08-24 (journalctl).
    """
    n = conn.execute("SELECT count(*) FROM opinions").fetchone()[0]
    ids = np.empty(n, dtype=np.int64)
    dates = np.empty(n, dtype=np.int32)
    cur = conn.execute("SELECT id, date_filed FROM opinions")
    i = 0
    while True:
        rows = cur.fetchmany(200_000)
        if not rows:
            break
        for oid, df in rows:
            d = 0
            if df and len(df) == 10:
                try:
                    y, m, dd = df[:4], df[5:7], df[8:10]
                    if 1600 <= int(y) <= 2026:
                        d = int(y) * 10000 + int(m) * 100 + int(dd)
                except ValueError:
                    d = 0
            ids[i] = oid
            dates[i] = d
            i += 1
    order = np.argsort(ids)
    ids = ids[order]
    dates = dates[order]
    # P2-7: guard the 1<<25 encoding in load_edges (collision if id >= 33M)
    if len(ids) and int(ids.max()) >= (1 << 25):
        raise ValueError(f"max opinion id {int(ids.max())} >= 1<<25, bump k in load_edges")
    return ids, dates


# ---------------------------------------------------------------- scan

def _save_chunk(parts, src_buf, dst_buf, outdir):
    Path(outdir).mkdir(parents=True, exist_ok=True)
    np.save(Path(outdir) / f"edges_part{parts:04d}.npy",
            np.stack([np.asarray(src_buf, dtype=np.int64),
                      np.asarray(dst_buf, dtype=np.int64)]))
    return parts + 1


def scan_stage(conn, outdir=AUTH_DIR, chunk_rows=5_000_000):
    outdir = Path(outdir)
    ckpt_path = outdir / "scan.progress.json"
    state = {"last_rowid": 0, "parts": 0, "rows_seen": 0}
    if ckpt_path.exists():
        state = json.loads(ckpt_path.read_text())
        print(f"[scan] resuming at rowid>{state['last_rowid']:,} "
              f"({state['parts']} parts, {state['rows_seen']:,} rows seen)")

    ids, dates = load_opinions(conn)
    print(f"[scan] opinions={len(ids):,}")

    flags = {}  # cited_id -> bitfield
    src_buf, dst_buf = [], []
    tick = progress_logger("scan", every=5_000_000)
    t0 = time.time()
    cur = conn.execute(
        "SELECT rowid, citing_id, cited_id, context FROM cites WHERE rowid > ?",
        (state["last_rowid"],))
    n_ids = len(ids)
    while True:
        rows = cur.fetchmany(200_000)
        if not rows:
            break
        max_rowid = state["last_rowid"]
        ci = np.searchsorted(ids, np.fromiter((r[1] for r in rows),
                                              dtype=np.int64, count=len(rows)))
        cj = np.searchsorted(ids, np.fromiter((r[2] for r in rows),
                                              dtype=np.int64, count=len(rows)))
        valid_arr = ((ci < n_ids) & (cj < n_ids)
                     & (ids[np.minimum(ci, n_ids - 1)]
                        == np.fromiter((r[1] for r in rows), dtype=np.int64,
                                       count=len(rows)))
                     & (ids[np.minimum(cj, n_ids - 1)]
                        == np.fromiter((r[2] for r in rows), dtype=np.int64,
                                       count=len(rows))))
        for k, (rid, citing, cited, ctx) in enumerate(rows):
            max_rowid = rid
            if valid_arr[k]:
                src_buf.append(citing)
                dst_buf.append(cited)
                if ctx and TREATMENT_RE.search(ctx):
                    b = 0
                    for m in TREATMENT_RE.finditer(ctx):
                        b |= BIT[m.lastgroup]
                    flags[cited] = flags.get(cited, 0) | b
            tick()
        state["rows_seen"] += len(rows)
        state["last_rowid"] = max_rowid
        if len(src_buf) >= chunk_rows:
            state["parts"] = _save_chunk(state["parts"], src_buf, dst_buf, outdir)
            src_buf.clear()
            dst_buf.clear()
            ckpt_path.write_text(json.dumps(state))
    if src_buf:
        state["parts"] = _save_chunk(state["parts"], src_buf, dst_buf, outdir)

    np.savez_compressed(outdir / "treatment.npz",
                        ids=np.asarray(sorted(flags), dtype=np.int64),
                        vals=np.asarray([flags[k] for k in sorted(flags)],
                                        dtype=np.int32))
    state["scan_done"] = True
    ckpt_path.write_text(json.dumps(state))
    print(f"[scan] DONE {state['parts']} parts, {state['rows_seen']:,} rows, "
          f"{len(flags):,} flagged, {(time.time()-t0)/60:.1f} min")


# ---------------------------------------------------------------- pagerank

def load_edges(outdir=AUTH_DIR):
    """Deduped edge arrays as int64 ids.

    Memory-safe path (OOM kill of 2026-08-24): one preallocated key buffer
    filled part-by-part, in-place sort, then a single masked copy — peak
    ~2×845 MB instead of ~5 GB of stacked temporaries.

    If edges_unique.npy exists (written by pagerank_stage), loads it directly.
    """
    outdir = Path(outdir)
    cached = outdir / "edges_unique.npz"
    if cached.exists():
        z = np.load(cached)
        return z["src"], z["dst"]
    parts = sorted(outdir.glob("edges_part*.npy"))
    assert parts, "run `scan` first"
    total = sum(np.load(p, mmap_mode="r").shape[1] for p in parts)
    k = np.int64(1) << np.int64(25)  # 33_554_432 > max opinion id (~11M)
    # Guard against future id overflow (silent collision if k <= max id)
    # max id will be checked in load_opinions caller; keep k documented.
    key = np.empty(total, dtype=np.int64)
    at = 0
    for p in parts:
        a = np.load(p)
        n = a.shape[1]
        key[at:at + n] = a[0].astype(np.int64) * k + a[1].astype(np.int64)
        at += n
        del a
    assert at == total
    key.sort()
    keep = np.empty(total, dtype=bool)
    keep[0] = True
    np.not_equal(key[1:], key[:-1], out=keep[1:])
    src = key[keep] // k
    dst = key[keep] % k
    del key, keep
    return src.astype(np.int32), dst.astype(np.int32)


def pagerank_arrays(nodes, src, dst, alpha=0.85, tol=1e-5, max_iter=150,
                    verbose=False):
    """Power iteration. Builds the TRANSPOSE directly as CSR (rows = cited
    opinion, cols = citing, data = 1/outdeg(citing)) — no transpose copy.
    float32 throughout: ranking-grade precision at ~1e-5 L1 tolerance."""
    import scipy.sparse as sp

    n = len(nodes)
    s = np.searchsorted(nodes, src).astype(np.int32)
    d = np.searchsorted(nodes, dst).astype(np.int32)
    outdeg = np.bincount(s, minlength=n)
    inv = (1.0 / np.maximum(outdeg, 1)).astype(np.float32)[s]
    adj_t = sp.coo_matrix(
        (inv, (d, s)), shape=(n, n), dtype=np.float32).tocsr()
    del s, d, inv
    dangling = outdeg == 0
    r = np.full(n, 1.0 / n, dtype=np.float32)
    for it in range(max_iter):
        dang = float(r[dangling].sum(dtype=np.float64))
        rn = alpha * (adj_t @ r + dang / n) + (1.0 - alpha) / n
        # The float64 scalar promotes the sum: cast back every iteration so
        # the "float32 throughout" budget (~43 MB, not ~86 MB) actually holds.
        rn = np.asarray(rn, dtype=np.float32)
        err = float(np.abs(rn - r).sum(dtype=np.float64))
        r = rn
        if verbose:
            print(f"[pagerank] iter {it + 1}: l1_delta={err:.3e}", flush=True)
        if err < tol:
            break
    return r.astype(np.float64), it + 1


def pagerank_stage(conn, outdir=AUTH_DIR):
    outdir = Path(outdir)
    t0 = time.time()
    nodes, _ = load_opinions(conn)
    src, dst = load_edges(outdir)
    np.savez(outdir / "edges_unique.npz", src=src, dst=dst)  # reuse in write
    print(f"[pagerank] nodes={len(nodes):,} dedup_edges={len(src):,}", flush=True)
    r, iters = pagerank_arrays(nodes, src, dst, verbose=True)
    np.save(Path(outdir) / "pagerank.npy", r)
    summary = {
        "nodes": int(len(nodes)),
        "dedup_edges": int(len(src)),
        "iters": iters,
        "mass": float(r.sum()),
        "top5": [
            {"id": int(nodes[i]), "pr": round(float(r[i]), 8)}
            for i in np.argsort(r)[::-1][:5]
        ],
        "minutes": round((time.time() - t0) / 60, 1),
    }
    (Path(outdir) / "pagerank.summary.json").write_text(
        json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------- write

def write_stage(conn, outdir=AUTH_DIR):
    outdir = Path(outdir)
    t0 = time.time()
    nodes, dates = load_opinions(conn)
    pr = np.load(outdir / "pagerank.npy")

    src, dst = load_edges(outdir)
    sd = dates[np.searchsorted(nodes, src)]
    recent = np.zeros(len(nodes), dtype=np.int32)
    mask = sd >= SNAPSHOT_CUTOFF
    tgt = np.searchsorted(nodes, dst[mask])
    # Membership guard: a stale edge id must index nothing, not the wrong
    # row. (Edges are valid by construction from scan; this is the
    # one-line insurance against an IndexError hours into the write.)
    if len(nodes):
        tgt = tgt[(tgt < len(nodes)) & (nodes[np.minimum(tgt, len(nodes) - 1)] == dst[mask])]
    else:
        tgt = tgt[:0]
    np.add.at(recent, tgt, 1)

    tr = np.load(outdir / "treatment.npz")
    tflags = np.zeros(len(nodes), dtype=np.int32)
    ti = np.searchsorted(nodes, tr["ids"])
    if len(nodes):
        ok = (ti < len(nodes)) & (nodes[np.minimum(ti, len(nodes) - 1)] == tr["ids"])
        tflags[ti[ok]] = tr["vals"][ok]
    # else: empty corpus — tflags stays zeros; no index is valid.

    conn.commit()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript("DELETE FROM authority;")
    batch = []
    n = len(nodes)
    tick = progress_logger("write", total=n, every=1_000_000)
    for i in range(n):
        oid = int(nodes[i])
        batch.append((oid, float(pr[i]), int(recent[i]), int(tflags[i])))
        if len(batch) >= 200_000:
            conn.executemany("INSERT OR REPLACE INTO authority VALUES (?,?,?,?)",
                             batch)
            conn.commit()
            batch.clear()
            tick(200_000)
    if batch:
        conn.executemany("INSERT OR REPLACE INTO authority VALUES (?,?,?,?)",
                         batch)
        conn.commit()

    n_pr = conn.execute(
        "SELECT count(*) FROM authority WHERE pagerank > 0").fetchone()[0]
    n_recent = conn.execute(
        "SELECT count(*) FROM authority WHERE recent_cites_2y > 0").fetchone()[0]
    n_flag = conn.execute(
        "SELECT count(*) FROM authority WHERE treatment_flags > 0").fetchone()[0]
    top = conn.execute(
        """SELECT o.case_name, a.pagerank FROM authority a
           JOIN opinions o ON o.id = a.opinion_id
           ORDER BY a.pagerank DESC LIMIT 5""").fetchall()
    summary = {
        "rows": n, "pagerank_positive": int(n_pr),
        "recent_positive": int(n_recent), "flagged": int(n_flag),
        "top5_by_pagerank": [[t[0][:60], round(t[1], 8)] for t in top],
        "minutes": round((time.time() - t0) / 60, 1),
    }
    (Path(outdir) / "authority.summary.json").write_text(
        json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


# ---------------------------------------------------------------- reflag

# ---------------------------------------------------------------- proven

def proven_stage(conn, outdir=AUTH_DIR, out_csv=None):
    """STRICT good-law pass over citing edges -> treatment_proven table.

    Per edge (citing --context--> cited): sentence-scoped TREATMENT_RE match,
    NEGATION_RE veto, in-quote exclusion. Aggregate to the CITED opinion
    only when some qualifying citing opinion (a) post-dates the cited
    decision and (b) is a majority/combined opinion text. The date gate is
    checked first corpus-wide: under PROVEN_MIN_DATE_COVERAGE reliable dates
    the stage refuses (fail loud) rather than build strikes on date junk
    (measured F1 audit: 13% date-bleed in the loose aggregate).

    Writes treatment_proven(opinion_id PK, proven_flags, evidence_rowid) —
    the ONLY signal the verifier may strike on (CLAUDE.md §5.5: only
    provable claims gate the draft; authority.treatment_flags stays
    annotation-only). evidence_rowid anchors one real citing edge for
    verifier spot-checks.
    """
    outdir = Path(outdir)
    ckpt = outdir / "proven.progress.json"
    state = {"last_rowid": 0}
    if ckpt.exists():
        state = json.loads(ckpt.read_text())
        print(f"[proven] resuming at rowid>{state['last_rowid']:,}")

    # Date reliability gate: sample citing edges deterministically
    # (every 7th rowid, plus the first 1000 so small tables sample fully),
    # and measure the share whose dates are even parseable; under the
    # floor, refuse.
    probe = conn.execute(
        """SELECT ci.date_filed, cd.date_filed FROM cites ct
           JOIN opinions ci ON ci.id = ct.citing_id
           JOIN opinions cd ON cd.id = ct.cited_id
           WHERE ci.date_filed IS NOT NULL AND cd.date_filed IS NOT NULL
             AND (ct.rowid % 7 = 0 OR ct.rowid <= 1000)
           LIMIT 50000"""
    ).fetchall()
    usable = sum(
        1 for a, b in probe
        if len(a) == 10 and len(b) == 10 and a[:4].isdigit() and b[:4].isdigit()
    )
    if probe and (usable / len(probe)) < PROVEN_MIN_DATE_COVERAGE:
        raise SystemExit(
            f"[proven] date coverage {usable}/{len(probe)} below "
            f"{PROVEN_MIN_DATE_COVERAGE:.0%} — refusing to build a date-guarded "
            f"treatment table on unreliable dates (measured, not assumed)"
        )

    ids, dates = load_opinions(conn)
    id_index = {int(v): i for i, v in enumerate(ids.tolist())}
    flags = {}  # cited_id -> bitfield (candidate, pre writer-filter)
    tick = progress_logger("proven", every=5_000_000)
    t0 = time.time()
    cur = conn.execute(
        "SELECT rowid, citing_id, cited_id, context FROM cites WHERE rowid > ?",
        (state["last_rowid"],))
    while True:
        rows = cur.fetchmany(200_000)
        if not rows:
            break
        max_rowid = state["last_rowid"]
        for rid, citing, cited, ctx in rows:
            max_rowid = rid
            b = _proven_flags_from_context(ctx or "")
            if not b:
                continue
            i = id_index.get(citing, -1)
            j = id_index.get(cited, -1)
            if i < 0 or j < 0:
                continue
            di, dj = int(dates[i]), int(dates[j])
            if di == 0 or dj == 0 or di < dj:
                continue  # date guard (unknown dates never prove)
            flags[cited] = flags.get(cited, 0) | b
        state["last_rowid"] = max_rowid
        ckpt.write_text(json.dumps(state))
        tick(len(rows))

    print(f"[proven] scanned cites in {(time.time()-t0)/60:.1f} min; "
          f"{len(flags):,} candidate opinions; applying writer filter")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("DROP TABLE IF EXISTS treatment_proven")
    conn.execute("""
        CREATE TABLE treatment_proven (
            opinion_id INTEGER PRIMARY KEY,
            proven_flags INTEGER NOT NULL,
            evidence_rowid INTEGER
        )
    """)
    conn.execute("CREATE INDEX idx_treatment_proven_flags ON treatment_proven(proven_flags)")
    conn.execute("DROP TABLE IF EXISTS _proven")
    conn.execute("CREATE TEMP TABLE _proven (opinion_id INTEGER PRIMARY KEY, flags INTEGER)")
    batch = []
    for oid, b in sorted(flags.items()):
        batch.append((oid, b))
        if len(batch) >= 100_000:
            conn.executemany("INSERT OR REPLACE INTO _proven VALUES (?, ?)", batch)
            batch.clear()
    if batch:
        conn.executemany("INSERT OR REPLACE INTO _proven VALUES (?, ?)", batch)
    # Writer filter + evidence anchor in one INSERT: keep only cited
    # opinions with a qualifying citing edge whose citing text is a
    # majority/combined opinion; store ONE evidence edge (latest citing
    # date) per cited opinion for verifier spot-checks.
    conn.execute("""
        INSERT INTO treatment_proven (opinion_id, proven_flags, evidence_rowid)
        SELECT p.opinion_id, p.flags,
               (SELECT ct.rowid FROM cites ct
                JOIN opinions ci ON ci.id = ct.citing_id
                WHERE ct.cited_id = p.opinion_id AND ct.context IS NOT NULL
                ORDER BY ci.date_filed DESC LIMIT 1)
        FROM _proven p
        WHERE EXISTS (
            SELECT 1 FROM cites ct
            JOIN opinions ci ON ci.id = ct.citing_id
            WHERE ct.cited_id = p.opinion_id
              AND ct.context IS NOT NULL
              AND ci.type IN ('010combined')
        )
    """)
    conn.execute("DROP TABLE _proven")
    conn.commit()
    np.savez_compressed(outdir / "treatment_proven.npz",
                        ids=np.asarray(sorted(flags), dtype=np.int64),
                        vals=np.asarray([flags[k] for k in sorted(flags)],
                                        dtype=np.int32))
    if out_csv:
        with open(out_csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["opinion_id", "proven_flags", "evidence_rowid"])
            for row in conn.execute(
                    "SELECT opinion_id, proven_flags, evidence_rowid FROM treatment_proven"):
                w.writerow(row)
        print(f"[proven] csv snapshot -> {out_csv}")

    n_flag = conn.execute("SELECT count(*) FROM treatment_proven").fetchone()[0]
    n_ovr = conn.execute(
        "SELECT count(*) FROM treatment_proven WHERE proven_flags & 1 = 1").fetchone()[0]
    n_ev = conn.execute(
        "SELECT count(*) FROM treatment_proven WHERE evidence_rowid IS NOT NULL").fetchone()[0]
    summary = {
        "proven_flagged_total": int(n_flag),
        "proven_overruled_family": int(n_ovr),
        "proven_with_evidence_edge": int(n_ev),
        "date_coverage_probe": [usable, len(probe)],
        "minutes": round((time.time() - t0) / 60, 1),
    }
    (outdir / "proven.summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


def reflag_stage(conn, outdir=AUTH_DIR):
    """Re-scan cites.context with the CURRENT TREATMENT_RE and update only
    authority.treatment_flags. Used when the scanner improves — avoids
    recomputing edges/pagerank (CLAUDE.md: measured, not assumed).

    Streaming, resumable by rowid checkpoint like scan_stage.
    """
    outdir = Path(outdir)
    ckpt = outdir / "reflag.progress.json"
    state = {"last_rowid": 0}
    if ckpt.exists():
        state = json.loads(ckpt.read_text())
        print(f"[reflag] resuming at rowid>{state['last_rowid']:,}")

    flags: dict[int, int] = {}
    tick = progress_logger("reflag", every=5_000_000)
    t0 = time.time()
    cur = conn.execute(
        "SELECT rowid, cited_id, context FROM cites WHERE rowid > ? AND context IS NOT NULL",
        (state["last_rowid"],))
    while True:
        rows = cur.fetchmany(200_000)
        if not rows:
            break
        max_rowid = state["last_rowid"]
        for rid, cited, ctx in rows:
            max_rowid = rid
            if not ctx:
                continue
            b = 0
            for m in TREATMENT_RE.finditer(ctx):
                b |= BIT[m.lastgroup]
            if b:
                flags[cited] = flags.get(cited, 0) | b
        state["last_rowid"] = max_rowid
        ckpt.write_text(json.dumps(state))
        tick(len(rows))

    print(f"[reflag] scanned cites in {(time.time()-t0)/60:.1f} min; "
          f"{len(flags):,} flagged opinions")
    # Apply via temp table + full refresh (not UPDATE-only): a narrowed
    # scanner must CLEAR stale flags, not just set new ones, and orphan
    # cited_ids (no authority row) must affect nothing. treatment.npz is
    # rewritten too so write_stage stays consistent with authority.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("DROP TABLE IF EXISTS _reflag")
    conn.execute("CREATE TEMP TABLE _reflag (opinion_id INTEGER PRIMARY KEY, flags INTEGER)")
    batch = []
    for oid, b in sorted(flags.items()):
        batch.append((oid, b))
        if len(batch) >= 100_000:
            conn.executemany("INSERT OR REPLACE INTO _reflag VALUES (?, ?)", batch)
            batch.clear()
    if batch:
        conn.executemany("INSERT OR REPLACE INTO _reflag VALUES (?, ?)", batch)
    conn.execute("""
        UPDATE authority
           SET treatment_flags = COALESCE(
                 (SELECT flags FROM _reflag WHERE opinion_id = authority.opinion_id), 0)
    """)
    conn.commit()
    conn.execute("DROP TABLE _reflag")
    conn.commit()
    np.savez_compressed(outdir / "treatment.npz",
                        ids=np.asarray(sorted(flags), dtype=np.int64),
                        vals=np.asarray([flags[k] for k in sorted(flags)],
                                        dtype=np.int32))

    n_flag = conn.execute(
        "SELECT count(*) FROM authority WHERE treatment_flags > 0").fetchone()[0]
    n_ovr = conn.execute(
        "SELECT count(*) FROM authority WHERE treatment_flags & 1 = 1").fetchone()[0]
    n_cleared = conn.execute(
        "SELECT count(*) FROM authority WHERE treatment_flags = 0").fetchone()[0]
    summary = {
        "flagged_total": int(n_flag),
        "overruled_family_total": int(n_ovr),
        "unflagged_total": int(n_cleared),
        "minutes": round((time.time() - t0) / 60, 1),
    }
    (outdir / "reflag.summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=["scan", "pagerank", "write", "reflag", "proven"])
    ap.add_argument("--csv", default=None, help="proven: also write a CSV snapshot here")
    args = ap.parse_args()
    readonly = args.stage in ("scan", "pagerank")
    conn = db_connect(CORPUS_DB, readonly=readonly)
    try:
        {"scan": scan_stage, "pagerank": pagerank_stage,
         "write": write_stage, "reflag": reflag_stage}[args.stage](conn) if args.stage != "proven" else proven_stage(conn, out_csv=args.csv)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
