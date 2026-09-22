# Retrieval (G1)

Canon: CLAUDE.md §3 retrieval steps. Implementation: `app/lib/retrieval/search.ts`,
CLI: `alex search "query" [--jurisdiction cal] [--limit 10]`.
Quality gate: `pnpm eval` (golden set, precision@10). Latency gate:
`pnpm bench` (p95 < 500 ms).

## Query flow

1. **Tokenize (phrase-aware)** — lowercase, split non-alphanumerics.
   Maximal-munch: adjacent words forming a compound term of art from a
   static dictionary (~140 entries) become ONE quoted FTS5 phrase token
   (`"qualified immunity"`); remaining words are standalone tokens.
   Implicit AND across tokens; porter stemmer applies to phrases too.
   Phrase detection runs before stopword removal, so stopword-bearing
   entries remain expressible. Cap 24 tokens.

   Dictionary membership is evidence-gated, both directions:
   - *In*: fixed legal collocations only ("minimum contacts", "prior
     restraint", "plain view"). Flexible concepts that merely contain
     common words ("due process", "right to counsel", "testimonial
     hearsay") are excluded — first implementation included them and the
     golden gate caught a regression (0.280 → 0.245): hard phrase-AND
     over-constrained multi-doctrine queries and displaced canonical
     authority with other genuine progeny.
   - *Cost-checked*: "duty of care" was measured at 4.4× the rank cost of
     its loose-token form (1,597 ms vs 364 ms @ pool 20k) because FTS5
     must decode positional lists for common-word components. Excluded.
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
     The pipeline forwards `intake.jurisdiction` through
     `matchJurisdiction()` (exact match, else court-NAME match + walk;
     unresolvable forum → unfiltered, never empty — ADR-002).
4. **Adaptive pool escalation**: pools of 1,000 → 20,000 until the
   filtered pool holds ≥ limit distinct clusters. Escalation exists because a
   global top-200 starves narrow jurisdictions (CA published-in-top-200 was
   0–6 across doctrine queries — measured in g0-audit). Rung 1 is large on
   purpose: FTS5 rank cost is LIMIT-independent (measured), so widening the
   pool is nearly free and lets the authority multiplier rescue landmarks.
5. **Parenthetical agreement** (§3 step 3): top-500 ranked hits over
   `parentheticals_fts` joined back by rowid to `parentheticals.described_id`;
   each hit gains multiplier `1 + 0.25·ln(1+hits)`.
5b. **Parenthetical recall seeding** — §3 step 3 used as RECALL, not just
   re-ranking. A landmark that predates the query's vocabulary
   (*International Shoe*, 1945, contains "minimum contacts" but not the
   then-nonexistent phrase "personal jurisdiction") can never enter an
   AND-conjunction pool, however often later judges describe it. When the
   tokenized query contains ≥1 dictionary phrase (i.e., names doctrine),
   up to 2 result slots are reserved for the most-described matching
   opinions from `parenBoosts`, after status/blocked/jurisdiction filters
   and cluster-dedupe against organic hits; flagged
   `via_parenthetical_recall`. Organic results always keep priority.
6. **Authority re-score** (§3 step 4), monotone and defined even while
   `authority` is empty:
   `m = 1 + 0.5·ln(1+pagerank·1e6) + 0.3·ln(1+recent_cites_2y) + [court=scotus]`
   final = `(-bm25) × m × paren_mult × (ocr ? 0.7 : 1)` (§9.6 down-weight).
   Treatment flags ride along as data (`treatment_flags` bitfield) — they are
   INFERRED from citing-context language, never asserted (§5.5).
7. **Cluster dedupe**: one result per cluster (a case's lead/dissent/
   concurrence must not crowd out other authority); best-scoring opinion wins.
8. **Passages with char offsets**: for each returned opinion, the densest
   window (~600 chars) of query-term occurrences; `text[start:end] ===
   text` holds exactly (offsets index the returned, whitespace-collapsed
   passage — display provenance, not a slice into raw stored text).

## Determinism

Same DB + query ⇒ same results: no randomness, stable tiebreak on
`opinion_id ASC`. Recency anchored at snapshot date − 2y in the builder, not
wall-clock.

## Measured costs (2026-09-22, corpus.sqlite 197 GiB, quiet disk, 8 GB mmap window)

| phase | warm median | warm p95 |
|---|---|---|
| opinions_fts rank (`fts_pool_ms`) | 435 ms | 589 ms |
| parentheticals_fts rank (`paren_ms`) | 10 ms | 18 ms |
| metadata join (`fetch_meta_ms`) | 10 ms | 14 ms |
| passages, 10 texts (`text_ms`) | 8 ms | 12 ms |
| seeds / score / prf / tokenize | ≤1 ms | ≤2 ms |

**Latency gate status: p50 MET, p95 = 607 ms — tail mechanism measured and
attributed (2026-09-22 quiet-disk re-bench).** Architectural ceiling: FTS5
bm25 evaluates every row of a multi-term AND match set (81,410 rows for the
slowest bench query) before LIMIT applies — LIMIT-independent, NEAR-tightened
and phrase-anchored reformulations do **not** cut it (measured: NEAR,8 → 6.5k
rows still 363 ms; `ORDER BY rank` native form 552 ms). The 2026-09-22 re-bench
fixed the *environmental* component: the 2 GB mmap window let the six bench
queries evict each other's hot lexicon/postings pages every round (2.8 s p95
interleaved vs 0.5 s standalone). Raising the window to 8 GB + 64 MB page cache
(`db.ts`) stabilizes the tail: **p50 = 455 ms, p95 = 607 ms, max 607 ms, no
outliers**; cold first-touch 5.3 s → 1.4 s. The remaining single-query tail is
structural FTS5 scoring and closes only with an ETL-track change (indexed
signal columns / postfiltered ranking), which is corpus scope, not app scope.

Named levers, in order of preference (each requires an eval run proving
precision@10 does not regress by more than −0.02):
1. ~~phrase-aware query analysis~~ — **DONE 2026-08-24**: mean precision@10
   0.2800 → **0.2883** (+0.0083, recorded as new baseline generation);
   fixed doc-06/doc-08/doc-09 zeros via phrases + parenthetical recall
   seeding; latency outlier "negligence duty of care foreseeability"
   eliminated (1,597 → 372 ms by un-phrase-ing "duty of care").
2. document-frequency-based down-weighting of near-universal terms —
   probed 2026-08-26, *deferred* (see ADR-002 if filed): the per-token
   DF probe itself is the slow operation (~2 s for a universal term on
   this corpus), so a per-query DF gate would put the latency back
   in the bench rather than out of it. A build-time `token_df` table
   populated by the ETL would be required, which is a corpus change
   and therefore not in this gate's scope.
3. ~~hardware headroom~~ — **partially closed 2026-09-22**: the 8 GB mmap
   window + 64 MB page cache (`db.ts`) eliminated the six-query working-set
   thrash (warm p95 2,817 → 607 ms; tail now stable, no outliers). What
   remains is structural FTS5 scoring (an 81k-row match set for the slowest
   bench query), which needs the ETL-track build-time table from lever #2
   to close.

The gate is not declared met until `pnpm bench` passes; it exits nonzero
while p95 exceeds 500 ms by design. Current standing: p50 met (455 ms),
p95 = 607 ms — 100 ms from budget, attributed to structural FTS5 scoring
of the slowest query's 81k-row match set.

## Golden-set methodology

Truth is case-line based: for each doctrine query the expected list contains
every canonical case line a lawyer would accept as relevant (e.g., the Miranda
progeny for a Miranda-doctrine query), matched as substrings of `case_name`.
precision@10 = credited hits ÷ 10 distinct cases returned. The baseline is
recorded once per scoring-generation change; the runner fails any later change
beyond −0.02 mean.
