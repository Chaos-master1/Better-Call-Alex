# G0 deep audit — corpus.sqlite

Run 2026-08-23/24 against the merged `2026-06-30` snapshot. Harness:
`etl/audit_g0.py` (per-check subcommands, JSON results in `logs/audit/`).
Gate suite `etl/tests/test_g0.py`: **7/7 pass** before and after the audit.

## Verdict

**PASS — G0 stands.** Zero P0 defects. One P2 fix applied (§ Fixes).
All referential-integrity checks are exact full-table anti-joins, not samples.

## Results

| # | Check | Method | Result | Status |
|---|---|---|---|---|
| 1 | Gate suite (re-run) | `test_g0.py` | 7/7 pass, Roe cited_by=5,575 | PASS |
| 2 | Shard seams ×11 | raw-CSV record parse at each byte-range boundary vs corpus | all parse, 22 fields, ids match, in-corpus | PASS |
| 3 | `char_pos` exactness | 500 random anchored cites | **500/500 exact (100%)** | PASS |
| 4 | Text cleanliness | 5,000-row strided sample | empty 0.02%; entity leaks 0; "tag" hits = OCR garbage false-positives; control chars 3 (source OCR artifacts) | PASS |
| 5 | FTS parentheticals integrity | FTS5 `integrity-check` | ok (0.2 min) | PASS |
| 5b | FTS opinions integrity | FTS5 `integrity-check`, full ~115 GB | **ok (50.4 min)** | PASS |
| 6 | Field stats (full pass) | streaming scan, 10,798,347 rows | see below | PASS w/ flags |
| 7 | Date outliers (exact) | full scan | future>2026: **1**; ancient<1600: **1**; malformed: 0 | PASS |
| 8 | cites↔opinions citing_id | full anti-join 105,689,491 edges | orphans **3,758 (0.0036%)** | PASS* |
| 9 | cites↔opinions cited_id | full anti-join | orphans **96,373 (0.0912%)** | PASS* |
| 10 | citation_strings→clusters | full anti-join 18,123,788 | orphans **2,904 (0.016%)** | PASS* |
| 11 | parentheticals described/describing | full anti-joins 6,408,887 | **0** / **618 (0.0096%)** | PASS |
| 12 | court_id validity | full scan vs `courts` | invalid **0**, null 21 | PASS |
| 13 | author_id dangling | full scan vs `judges` | dangling **0** (all 1.24M non-null resolve) | PASS |

\* Orphan rates are source-snapshot noise (citation-map / citations CSVs reference
opinions outside this snapshot). Query-time joins drop them naturally;
`build_authority.py` must skip them.

## Reconciliation (A2)

citormap staging = **77,460,014** edges (`logs/prep.log`) + anchor-only
28,229,477 = **105,689,491** — exact. CLAUDE.md's "~132M" was an estimate,
not a measurement; nothing was lost in the merge. Context/char_pos present on
exactly 51,527,233 rows each — consistent with anchor coverage.

## Field statistics (full pass)

| field | value |
|---|---|
| precedential_status | Published 9,027,878 (83.6%), Unpublished 995,239, **Unknown 772,539 (7.2%)**, Errata 1,031, other ~900, literal `'200'` 366 |
| date_filed | nulls 21, malformed 0, range outliers 2 (ids 11258350 → 2028, 10775784 → 0019) |
| case_name null | 91,168 (0.84%); case_name_short null 31.1% |
| blocked | 838,152 rows (7.8%) — column populated, §9.7 filter implementable |
| ocr | 4,976,594 (46.1%) — down-weight per §9.6 |
| citation_count avg | 11.4 |

### Flag for G1 (decision needed, not a defect)

`precedential_status='Unknown'` covers 772,539 opinions. The canon's
Published-only retrieval filter would hide them. Options: Published ∪ Unknown
searchable with status surfaced in UI, or keep strict. Decide when writing the
G1 golden set.

## Retrieval latency root-cause (feeds G1 design)

Naive pattern (rank ALL matches joined to opinions): **6.6–20.6 s** — dominated
by per-match random fetches into wide rows.
Two-phase (FTS5 ranks alone → join top-k metadata): **257–1441 ms** for top-200;
top-2000 costs the same (453–1270 ms). Metadata join: 1–3 ms.
`parentheticals_fts` ranked query: ~1.1 s cold, sub-second warm.

Consequence: G1 must use the two-phase pattern. Caveat measured: a global
top-200 starves narrow jurisdictions (CA-published in top-200: 0–6 across four
doctrine queries) → adaptive pool escalation or per-jurisdiction strategy is a
G1 requirement, not an optimization.

## Fix applied

| file | change | why |
|---|---|---|
| `app/cli.ts` | lookup requires joined opinion (`AND o.id IS NOT NULL`) | orphan-cluster citation strings returned degenerate cards (`opinion_id:-1`, null fields); now correctly "NO AUTHORITY FOUND IN CORPUS" per §11 wording. Re-tested: orphan cite rejected, Roe unaffected. |

## Lookup edge cases

`410 U.S. 113` ✓ · alias `us` ✓ · alias `s.ct.` ✓ (Miranda via parallel cite)
· multi-cluster cite (400 clusters) resolves deterministically ✓ · non-cite /
empty / nonexistent → clean NO AUTHORITY ✓ · orphan-cluster → NO AUTHORITY ✓
(after fix).

## Outstanding

None. All checks complete; both FTS5 indexes pass integrity-check against their
content tables (parentheticals 0.2 min, opinions 50.4 min).
