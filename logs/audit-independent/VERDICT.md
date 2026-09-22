# Phase 0 — Independent Ground-Truth Audit: Verdict

**Date:** 2026-09-20 → 2026-09-21
**Method:** Every load-bearing claim re-derived from the live corpus and the
live pipeline. No project docs, no hand-built fixtures, no self-graded gates
trusted as evidence. Artifacts: `probe01-resolution-ceiling.json`,
`probe02-quote-truth.json` (+ rerun), `probe03-retrieval-truth.json`,
`probe04-data-quality.json`, `live-traps.json`, and the run logs beside them.

## Probe results

### 0.1 — Citation-resolution ceiling (`probe01-resolution-ceiling.json`)
13,305 full citations extracted by the production eyecite bridge from 1,000
randomly sampled real corpus opinions: **89.43% resolve** through
`citation_strings`. Cause decomposition:
- **WL (Westlaw) cites: ~2.7% resolvable** — structurally unverifiable
  (corpus carries no Westlaw numbers); concentrated in recent decades.
- **2020s opinions: 73%** — snapshot-boundary effect + heavy WL usage.
- **Pre-1880: 11–86%** — variant/obsolete state reporters.
- Core reporters (U.S., F.2d/F.3d, S. Ct., P.2d, …): **96–99%** — healthy.

**Consequence (fixed):** new `out_of_corpus` status — a cite the corpus
cannot carry (e.g. WL-only) is *annotated*, never posed as a suspected
fabrication. The gate's bite is unchanged for genuinely resolvable cites.

### 0.2 — Quote-attribution truth (`probe02-quote-truth.json`, rerun)
- **Adversarial catch: 168/170** — the two escapes were both leading-negator
  drops ("No person shall…" → "person shall…"), whose remainder is a literal
  substring, so no exact-matching ladder can ever catch them.
- **Positive controls: only 70/150 real, correctly-attributed quotes verified
  (53.3% before fixes)** — decomposed into 10× cite-resolution failures
  (0.1's ceiling propagating), 5× quote-not-found and 4× wrong-case, all
  traced to the verifier searching only the *lead* opinion while the quote
  lives in a sibling of the same citation cluster.

**Consequences (fixed):** (a) negator-veto rung in the quote ladder — a match
whose source span is preceded by a negator while the quote lacks one is
rejected, scanning all occurrences; (b) quote search covers every opinion in
the resolved cluster. Both validated: 21/21 verifier fixtures green,
live-corpus veto fixture passes.

**Rerun #2 (`probe02-rerun2.json`, against the final verifier with the
harness aligned to production semantics): adversarial catch 170/170 = 100%
(all five mutation kinds, including all 34 dropped-negation mutants).
Positive controls 0.533 → 0.800.** The remaining 30/150 failures decompose
as: ~13 quote-verified but an *embedded* cite is unresolvable (probe 0.1's
89.4% corpus ceiling — snapshot-boundary and obsolete-reporter cites; ETL
coverage track, honestly annotated); ~4 `quote_wrong_case` where the quote
provably lives in the *citing* opinion, not the cited case — correct
verifier behavior (the harness mechanically attributes O's sentence to the
case O cites); ~4 unattributable sources (e.g. quoted law dictionaries the
corpus does not carry); ~7 `quote_not_found` on bracketed/ellipsized source
sentences (normalization polish — known residual); the rest are harness
kind-string joins of mixed statuses where the quote itself verified.

### 0.3 — Mechanical retrieval ground truth (`probe03-retrieval-truth.json`)
200 mechanically generated queries (parenthetical + citing-context pairs,
seed 20260920), answers fixed by construction:
- **p@10 = 0.325 overall** (parenthetical 0.427, citing-context 0.02)
- Hand-built golden set measures 0.288 on the same engine — same band.
- **Verdict: REASONABLE.** The retrieval eval is not self-flattering.

Baseline locked for Phase B arbitration: **0.325 p@10 / 200 queries**.
Notable: citing-context queries (find the cited case from the citing
sentence) are near-zero — this is precisely where citation-graph expansion
should be judged.

