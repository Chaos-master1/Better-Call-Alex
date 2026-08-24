# Retrieval (G1)

Canon: CLAUDE.md §3 retrieval steps. Implementation: `app/lib/retrieval/search.ts`,
CLI: `alex search "query" [--jurisdiction cal] [--limit 10]`.
Quality gate: `pnpm eval` (golden set, precision@10). Latency gate:
`pnpm bench` (p95 < 500 ms).

## Query flow

1. **Tokenize** — lowercase, split non-alphanumerics, drop stopwords and
   single chars, cap 24 tokens. Each token double-quoted into an FTS5 MATCH
   expression (implicit AND; porter stemmer applies on both sides).
2. **Two-phase rank** (mandatory — docs/g0-audit.md measured the naive
   join-ranked pattern at 6.6–20.6 s):
   `SELECT rowid, bm25(opinions_fts) … ORDER BY bm25 LIMIT pool`, then a
   chunked metadata fetch for exactly those ids.
3. **Filters** applied to the pool:
   - `precedential_status ∈ {Published, Unknown}` — decided at G1 kickoff
     (772k Unknown opinions stay searchable); status surfaced on every hit.
   - `blocked = 0` excluded (§9.7 de-indexing honored).
   - jurisdiction: court subtree via recursive CTE over
     `courts.id / jurisdiction / citation_string → parent_id` children.
4. **Adaptive pool escalation**: pools of 200 → 2,000 → 20,000 until the
   filtered pool holds ≥ limit distinct clusters. Escalation exists because a
   global top-200 starves narrow jurisdictions (CA published-in-top-200 was
   0–6 across doctrine queries — measured in g0-audit).
5. **Parenthetical agreement** (§3 step 3): top-500 ranked hits over
   `parentheticals_fts` joined back by rowid to `parentheticals.described_id`;
   each hit gains multiplier `1 + 0.25·ln(1+hits)`.
6. **Authority re-score** (§3 step 4), monotone and defined even while
   `authority` is empty:
   `m = 1 + 0.5·ln(1+pagerank·1e6) + 0.3·ln(1+recent_cites_2y) + [court=scotus]`
   final = `(-bm25) × m × paren_mult × (ocr ? 0.7 : 1)` (§9.6 down-weight).
   Treatment flags ride along as data (`treatment_flags` bitfield) — they are
   INFERRED from citing-context language, never asserted (§5.5).
7. **Cluster dedupe**: one result per cluster (a case's lead/dissent/
   concurrence must not crowd out other authority); best-scoring opinion wins.
8. **Passages with char offsets**: for each returned opinion, the densest
   window (~600 chars) of query-term occurrences in stored text; `start` is an
   exact character offset usable for pin cites and quote verification later.

## Determinism

Same DB + query ⇒ same results: no randomness, stable tiebreak on
`opinion_id ASC`. Recency anchored at snapshot date − 2y in the builder, not
wall-clock.

## Measured costs (2026-08-24, corpus.sqlite 197 GiB)

| phase | warm |
|---|---|
| opinions_fts rank, 4-term query, top-200 | ~280–580 ms |
| parentheticals_fts rank, top-500 | 21–44 ms |
| metadata join (200–800 ids) | 1–3 ms |
| passages (10 texts) | <5 ms |

The FTS rank dominates and scales with match-set size, not LIMIT. Cold-start
(first process after boot) pays page-cache misses; `mmap_size = 2 GB` keeps
hot index regions mapped across invocations.
