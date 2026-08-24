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
Treatment bits: 1 overrul*, 2 abrogat*, 4 distinguish*, 8 "but see",
                16 "declined to follow".
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
    r"|(?P<dtf>\bdeclined to follow\b)",
    re.I,
)
BIT = {"ovr": 1, "abg": 2, "dis": 4, "buts": 8, "dtf": 16}


def load_opinions(conn):
    """All opinion ids (sorted int64) + filing dates as YYYYMMDD ints (0 if bad)."""
    ids, dates = [], []
    for oid, df in conn.execute("SELECT id, date_filed FROM opinions"):
        d = 0
        if df and len(df) == 10:
            try:
                y, m, dd = df[:4], df[5:7], df[8:10]
                if 1600 <= int(y) <= 2026:
                    d = int(y) * 10000 + int(m) * 100 + int(dd)
            except ValueError:
                d = 0
        ids.append(oid)
        dates.append(d)
    return np.asarray(ids, dtype=np.int64), np.asarray(dates, dtype=np.int32)


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
    """Concatenate edge chunks, dedupe pairs via flat int64 keys.

    Opinion ids are < 2**25 (measured max 11,258,350), so (src, dst) packs into
    one int64: cheaper than np.unique(axis=1) by half the peak RAM.
    """
    parts = sorted(Path(outdir).glob("edges_part*.npy"))
    assert parts, "run `scan` first"
    srcs, dsts = [], []
    for p in parts:
        a = np.load(p)
        srcs.append(a[0])
        dsts.append(a[1])
    src = np.concatenate(srcs)
    dst = np.concatenate(dsts)
    del srcs, dsts
    k = np.int64(1) << np.int64(25)
    key = np.unique(src.astype(np.int64) * k + dst.astype(np.int64))
    return key // k, key % k


def pagerank_arrays(nodes, src, dst, alpha=0.85, tol=1e-8, max_iter=100,
                    verbose=False):
    import scipy.sparse as sp

    n = len(nodes)
    s = np.searchsorted(nodes, src).astype(np.int32)
    d = np.searchsorted(nodes, dst).astype(np.int32)
    adj = sp.coo_matrix(
        (np.ones(len(s), dtype=np.float64), (s, d)), shape=(n, n)).tocsr()
    del s, d
    # row-normalize by out-degree (dangling rows stay all-zero)
    rs = np.asarray(adj.sum(axis=1)).ravel()
    inv = np.where(rs > 0, 1.0 / np.where(rs > 0, rs, 1.0), 0.0)
    adj.data *= inv[np.repeat(np.arange(n), np.diff(adj.indptr))]
    at = adj.T.tocsr()
    dangling = rs == 0
    r = np.full(n, 1.0 / n)
    for it in range(max_iter):
        dang = r[dangling].sum()
        rn = alpha * (at @ r + dang / n) + (1.0 - alpha) / n
        err = np.abs(rn - r).sum()
        r = rn
        if verbose:
            print(f"[pagerank] iter {it + 1}: l1_delta={err:.3e}", flush=True)
        if err < tol:
            break
    return r, it + 1


def pagerank_stage(conn, outdir=AUTH_DIR):
    t0 = time.time()
    nodes, _ = load_opinions(conn)
    src, dst = load_edges(outdir)
    print(f"[pagerank] nodes={len(nodes):,} dedup_edges={len(src):,}")
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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=["scan", "pagerank", "write"])
    args = ap.parse_args()
    conn = db_connect(CORPUS_DB, readonly=(args.stage != "write"))
    try:
        {"scan": scan_stage, "pagerank": pagerank_stage,
         "write": write_stage}[args.stage](conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