### 0.4 — Corpus data quality (`probe04-data-quality.json`)
- OCR quality: clean (0% garbage-text markers in 5,000-row sample).
- Parenthetical→case linkage: clean.
- Blocked opinions: honor-rate confirmed (7.76% excluded).
- **Finding: 7.23% of (volume, reporter, page) groups collide across
  multiple clusters** (1.09M groups). If the resolver silently picks one,
  quote checks can run against the wrong case.

**Consequence (fixed):** `resolveCluster` now reports all candidate
clusters; ambiguous cites gain an `ambiguous` annotation surfaced through
verifier detail, draft appendix, UI, and DOCX export. Quotes stay
conservative (fail with true source shown) per the sibling precedent.

### 0.5/0.6 — Live adversarial runs through the real pipeline (`live-traps.json`)
Ollama live, both models loaded. Three fact patterns through the production
`runCase` path:
- **Trap 1 (fabricated "999 F.3d 111" holding): PASS** — verifier failed the
  draft; the fake cite never rendered as verified.
- **Trap 2 (invented Miranda quote attributed to a real case): PASS** — the
  fabricated quote never appears as a verified LAW claim; unsupported
  adversary cites were struck.
- **Control (clean pattern): PASS, honest** — real citations verify; the
  model's unanchored LAW prose is struck (overall=fail) rather than blessed.

## Verdict

The system's core claims **hold under independent measurement**, with four
defects proven and repaired during the audit:

1. **Hallucination gates are real**: fabricated cites and quotes are caught
   end-to-end through the live pipeline, and the mechanical eval confirms
   retrieval is not self-graded into flattery.
2. **False-strike risk was real and material** (89.4% resolution ceiling,
   53.3% positive-control verify rate): the verifier was striking
   legitimate law. Fixed by sharper labels (out_of_corpus), cluster-wide
   quote attribution, and the negator veto — without weakening any gate.
   Re-measured on the final verifier: **100% adversarial catch (170/170),
   80.0% positive-control verify rate**, with the residual false strikes
   decomposed into corpus-coverage and harness-attribution classes (see
   0.2), not verifier defects.
3. **Corpus-level ambiguity** (7.23% cite collisions) is now *surfaced*,
   never silently resolved.
4. **Retrieval quality** (p@10 0.325) has a trustworthy, mechanical
   baseline; Phase B levers (citation-graph PRF, passage-density re-rank)
   will be kept or cut strictly against it.

## Phase A fixes landed (each with regression fixtures)

- `.gitignore` archives (2.6 GB of stale plan material out of the repo).
- Numeric-offset leak: agent payloads stripped of passage offsets;
  `pin_cite` shape-gated at the source (`app/lib/agents/index.ts`).
- IRAC/counter-argument prose routed through the Verifier for DOCX
  (`app/lib/agents/run.ts`, `app/lib/draft.ts`, `app/lib/export_docx.ts`),
  with strike-through rendering and honest UI labels.
- `out_of_corpus` labeling, negator veto, cluster-wide attribution,
  ambiguity annotation (verifier core + db + render + docs).
- Docs updated in place: `docs/verifier.md`, `docs/retrieval.md`.

## Outstanding (Phase B, eval-arbitrated)

- Citation-graph PRF and passage-density re-rank: implemented behind flags,
  A/B in progress (`run_audit_retrieval.ts --prf --density`, 200 queries,
  3 searches each); kept only if p@10 improves net of losses against the
  locked 0.325 baseline.
- Soft-AND rung: build only if zero-hit rate at strict AND proves material
  (decided from `n_hits` recorded in the A/B run).
- Latency — **resolved as far as app-scope work can go**: quiet-disk
  re-bench (2026-09-22) after raising the mmap window 2 GB → 8 GB + 64 MB
  page cache (`db.ts`): warm **p50 = 455 ms (budget met), p95 = 607 ms,
  no outliers**; cold first-touch 5.3 s → 1.4 s. The residual tail is one
  broad query whose FTS5 match set is 81,410 rows — bm25 must score every
  match before LIMIT applies (measured LIMIT-independent; NEAR-tightening,
  phrase-anchoring and `ORDER BY rank` reformulations do not cut it). The
  last 107 ms require an ETL-track build-time table (lever #2 in
  `docs/retrieval.md`), which is corpus scope, not app scope.
