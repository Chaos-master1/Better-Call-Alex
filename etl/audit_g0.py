"""G0 deep-audit checks (CLAUDE.md §8 gate, post-build verification).

Each subcommand is independent, read-only unless stated, and appends a JSON
result to logs/audit/. Run order used for the G0 perfection pass:

    uv run python etl/audit_g0.py offsets
    uv run python etl/audit_g0.py clean
    uv run python etl/audit_g0.py seams
    uv run python etl/audit_g0.py fts-small
    uv run python etl/audit_g0.py stats
    uv run python etl/audit_g0.py fk --target parentheticals|citation_strings|cites_citing|cites_cited
    uv run python etl/audit_g0.py fts-big
"""

import argparse
import json
import random
import re
import sqlite3
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "etl"))

from common import CORPUS_DB, RAW, BOUNDARY_RE, CSV_KWARGS, guard_int  # noqa: E402

AUDIT_DIR = REPO / "logs" / "audit"
OPINIONS_SIZE = (RAW / "opinions-2026-06-30.csv").stat().st_size


def ro() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{CORPUS_DB}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only=1")
    conn.execute("PRAGMA cache_size=-262144")
    conn.set_progress_handler(lambda: (_progress(), 0)[1], 25_000_000)
    return conn


_progress_state = {"n": 0, "t0": time.time(), "last": time.time()}


def _progress():
    _progress_state["n"] += 1
    now = time.time()
    if now - _progress_state["last"] >= 30:
        _progress_state["last"] = now
        el = now - _progress_state["t0"]
        print(f"    ... {_progress_state['n']} progress ticks, {el:.0f}s elapsed",
              flush=True)


def save(name: str, result: dict):
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    result["check"] = name
    result["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    path = AUDIT_DIR / f"{name}.json"
    path.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2)[:2000])


# ---------------------------------------------------------------- offsets

def check_offsets(n_target: int, attempts_cap: int = 3000):
    """Random anchored cites: context fragments must appear exactly at char_pos."""
    conn = ro()
    lo, hi = conn.execute(
        "SELECT min(rowid), max(rowid) FROM cites WHERE char_pos IS NOT NULL"
    ).fetchone()
    rng = random.Random(20260823)
    texts: dict[int, str] = {}
    ok = bad_missing = bad_fragment = 0
    examples = []
    attempts = 0
    while ok < n_target and attempts < attempts_cap:
        attempts += 1
        row = conn.execute(
            "SELECT citing_id, char_pos, context FROM cites WHERE rowid=?",
            (rng.randint(lo, hi),)).fetchone()
        if not row or row[2] is None or row[1] is None:
            continue
        citing, pos, ctx = row
        t = texts.get(citing)
        if t is None:
            r = conn.execute("SELECT text FROM opinions WHERE id=?", (citing,)).fetchone()
            t = r[0] if r else ""
            if len(texts) > 4000:
                texts.clear()
            texts[citing] = t
        # Contract (etl/textclean.py + build_corpus.py): char_pos is the START of
        # the anchor's citation text; context sides are .strip()ed, so the left
        # fragment may sit k whitespace chars before pos. Try small k values.
        parts = ctx.split(" … ")
        if pos > len(t):
            problems = ["pos beyond text"]
        else:
            def _left(f):
                if not f:
                    return True
                return any(t[max(0, pos - len(f) - k):pos - k] == f for k in range(0, 4))

            def _right(f):
                return (not f) or t.find(f, pos, min(len(t), pos + len(f) + 700)) != -1

            if len(parts) >= 2:
                good = _left(parts[0]) and _right(parts[-1])
            else:
                frag = parts[0] if parts else ""
                good = (not frag) or _left(frag) or _right(frag)
            problems = [] if good else ["fragment mismatch"]
        if problems:
            if "beyond" in problems[0]:
                bad_missing += 1
            else:
                bad_fragment += 1
            if len(examples) < 5:
                examples.append({"citing": citing, "pos": pos,
                                 "ctx_head": ctx[:80], "problems": problems})
        else:
            ok += 1
    total_checked = ok + bad_missing + bad_fragment
    save("offsets", {
        "sampled": total_checked, "attempts": attempts, "ok": ok,
        "bad_beyond": bad_missing, "bad_fragment": bad_fragment,
        "exact_rate_pct": round(ok / total_checked * 100, 3) if total_checked else None,
        "examples": examples,
    })


# ---------------------------------------------------------------- clean

LEAK_PATTERNS = {
    "html_tag": re.compile(r"</?[a-zA-Z][a-zA-Z0-9]*(\s|$|>)"),
    "entity": re.compile(r"&(amp|lt|gt|quot|apos|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});"),
    "nbsp": re.compile("\u00a0"),
    "control_char": re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]"),
}


