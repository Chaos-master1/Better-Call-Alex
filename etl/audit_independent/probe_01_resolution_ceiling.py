"""Phase 0.1 — Independent citation-resolution ceiling probe.

Trust nothing: the G2 verifier rejects every full citation that does not
resolve through `citation_strings`. If REAL citations inside REAL corpus
opinions fail that resolution, the system strikes legitimate law — the
mirror-image failure mode of hallucination, which no hand-built fixture
ever tested. This probe measures that ceiling from the corpus itself.

Method (no project docs relied upon):
  1. Random-sample N opinion ids, stratified by decade of date_filed.
  2. For each opinion, run the production verifier bridge (verifier/bridge.py,
     the same subprocess the app uses) over the opinion's first 20,000 chars.
  3. Take every FULL citation the bridge finds and resolve it through the
     same normalize + citation_strings lookup the app's db.ts uses
     (volume/page numeric normalization + the 6 reporter aliases).
  4. Report resolve rate overall and broken down by reporter and decade,
     plus the top unresolved (volume, reporter) pairs — those are the
     normalization gaps that would cause false strikes of legitimate law.

Run:  uv run python etl/audit_independent/probe_01_resolution_ceiling.py
Output: logs/audit-independent/probe01-resolution-ceiling.json
"""

import json
import os
import random
import sqlite3
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CORPUS = os.path.join(REPO, "data", "corpus.sqlite")
BRIDGE = os.path.join(REPO, "verifier", "bridge.py")
PY = os.path.join(REPO, ".venv", "bin", "python")
OUT = os.path.join(REPO, "logs", "audit-independent", "probe01-resolution-ceiling.json")

SAMPLE_TARGET = 500          # opinions sampled
TEXT_WINDOW = 20_000         # chars per opinion (matches analyst payload scale)
SEED = 20260920

REPORTER_ALIASES = {
    "u.s.": "U.S.",
    "us": "U.S.",
    "f.2d": "F.2d",
    "f.3d": "F.3d",
    "f.4th": "F.4th",
    "s.ct.": "S. Ct.",
}


def normalize_reporter(reporter: str) -> str:
    return REPORTER_ALIASES.get(reporter.strip().lower(), reporter.strip())


def normalize_num(s: str) -> str:
    t = s.strip()
    try:
        return str(int(float(t)))
    except ValueError:
        return t


