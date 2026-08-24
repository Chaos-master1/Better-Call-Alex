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

Recency anchor: SNAPSHOT_CUTOFF (2026-06-30 minus 2y), deterministic — §5.7.
Treatment bits: 1 overrul*-family (overrul*, abrogat*, disapprov*, supersed*,
                 "depart* from", "no longer good law/controlling/followed/
                 valid" — extended 2026-08-24 against the LegalBench/Casetext
                 Overruling set: recall .525 -> .774 at FPR .011 -> .014),
                4 distinguish*, 8 "but see", 16 "declined to follow".
("reject" was tested and deliberately excluded: +2pp recall cost +1.3pp FPR.)
"""

import argparse
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
    return ids[order], dates[order]


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
    k = np.int64(1) << np.int64(25)
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
    np.add.at(recent, tgt, 1)

    tr = np.load(outdir / "treatment.npz")
    tflags = np.zeros(len(nodes), dtype=np.int32)
    ti = np.searchsorted(nodes, tr["ids"])
    tflags[ti] = tr["vals"]

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
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    batch = []
    n_upd = 0
    for oid, b in sorted(flags.items()):
        batch.append((b, oid))
        if len(batch) >= 100_000:
            conn.executemany(
                "UPDATE authority SET treatment_flags=? WHERE opinion_id=?", batch)
            n_upd += len(batch)
            conn.commit()
            batch.clear()
    if batch:
        conn.executemany(
            "UPDATE authority SET treatment_flags=? WHERE opinion_id=?", batch)
        n_upd += len(batch)
        conn.commit()

    n_flag = conn.execute(
        "SELECT count(*) FROM authority WHERE treatment_flags > 0").fetchone()[0]
    n_ovr = conn.execute(
        "SELECT count(*) FROM authority WHERE treatment_flags & 1 = 1").fetchone()[0]
    summary = {
        "rows_updated": n_upd,
        "flagged_total": int(n_flag),
        "overruled_family_total": int(n_ovr),
        "minutes": round((time.time() - t0) / 60, 1),
    }
    (outdir / "reflag.summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=["scan", "pagerank", "write", "reflag"])
    args = ap.parse_args()
    readonly = args.stage in ("scan", "pagerank")
    conn = db_connect(CORPUS_DB, readonly=readonly)
    try:
        {"scan": scan_stage, "pagerank": pagerank_stage,
         "write": write_stage, "reflag": reflag_stage}[args.stage](conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