def check_clean(n_samples: int):
    """Strided rowid sample: leaked markup/entities/control chars; length histogram."""
    conn = ro()
    lo, hi = conn.execute("SELECT min(id), max(id) FROM opinions").fetchone()
    rng = random.Random(20260823)
    ids = sorted(rng.sample(range(lo, hi + 1), n_samples))
    leaks = {k: 0 for k in LEAK_PATTERNS}
    leak_examples = {k: [] for k in LEAK_PATTERNS}
    empty = short = checked = 0
    lens = []
    marks = ",".join("?" * len(ids))
    for oid, text in conn.execute(
        f"SELECT id, text FROM opinions WHERE id IN ({marks})", ids
    ):
        checked += 1
        if not text:
            empty += 1
            continue
        n = len(text)
        lens.append(n)
        if n < 500:
            short += 1
        head_tail = text[:6000] + text[-1500:]
        for name, pat in LEAK_PATTERNS.items():
            m = pat.search(head_tail)
            if m:
                leaks[name] += 1
                if len(leak_examples[name]) < 3:
                    s = max(0, m.start() - 40)
                    leak_examples[name].append({"id": oid, "around": head_tail[s:m.end() + 40]})
    lens.sort()
    q = lambda p: lens[int(len(lens) * p)] if lens else None
    save("clean", {
        "sampled": n_samples, "found": checked, "empty": empty, "short_lt500": short,
        "leaks": leaks, "leak_examples": leak_examples,
        "len_p10": q(0.10), "len_p50": q(0.50), "len_p90": q(0.90),
        "empty_rate_pct_sampled": round(empty / max(checked, 1) * 100, 2),
    })


# ---------------------------------------------------------------- seams

def parse_record_at(path: Path, start: int, max_bytes: int = 64 * 1024 * 1024):
    """Parse the CSV record beginning exactly at byte `start`; return (fields, end_offset)."""
    with open(path, "rb") as f:
        f.seek(start)
        buf = f.read(max_bytes)
    m = BOUNDARY_RE.search(buf, 1)  # next boundary strictly after position 0
    rec_bytes = buf[:m.start()] if m else buf
    expected = None
    mm = re.match(rb'^"(\d+)"', rec_bytes)
    if mm:
        expected = int(mm.group(1))
    raw = rec_bytes.decode("utf-8", errors="replace")
    fields = next(__import__("csv").reader([raw], **CSV_KWARGS), [])
    return fields, expected


