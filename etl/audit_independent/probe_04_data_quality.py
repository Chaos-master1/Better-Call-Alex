"""Phase 0.4 — Corpus data-quality sampling, measured not assumed.

Random samples against the live corpus:
  1. TEXT QUALITY: random opinions -> printable-ratio, null-byte rate,
     word-length sanity. OCR-garbage estimate per era.
  2. CITES ANCHORS: random cites rows with char_pos -> the text around
     char_pos should contain the citation string or a reference to the
     cited case. Fraction that look coherent = anchor trustworthiness.
  3. CITATION COLLISIONS: citation_strings (volume, reporter, page) keys
     mapping to >1 cluster — each is a silent mis-resolution risk.
  4. BLOCKED COVERAGE: blocked opinions count + whether they are excluded
     everywhere they should be (sampled via search path is Phase B's job;
     here we measure the population).
  5. PARENTHETICAL LINKAGE: described_id/describing_id FK integrity on a
     sample (dangling ids = dead rows the retrieval boost would skip).

Run:  uv run python etl/audit_independent/probe_04_data_quality.py
Output: logs/audit-independent/probe04-data-quality.json
"""

import json
import os
import random
import re
import sqlite3
import sys
from collections import Counter

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CORPUS = os.path.join(REPO, "data", "corpus.sqlite")
OUT = os.path.join(REPO, "logs", "audit-independent", "probe04-data-quality.json")
SEED = 20260920
N_TEXT = 400
N_CITES = 400
N_PAREN = 300

PRINTABLE_RE = re.compile(r"[\x20-\x7e\n\r\t]")
WORD_RE = re.compile(r"[A-Za-z]+")
CITE_IN_CONTEXT_RE = re.compile(r"\b\d{1,3}\s+[A-Z][A-Za-z.0-9'’]*\s+\d{1,4}\b")


def text_metrics(text: str) -> dict:
    n = len(text)
    printable = sum(1 for ch in text if PRINTABLE_RE.match(ch))
    nulls = text.count("\x00")
    words = WORD_RE.findall(text)
    avg_wlen = sum(len(w) for w in words) / max(1, len(words))
    # garbage signature: very long non-dictionary tokens or terrible ratio
    long_tokens = sum(1 for w in words if len(w) > 20)
    return {
        "len": n,
        "printable_ratio": printable / max(1, n),
        "null_rate": nulls / max(1, n),
        "avg_word_len": avg_wlen,
        "long_token_rate": long_tokens / max(1, len(words)),
        "garbage": (printable / max(1, n)) < 0.85 or avg_wlen > 9.5,
    }


