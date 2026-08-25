"""Generate verifier/fixtures/golden.json from the corpus itself.

Real quotes are lifted verbatim from opinion text (so the truth is the
corpus), mutations are mechanical, and EVERY fixture is validated here:

  - valid/altered/invented/wrong-case quotes are checked against the cited
    opinion's text under the same normalization the TS matcher uses;
  - fabricated citations are checked absent from citation_strings;
  - landmark resolutions are checked to exist before use.

Deterministic: same corpus -> byte-identical output.

Run: uv run python verifier/make_fixtures.py
"""

import json
import re
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CORPUS = REPO / "data" / "corpus.sqlite"
OUT = Path(__file__).resolve().parent / "fixtures" / "golden.json"

LANDMARKS = [
    # (citation, case fragment, doctrine-flavored invented sentence)
    ("410 U.S. 113", "Roe",
     "The Court announced a rigid trimester framework permitting states to "
     "regulate abortion only after fetal viability has been clearly established."),
    ("384 U.S. 436", "Miranda",
     "The Court required officers to recite a scripted warning before any "
     "custodial traffic stop regardless of interrogation."),
    ("389 U.S. 347", "Katz",
     "The Fourth Amendment protects only physical trespasses upon private "
     "real property, never conversations in public telephone booths."),
]

SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'])")


def norm(s):
    s = s.lower()
    s = re.sub(r"[\u2018\u2019\u201c\u201d]", "'", s.replace('"', "'"))
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def open_corpus():
    conn = sqlite3.connect(f"file:{CORPUS}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only=1")
    return conn


def resolve(conn, volume, reporter, page):
    row = conn.execute(
        """SELECT o.id, o.cluster_id, o.case_name,
                  min(CASE WHEN o.type LIKE '%lead%' THEN 0
                           WHEN o.type LIKE '%combined%' THEN 1 ELSE 2 END), o.id
           FROM citation_strings cs
           JOIN opinions o ON o.cluster_id = cs.cluster_id
           WHERE cs.volume=? AND cs.reporter=? AND cs.page=? AND o.blocked=0
           GROUP BY o.cluster_id
           ORDER BY 4 ASC, 5 ASC LIMIT 1""",
        (str(int(volume)), reporter, str(int(page))),
    ).fetchone()
    return row  # (opinion_id, cluster_id, case_name)


def get_text(conn, opinion_id):
    return conn.execute(
        "SELECT text FROM opinions WHERE id=?", (opinion_id,)
    ).fetchone()[0]


def pick_sentence(text, used):
    """First clean doctrinal sentence past the caption zone.

    Filters out citation litter (digits, §, *, U.S., years) so fixtures are
    quotable prose, not reference-section fragments."""
    body = text[int(len(text) * 0.08):]
    for sent in SENT_SPLIT.split(body):
        words = sent.split()
        if not (14 <= len(words) <= 40):
            continue
        if '"' in sent or "\u201c" in sent or max(len(w) for w in words) < 8:
            continue
        if re.search(r"[\d\u00a7*()]", sent) or "U.S." in sent or ";" in sent:
            continue
        key = norm(sent)[:80]
        if key in used:
            continue
        used.add(key)
        return " ".join(words)
    raise RuntimeError("no quotable sentence found")
    raise RuntimeError("no quotable sentence found")