def main() -> int:
    rng = random.Random(SEED)
    db = sqlite3.connect(f"file:{CORPUS}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row

    # Sampling without table scans: draw random ids from the id space and
    # fetch each row by PK. (ORDER BY random() + length(text) filters over
    # 10.8M rows scans ~115 GB of text per decade — the first run of this
    # probe timed out on exactly that. Random-id draws are O(sample).)
    print("sampling opinions by random id draws (PK lookups only)...")
    min_id, max_id = db.execute(
        "SELECT min(id), max(id) FROM opinions"
    ).fetchone()
    print(f"id space: {min_id}..{max_id}")

    def draw(n: int) -> list[int]:
        out = []
        tries = 0
        while len(out) < n and tries < n * 20:
            tries += 1
            oid = rng.randint(min_id, max_id)
            row = db.execute(
                """SELECT id, date_filed, blocked,
                          CASE WHEN text IS NULL THEN 0 ELSE length(text) END AS tlen
                     FROM opinions WHERE id = ?""",
                (oid,),
            ).fetchone()
            if row is None:
                continue
            if row["blocked"] or row["tlen"] < 2000:
                continue
            out.append(row["id"])
        return out

    # Overdraw 2x then dedupe; a decade sweep below tops up strata.
    pool: dict[int, str] = {}
    for oid in draw(SAMPLE_TARGET * 2):
        if len(pool) >= SAMPLE_TARGET * 2:
            break
        d = db.execute(
            "SELECT substr(date_filed, 1, 4) FROM opinions WHERE id = ?", (oid,)
        ).fetchone()[0]
        pool[oid] = d or "unknown"
    # Stratify: aim for decade-proportional coverage by topping up thin decades.
    by_decade = defaultdict(list)
    for oid, yr in pool.items():
        by_decade[int(yr) // 10 * 10 if yr.isdigit() else -1].append(oid)
    n_decades = max(1, len([d for d in by_decade if d > 0]))
    floor_per_decade = max(8, SAMPLE_TARGET // (n_decades * 2))
    for decade, ids in list(by_decade.items()):
        if decade > 0 and len(ids) < floor_per_decade:
            for oid in draw(floor_per_decade * 3):
                yr = db.execute(
                    "SELECT substr(date_filed, 1, 4) FROM opinions WHERE id = ?", (oid,)
                ).fetchone()[0]
                if yr.isdigit() and int(yr) // 10 * 10 == decade and oid not in pool:
                    pool[oid] = yr
                    by_decade[decade].append(oid)
                    if len(by_decade[decade]) >= floor_per_decade:
                        break
    picks = list(pool.keys())[: SAMPLE_TARGET * 2]
    rng.shuffle(picks)
    print(f"sampled {len(picks)} opinions across {len(by_decade)} decades")

    resolved = 0
    unresolved = 0
    nonfull = 0
    no_cites_opinions = 0
    per_reporter = defaultdict(lambda: [0, 0])   # reporter -> [resolved, total]
    per_decade = defaultdict(lambda: [0, 0])
    unresolved_pairs = Counter()
    unresolved_examples = {}

    batch_size = 40
    db.execute("PRAGMA cache_size = -262144")  # 256 MB page cache for citation_strings
    for batch_start in range(0, len(picks), batch_size):
        print(f"  batch {batch_start // batch_size + 1}/{(len(picks) + batch_size - 1) // batch_size}", flush=True)
        batch_ids = picks[batch_start : batch_start + batch_size]
        texts = []
        metas = []
        for oid in batch_ids:
            row = db.execute(
                "SELECT id, date_filed FROM opinions WHERE id = ?", (oid,)
            ).fetchone()
            text = db.execute(
                "SELECT substr(text, 1, ?) FROM opinions WHERE id = ?",
                (TEXT_WINDOW, oid),
            ).fetchone()[0]
            texts.append(text)
            metas.append(row["date_filed"][:4] if row["date_filed"] else "unknown")

        payload = json.dumps({"texts": texts}).encode()
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
            tf.write(payload)
            in_path = tf.name
        try:
            proc = subprocess.run(
                [PY, BRIDGE],
                input=open(in_path, "rb").read(),
                capture_output=True,
                timeout=300,
            )
        finally:
            os.unlink(in_path)
        if proc.returncode != 0:
            print(f"bridge failed on batch {batch_start}: {proc.stderr[:300]}", file=sys.stderr)
            continue
        results = json.loads(proc.stdout)["results"]

        for text, cites, yr in zip(texts, results, metas):
            decade = int(yr) // 10 * 10 if yr.isdigit() else "unknown"
            fulls = [c for c in cites if c.get("type") == "full" and not c.get("error")]
            if not fulls:
                no_cites_opinions += 1
                continue
            per_decade[str(decade)][1] += len(fulls)
            for c in fulls:
                vol = c.get("volume") or ""
                rep = c.get("reporter") or ""
                page = c.get("page") or ""
                if not vol or not rep or not page:
                    unresolved += 1
                    continue
                per_reporter[rep][1] += 1
                ok = False
                for r in {rep, normalize_reporter(rep)}:
                    row = db.execute(
                        "SELECT 1 FROM citation_strings WHERE volume=? AND reporter=? AND page=? LIMIT 1",
                        (normalize_num(vol), r, normalize_num(page)),
                    ).fetchone()
                    if row:
                        ok = True
                        break
                if ok:
                    resolved += 1
                    per_reporter[rep][0] += 1
                    per_decade[str(decade)][0] += 1
                else:
                    unresolved += 1
                    key = f"{vol} {rep}"
                    unresolved_pairs[key] += 1
                    unresolved_examples.setdefault(key, c.get("text", ""))

    total_full = resolved + unresolved
    report = {
        "probe": "phase0.1 citation-resolution ceiling",
        "date": "2026-09-20",
        "seed": SEED,
        "sampled_opinions": len(picks),
        "opinions_with_full_cites": len(picks) - no_cites_opinions,
        "full_citations_total": total_full,
        "resolved": resolved,
        "unresolved": unresolved,
        "resolve_rate": round(resolved / total_full, 4) if total_full else None,
        "nonfull_citations_seen": nonfull,
        "by_reporter": {
            rep: {"resolved": v[0], "total": v[1], "rate": round(v[0] / v[1], 4) if v[1] else None}
            for rep, v in sorted(per_reporter.items(), key=lambda kv: -kv[1][1])[:25]
        },
        "by_decade": {
            dec: {"resolved": v[0], "total": v[1], "rate": round(v[0] / v[1], 4) if v[1] else None}
            for dec, v in sorted(per_decade.items())
        },
        "top_unresolved_pairs": {
            k: {"count": v, "example": unresolved_examples.get(k, "")}
            for k, v in unresolved_pairs.most_common(20)
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\nfull citations checked: {total_full}")
    print(f"resolved: {resolved}  unresolved: {unresolved}  rate: {report['resolve_rate']}")
    print(f"-> {OUT}")
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