def main() -> int:
    rng = random.Random(SEED)
    db = sqlite3.connect(f"file:{CORPUS}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row

    # ---- 1. text quality -------------------------------------------------
    print("1. text quality sampling...")
    lo, hi = db.execute("SELECT min(id), max(id) FROM opinions").fetchone()
    text_rows = []
    tries = 0
    while len(text_rows) < N_TEXT and tries < N_TEXT * 20:
        tries += 1
        oid = rng.randint(lo, hi)
        row = db.execute(
            "SELECT id, text, ocr, date_filed, precedential_status FROM opinions WHERE id=?",
            (oid,),
        ).fetchone()
        if row is None or not row["text"]:
            continue
        m = text_metrics(row["text"])
        m.update(
            id=row["id"],
            ocr=bool(row["ocr"]),
            year=row["date_filed"][:4] if row["date_filed"] else None,
            status=row["precedential_status"],
        )
        text_rows.append(m)
    garbage = [t for t in text_rows if t["garbage"]]
    ocr_rows = [t for t in text_rows if t["ocr"]]
    garbage_ocr_rate = (sum(1 for t in ocr_rows if t["garbage"]) / len(ocr_rows)) if ocr_rows else None
    garbage_nonocr_rate = (
        sum(1 for t in text_rows if not t["ocr"] and t["garbage"]) / max(1, sum(1 for t in text_rows if not t["ocr"]))
    )

    # ---- 2. cites anchor coherence ---------------------------------------
    print("2. cites anchor sampling...")
    n_cites = db.execute("SELECT count(*) FROM cites").fetchone()[0]
    anchor_ok = 0
    anchor_checked = 0
    anchor_examples_bad = []
    while anchor_checked < N_CITES:
        pos = rng.randint(0, n_cites - 1)
        row = db.execute(
            "SELECT citing_id, cited_id, char_pos, context FROM cites WHERE rowid = (SELECT rowid FROM cites LIMIT 1 OFFSET ?)",
            (pos,),
        ).fetchone()
        if row is None or row["char_pos"] is None:
            continue
        anchor_checked += 1
        ctx = (row["context"] or "").strip()
        # the stored context should look like sentence prose mentioning a cite
        looks_like_prose = len(ctx) > 30 and ctx[0].isupper() if ctx else False
        has_citeish = bool(CITE_IN_CONTEXT_RE.search(ctx)) if ctx else True
        if looks_like_prose and has_citeish:
            anchor_ok += 1
        elif len(anchor_examples_bad) < 10:
            anchor_examples_bad.append(ctx[:160])
    anchor_rate = anchor_ok / max(1, anchor_checked)

    # ---- 3. citation collisions ------------------------------------------
    print("3. citation_strings collision scan...")
    coll_rows = db.execute(
        """
        SELECT volume, reporter, page, count(DISTINCT cluster_id) AS k
          FROM citation_strings
         GROUP BY volume, reporter, page HAVING k > 1
         LIMIT 50
        """
    ).fetchall()
    n_groups = db.execute(
        "SELECT count(*) FROM (SELECT 1 FROM citation_strings GROUP BY volume, reporter, page)"
    ).fetchone()[0]
    n_coll = db.execute(
        """
        SELECT count(*) FROM (
          SELECT volume, reporter, page FROM citation_strings
          GROUP BY volume, reporter, page HAVING count(DISTINCT cluster_id) > 1
        )
        """
    ).fetchone()[0]

    # ---- 4. blocked coverage ----------------------------------------------
    print("4. blocked coverage...")
    n_blocked = db.execute("SELECT count(*) FROM opinions WHERE blocked").fetchone()[0]
    n_total = db.execute("SELECT count(*) FROM opinions").fetchone()[0]

    # ---- 5. parenthetical linkage ------------------------------------------
    print("5. parenthetical linkage sampling...")
    paren_dangling = 0
    for _ in range(N_PAREN):
        pos = rng.randint(0, 6_400_000)
        row = db.execute(
            "SELECT described_id, describing_id FROM parentheticals WHERE rowid = (SELECT rowid FROM parentheticals LIMIT 1 OFFSET ?)",
            (pos,),
        ).fetchone()
        if row is None:
            continue
        if row["described_id"] is not None:
            ex = db.execute("SELECT 1 FROM opinions WHERE id=?", (row["described_id"],)).fetchone()
            if not ex:
                paren_dangling += 1
                continue
        if row["describing_id"] is not None:
            ex = db.execute("SELECT 1 FROM opinions WHERE id=?", (row["describing_id"],)).fetchone()
            if not ex:
                paren_dangling += 1

    report = {
        "probe": "phase0.4 corpus data-quality sampling",
        "date": "2026-09-20",
        "seed": SEED,
        "text_quality": {
            "sampled": len(text_rows),
            "garbage_rate_overall": round(sum(1 for t in text_rows if t["garbage"]) / len(text_rows), 4),
            "garbage_rate_ocr": round(garbage_ocr_rate, 4) if garbage_ocr_rate is not None else None,
            "garbage_rate_non_ocr": round(garbage_nonocr_rate, 4),
            "ocr_share_of_sample": round(len(ocr_rows) / len(text_rows), 4),
            "note": "garbage = printable_ratio<0.85 or avg_word_len>9.5 — the OCR down-weight (§9.6) exists for these",
        },
        "cites_anchors": {
            "population": n_cites,
            "checked": anchor_checked,
            "coherent_rate": round(anchor_rate, 4),
            "bad_examples": anchor_examples_bad,
        },
        "citation_collisions": {
            "vrp_groups": n_groups,
            "colliding_groups": n_coll,
            "collision_rate": round(n_coll / max(1, n_groups), 6),
            "examples": [
                f"{r['volume']} {r['reporter']} {r['page']} -> {r['k']} clusters" for r in coll_rows[:15]
            ],
        },
        "blocked": {
            "count": n_blocked,
            "share": round(n_blocked / max(1, n_total), 6),
        },
        "parenthetical_linkage": {
            "sampled": N_PAREN,
            "dangling": paren_dangling,
        },
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report["text_quality"], indent=1))
    print(f"anchor coherence: {report['cites_anchors']['coherent_rate']}")
    print(f"collision rate: {report['citation_collisions']['collision_rate']}")
    print(f"blocked share: {report['blocked']['share']}")
    print(f"paren dangling: {paren_dangling}/{N_PAREN}")
    print(f"-> {OUT}")
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