def check_seams(total_shards: int = 12):
    """Verify records at each shard byte-range seam parse cleanly and exist in corpus."""
    path = RAW / "opinions-2026-06-30.csv"
    conn = ro()
    results = []
    for i in range(1, total_shards):
        nominal = (OPINIONS_SIZE // total_shards) * i
        with open(path, "rb") as f:
            f.seek(nominal)
            window = f.read(64 * 1024 * 1024)
        m = BOUNDARY_RE.search(window)
        if not m:
            results.append({"shard": i, "resync": False})
            continue
        off = nominal + m.start()
        fields, expected = parse_record_at(path, off)
        oid = guard_int(fields[0]) if fields else None
        row = conn.execute(
            "SELECT case_name, length(text), court_id FROM opinions WHERE id=?",
            (oid,)).fetchone() if oid else None
        results.append({
            "shard_boundary": i, "byte_offset": off, "record_id": oid,
            "expected_leading_id_matches": expected == oid if oid else False,
            "n_fields": len(fields),
            "in_corpus": bool(row),
            "case_name": (row[0][:60] if row and row[0] else None),
            "text_len": (row[1] if row else None),
        })
    all_ok = all(r.get("in_corpus") and r.get("expected_leading_id_matches")
                 and r.get("n_fields", 0) == 22 for r in results)
    save("seams", {"total_shards": total_shards, "all_ok": all_ok, "seams": results})


# ---------------------------------------------------------------- stats

def check_stats():
    """Single streaming pass over opinions (narrow columns only, no text)."""
    conn = ro()
    court_ids = {r[0] for r in conn.execute("SELECT id FROM courts")}
    judge_ids = frozenset(r[0] for r in conn.execute("SELECT id FROM judges"))
    status = {}
    types = {}
    dates_bad = dates_null = 0
    dmin, dmax = None, None
    name_null = short_name_null = 0
    court_bad = court_null = 0
    author_resolved = author_null = 0
    blocked = ocr = 0
    cite_cnt_sum = cite_cnt_n = 0
    n = 0
    t0 = time.time()
    for cid, st, df, cn, cns, aid, ty, pc, oc, bl, cc in conn.execute(
        """SELECT court_id, precedential_status, date_filed, case_name,
                  case_name_short, author_id, type, page_count,
                  ocr, blocked, citation_count FROM opinions"""
    ):
        n += 1
        if n % 1_000_000 == 0:
            print(f"    ... {n:,} rows, {(time.time()-t0)/60:.1f} min", flush=True)
        status[st] = status.get(st, 0) + 1
        types[ty] = types.get(ty, 0) + 1
        if df is None:
            dates_null += 1
        elif not re.match(r"^\d{4}-\d{2}-\d{2}", df):
            dates_bad += 1
        else:
            dmin = df if dmin is None or df < dmin else dmin
            dmax = df if dmax is None or df > dmax else dmax
        if cn is None:
            name_null += 1
        if cns is None:
            short_name_null += 1
        if cid is None:
            court_null += 1
        elif cid not in court_ids:
            court_bad += 1
        if aid is None:
            author_null += 1
        elif aid in judge_ids:
            author_resolved += 1
        blocked += 1 if bl else 0
        ocr += 1 if oc else 0
        if cc is not None:
            cite_cnt_sum += cc
            cite_cnt_n += 1
    save("stats", {
        "rows": n,
        "elapsed_min": round((time.time() - t0) / 60, 1),
        "precedential_status": status,
        "types_top": sorted(types.items(), key=lambda kv: -kv[1])[:8],
        "date_filed": {"null": dates_null, "bad_format": dates_bad,
                       "min": dmin, "max": dmax},
        "case_name_null": name_null,
        "case_name_short_null": short_name_null,
        "court_id": {"null": court_null, "invalid_not_in_courts": court_bad},
        "author_id": {"null": author_null, "resolved_in_judges": author_resolved},
        "blocked_rows": blocked,
        "ocr_rows": ocr,
        "citation_count_avg": round(cite_cnt_sum / max(cite_cnt_n, 1), 1),
    })


def check_outliers():
    """Exact counts of source-garbage rows: impossible dates, weird status values,
    and the null-court/null-date cohort."""
    conn = ro()
    bad_dates = future_dates = ancient_dates = weird_status = null_court = 0
    samples = {"bad_dates": [], "future": [], "ancient": [], "weird_status": []}
    n = 0
    t0 = time.time()
    for oid, df, st, cid in conn.execute(
        "SELECT id, date_filed, precedential_status, court_id FROM opinions"
    ):
        n += 1
        if n % 1_000_000 == 0:
            print(f"    ... {n:,} rows {(time.time()-t0)/60:.1f} min", flush=True)
        if df:
            yr = int(df[:4])
            if yr > 2026:
                future_dates += 1
                if len(samples["future"]) < 5:
                    samples["future"].append({"id": oid, "date": df})
            elif yr < 1600:
                ancient_dates += 1
                if len(samples["ancient"]) < 5:
                    samples["ancient"].append({"id": oid, "date": df})
            elif not re.match(r"^\d{4}-\d{2}-\d{2}$", df):
                bad_dates += 1
        if cid is None:
            null_court += 1
        if st == "200":
            weird_status += 1
            if len(samples["weird_status"]) < 5:
                samples["weird_status"].append({"id": oid, "status": st})
    save("outliers", {
        "rows_scanned": n, "minutes": round((time.time()-t0)/60, 1),
        "date_future_gt2026": future_dates, "date_ancient_lt1600": ancient_dates,
        "date_malformed": bad_dates, "status_literal_200": weird_status,
        "null_court_id": null_court, "samples": samples,
    })


# ---------------------------------------------------------------- fk

FK_TARGETS = {
    "parentheticals_described":
        "SELECT count(*) FROM parentheticals p WHERE p.described_id IS NOT NULL"
        " AND NOT EXISTS (SELECT 1 FROM opinions o WHERE o.id=p.described_id)",
    "parentheticals_describing":
        "SELECT count(*) FROM parentheticals p WHERE p.describing_id IS NOT NULL"
        " AND NOT EXISTS (SELECT 1 FROM opinions o WHERE o.id=p.describing_id)",
    "cs_cluster":
        "SELECT count(*) FROM citation_strings cs WHERE NOT EXISTS"
        " (SELECT 1 FROM opinions o WHERE o.cluster_id=cs.cluster_id)",
    "cites_citing":
        "SELECT count(*) FROM cites c WHERE NOT EXISTS"
        " (SELECT 1 FROM opinions o WHERE o.id=c.citing_id)",
    "cites_cited":
        "SELECT count(*) FROM cites c WHERE NOT EXISTS"
        " (SELECT 1 FROM opinions o WHERE o.id=c.cited_id)",
}


def check_fk(target: str):
    conn = ro()
    sql = FK_TARGETS[target]
    t0 = time.time()
    orphans = conn.execute(sql).fetchone()[0]
    total_q = {
        "parentheticals_described": "SELECT count(*) FROM parentheticals WHERE described_id IS NOT NULL",
        "parentheticals_describing": "SELECT count(*) FROM parentheticals WHERE describing_id IS NOT NULL",
        "cs_cluster": "SELECT count(*) FROM citation_strings",
        "cites_citing": "SELECT count(*) FROM cites",
        "cites_cited": "SELECT count(*) FROM cites",
    }[target]
    total = conn.execute(total_q).fetchone()[0]
    save(f"fk_{target}", {
        "orphans": orphans, "checked": total,
        "orphan_rate_pct": round(orphans / max(total, 1) * 100, 4),
        "minutes": round((time.time() - t0) / 60, 1),
    })


BENCH_QUERIES = [
    "qualified immunity clearly established",
    "personal jurisdiction minimum contacts",
    "fourth amendment warrantless search vehicle",
    "negligence duty of care foreseeability",
]


def check_latency(runs: int = 2):
    """Compare naive join-ranked BM25 vs two-phase (FTS rank -> join top-k)."""
    conn = ro()
    conn.execute("PRAGMA mmap_size=268435456")
    naive = """SELECT o.id, bm25(opinions_fts) s FROM opinions_fts f
               JOIN opinions o ON o.id=f.rowid
               WHERE opinions_fts MATCH ?
                 AND o.precedential_status='Published' AND o.court_id='cal'
               ORDER BY s LIMIT 10"""
    twophase = """SELECT rowid, bm25(opinions_fts) s FROM opinions_fts
                  WHERE opinions_fts MATCH ? ORDER BY s LIMIT 200"""
    results = {"queries": []}
    results["plan_naive"] = conn.execute(
        "EXPLAIN QUERY PLAN " + naive, ("test",)).fetchall()
    results["plan_twophase"] = conn.execute(
        "EXPLAIN QUERY PLAN " + twophase, ("test",)).fetchall()
    for q in BENCH_QUERIES:
        entry = {"q": q}
        t0 = time.time()
        n_naive = len(conn.execute(naive, (q,)).fetchall())
        entry["naive_ms"] = round((time.time() - t0) * 1000)
        entry["naive_rows"] = n_naive
        best = None
        for _ in range(runs):
            t0 = time.time()
            top = conn.execute(twophase, (q,)).fetchall()
            dt = (time.time() - t0) * 1000
            best = dt if best is None else min(best, dt)
        entry["twophase_ms"] = round(best)
        entry["twophase_topN"] = len(top)
        t0 = time.time()
        ids = [r[0] for r in top]
        meta = conn.execute(
            f"SELECT id, case_name, court_id, precedential_status FROM opinions"
            f" WHERE id IN ({','.join('?'*len(ids))})", ids).fetchall()
        entry["meta_join_ms"] = round((time.time() - t0) * 1000)
        cal = [m for m in meta if m[2] == "cal" and m[3] == "Published"]
        entry["cal_published_in_top200"] = len(cal)
        results["queries"].append(entry)
        print(f"  {q[:40]:<42} naive={entry['naive_ms']:>6}ms "
              f"two-phase={entry['twophase_ms']:>6}ms cal@200={len(cal)}", flush=True)
    save("latency", results)


# ---------------------------------------------------------------- fts

def check_fts(which: str):
    """FTS5 integrity-check. Needs a write-capable handle because the command is
    invoked as INSERT INTO fts(fts); the command itself performs no content writes."""
    conn = sqlite3.connect(str(CORPUS_DB), timeout=120)
    conn.execute("PRAGMA cache_size=-262144")
    table = f"{which}_fts"
    t0 = time.time()
    try:
        conn.execute(f"INSERT INTO {table}({table}) VALUES ('integrity-check')")
        outcome = "ok"
        err = None
    except sqlite3.DatabaseError as e:
        outcome = "CORRUPT"
        err = str(e)[:500]
    finally:
        conn.rollback()
        conn.close()
    save(f"fts_{which}", {"outcome": outcome, "error": err,
                          "minutes": round((time.time() - t0) / 60, 1)})


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=[
        "offsets", "clean", "seams", "stats", "outliers", "fk", "fts",
        "latency"])
    ap.add_argument("--n", type=int, default=500)
    ap.add_argument("--target")
    ap.add_argument("--which")
    ap.add_argument("--shards", type=int, default=12)
    args = ap.parse_args()
    if args.cmd == "offsets":
        check_offsets(args.n)
    elif args.cmd == "clean":
        check_clean(args.n)
    elif args.cmd == "seams":
        check_seams(args.shards)
    elif args.cmd == "stats":
        check_stats()
    elif args.cmd == "outliers":
        check_outliers()
    elif args.cmd == "fk":
        check_fk(args.target)
    elif args.cmd == "fts":
        check_fts(args.which)
    elif args.cmd == "latency":
        check_latency()


if __name__ == "__main__":
    main()