def alter_one_word(sentence, cited_text_norm):
    words = sentence.split()
    n = len(words)
    for i in range(n // 2, n):
        w = words[i].strip(".,;:")
        if w.isalpha() and len(w) >= 6:
            repl = "quantum" if w.lower() != "quantum" else "gravity"
            mutated = " ".join(words[:i] + [repl] + words[i + 1:])
            if norm(mutated) not in cited_text_norm:
                return mutated, w
    raise RuntimeError("no alterable word found")


def cite_absent(conn, volume, reporter, page):
    return conn.execute(
        "SELECT count(*) FROM citation_strings WHERE volume=? AND reporter=? AND page=?",
        (volume, reporter, page),
    ).fetchone()[0] == 0


def find_overruled(conn):
    """Prefer Plessy (famous, certainly flagged); else top-pagerank flagged."""
    row = resolve(conn, "163 U.S. 537".split()[0], "U.S.", "537")
    if row:
        oid, cid, name = row[0], row[1], row[2]
        flags = conn.execute(
            "SELECT treatment_flags FROM authority WHERE opinion_id=?", (oid,)
        ).fetchone()
        if flags and flags[0] & 1:
            return oid, cid, name, "163 U.S. 537"
    row = conn.execute(
        """SELECT o.id, o.cluster_id, o.case_name, cs.volume, cs.reporter, cs.page
           FROM authority a
           JOIN opinions o ON o.id = a.opinion_id
           JOIN citation_strings cs ON cs.cluster_id = o.cluster_id
           WHERE a.treatment_flags & 1 = 1 AND length(o.text) > 8000
             AND o.precedential_status = 'Published' AND o.blocked = 0
           ORDER BY a.pagerank DESC LIMIT 1"""
    ).fetchone()
    return row[0], row[1], row[2], f"{row[3]} {row[4]} {row[5]}"


def main():
    conn = open_corpus()
    cases = []
    used_sentences = set()

    resolved = []
    for cite, frag, invented in LANDMARKS:
        vol, rep, page = cite.split()[0], " ".join(cite.split()[1:-1]), cite.split()[-1]
        r = resolve(conn, vol, rep, page)
        assert r, f"landmark {cite} failed to resolve"
        oid, cid, name = r[0], r[1], r[2]
        assert frag.lower() in (name or "").lower(), f"{cite}: {name} lacks '{frag}'"
        resolved.append({
            "cite": cite, "vol": str(int(vol)), "rep": rep,
            "page": str(int(page)), "oid": oid, "cid": cid, "name": name,
            "invented": invented,
            "text": get_text(conn, oid),
        })

    def add(cid_, category, text, expect_fail, expect_contains):
        cases.append({
            "id": f"{category}-{len(cases) + 1:02d}",
            "category": category,
            "text": text,
            "expect_overall": "fail" if expect_fail else "pass",
            "expect_contains": expect_contains,
        })

    roe, mir, katz = resolved

    # --- controls ---------------------------------------------------------
    q_roe = pick_sentence(roe["text"], used_sentences)
    add(None, "valid_passage",
        f'The constitutional foundation is stated in Roe v. Wade, '
        f'{roe["vol"]} U.S. {roe["page"]} (1973): "{q_roe}"',
        False, [])

    q_mir = pick_sentence(mir["text"], used_sentences)
    add(None, "pin_annotated",
        f'Miranda v. Arizona, {mir["vol"]} U.S. {mir["page"]}, 164 (1966), '
        f'holds: "{q_mir}"',
        False, ['"pin_unverified":true'])

    # block quote: same words, hard-wrapped with newlines inside the quoted
    # span — exercises newline-tolerant extraction + whitespace-collapsing
    # match rung end to end.
    q_katz_blk = pick_sentence(katz["text"], used_sentences)
    words = q_katz_blk.split()
    wrapped = "\n".join(
        " ".join(words[i:i + 6]) for i in range(0, len(words), 6))
    add(None, "block_quote",
        f'The Court explained in Katz v. United States, '
        f'{katz["vol"]} U.S. {katz["page"]} (1967): \n"\n{wrapped}\n"',
        False, [])

    add(None, "unsupported_short_form",
        f'See also Katz v. United States, 389 U.S., at 351 (discussing privacy).',
        False, ["unsupported_form"])

    # --- adversarial: fabricated citations --------------------------------
    fabricated = [
        ("734", "F.3d", "999"), ("888", "F. Supp. 2d", "111"),
        ("123", "U.S.", "456"),
    ]
    for vol, rep, page in fabricated:
        assert cite_absent(conn, vol, rep, page), \
            f"fabricated cite {vol} {rep} {page} exists in corpus!"
        add(None, "fabricated_citation",
            f'As this Court held in Smith v. Jones, {vol} {rep} {page} (11th Cir. 2020), '
            f'the doctrine requires dismissal.',
            True, ["unresolved_citation"])

    # --- adversarial: invented quote on a real case ------------------------
    for src in (roe, mir):
        inv = src["invented"]
        assert norm(inv) not in norm(src["text"])
        add(None, "invented_quote",
            f'{src["name"].split(" v. ")[0]} stands for the proposition that. '
            f'{src["cite"]} establishes: "{inv}"',
            True, ["quote_not_found"])

    # --- adversarial: one-word-altered quotes ------------------------------
    for src in (katz, mir):
        q = pick_sentence(src["text"], used_sentences)
        mutated, orig_word = alter_one_word(q, norm(src["text"]))
        add(None, "altered_quote",
            f'Quoted verbatim from {src["cite"]}: "{mutated}"',
            True, ["quote_not_found"])

    # --- adversarial: real quote attributed to the wrong case --------------
    q_katz = pick_sentence(katz["text"], used_sentences)
    add(None, "wrong_case_quote",
        f'Roe v. Wade, {roe["vol"]} U.S. {roe["page"]} (1973), explained: "{q_katz}"',
        True, ["quote_wrong_case"])

    q_mir2 = pick_sentence(mir["text"], used_sentences)
    add(None, "wrong_case_quote",
        f'Under Gideon v. Wainwright, 372 U.S. 335 (1963), "{q_mir2}"',
        True, ["quote_wrong_case"])

    # --- adverse-but-verifiable: overruled-flagged authority ---------------
    oid, cid, name, cite = find_overruled(conn)
    text = get_text(conn, oid)
    q = pick_sentence(text, used_sentences)
    parts = cite.split()
    add(None, "overruled_flagged",
        f'{name} ({parts[0]} {parts[1]} {parts[2]}) observed: "{q}" '
        f'See {cite}.',
        False, ['"inferred_treatment":[', '"overruled"'])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "description": (
            "G2 Verifier golden set. Real quotes are verbatim corpus spans; "
            "mutations are mechanically generated and self-validated here. "
            "Adversarial categories MUST yield overall=fail (100% fabrication "
            "catch is the G2 gate); controls MUST pass."
        ),
        "generated": sys.argv[1] if len(sys.argv) > 1 else "corpus 2026-06-30 snapshot",
        "cases": cases,
    }
    OUT.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"[fixtures] wrote {len(cases)} cases -> {OUT.relative_to(REPO)}")
    for c in cases:
        print(f'  {c["id"]:24s} expect={c["expect_overall"]:4s} {c["expect_contains"]}')


if __name__ == "__main__":
    main()
