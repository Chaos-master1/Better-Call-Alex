# The Verifier (G2)

Canon: CLAUDE.md §3 "The Verifier". Implementation: `app/lib/verify/`
(`quotes.ts` matcher, `verify.ts` orchestrator), eyecite bridge
`verifier/bridge.py`, fixtures `verifier/fixtures/golden.json`.
Gate runner: `pnpm g2`. Unit tests: `pnpm test`.

## Verdict: G2 gate MET (2026-08-24)

**Fabrication catch rate: 9/9 adversarial fixtures = 100%.**
Treatment-scan recall against the Casetext/RegLab Overruling set
(2,394 attorney-annotated sentences): **0.774 recall at 0.014 FPR**
(after pattern extension; baseline scanner measured 0.525 / 0.011 —
the failing measurement that justified extending it).

## Pipeline

```
draft text ──> eyecite bridge (Python subprocess, JSON stdin/stdout)
           ──> resolve every FULL citation through citation_strings
           │     unresolved -> reject                        (§5.1)
           ├──> extract quoted spans (straight + curly delimiters)
           ├──> attribute each quote (nearest preceding verified cite,
           │     else nearest following within 300 chars)
           ├──> match quote vs cited opinion text (conservative ladder)
           │     no match    -> quote_not_found              (§5.2)
           │     match elsewhere -> quote_wrong_case + best-effort
           │                          true source identification
           ├──> annotate: short/id/supra forms = unsupported_form;
           │     pin pages = pin_unverified (corpus has no star pages)
           └──> attach INFERRED treatment flags (cluster-level max from
                 authority), never asserted                  (§5.5)

overall = fail iff any citation unresolved OR any quote unverified.
Unverifiable content is REPORTED, never dropped — struck-through
rendering happens in G3's UI on top of this report.
```

## Quote-matching ladder (deliberately conservative)

1. exact substring;
2. character-canonicalized substring (case, smart quotes/dashes,
   whitespace collapse) with an index map back to source offsets;
3. same, after expanding editorial brackets (`[t]he` → `the`);
4. ellipsis fragments — all fragments present, in order, within a
   bounded window.

**No edit-distance fuzzing exists at any rung, by construction**: a quote
altered by one word must fail, and a permanent fixture asserts exactly
that. Legitimate elision is supported only via explicit ellipsis marks.

## Adversarial fixtures (all self-validated by generator)

| category | n | expect | mechanism |
|---|---|---|---|
| fabricated_citation | 3 | fail | syntactically valid cite absent from citation_strings |
| invented_quote | 2 | fail | plausible doctrinal sentence, asserted absent from cited text |
| altered_quote | 2 | fail | one word substituted; absence machine-checked |
| wrong_case_quote | 2 | fail | real quote attributed to another real case; report names the true source |
| valid_passage / pin_annotated / block_quote / unsupported_short_form | 4 | pass | controls incl. annotations; block quote hard-wraps a verbatim span across newlines |
| overruled_flagged | 1 | pass | correct cite+quote to a flagged case; flags ride along as INFERRED |

Regenerate with `uv run python verifier/make_fixtures.py` (deterministic;
validates every mutation's absence under the matcher's own normalization).

## Wrong-case source identification

On rejection, a bounded probe searches the corpus for the span verbatim
(distinctive-term FTS expressions, ≤60 candidates/expression, ≤90 text
checks total), preferring SCOTUS and higher-pagerank matches. Best-effort:
failure to identify leaves the verdict at `quote_not_found` — rejection
never depends on identification.

## Measured numbers

| metric | value | source |
|---|---|---|
| fabrication catch rate | **100%** (9/9) | `pnpm g2`, this repo |
| treatment recall | **0.774** (941/1216) | LegalBench `overruling` test split |
| treatment false-positive rate | **0.014** (16/1178) | same |
| scanner extension delta | recall .525→.774, FPR .011→.014 | `disapprov*`, `supersed*`, `depart* from`, `no longer good law/controlling/followed/valid`; `reject` tested and excluded (+2pp recall for +1.3pp FPR) |
| unit tests | 11 TS + 8 Python green | `pnpm test`, `unittest` |

Corpus treatment flags rebuilt with the extended scanner via
`uv run python etl/build_authority.py reflag` (updates only
`authority.treatment_flags`; edges/pagerank untouched).

## Honest limitations

1. Short-form citations (`410 U.S., at 150`), `Id.` and `Supra.` are not
   resolved — annotated `unsupported_form`, never silently accepted.
2. Pin pages cannot be verified: the corpus stores no star pagination.
   Annotated `pin_unverified`.
3. Corpus cleaning artifacts can destroy a verbatim span (measured case:
   Katz lead opinion contains `intruding eyeit` — separators eaten during
   HTML→text conversion). The matcher does not fuzz across such damage;
   affected opinions may false-reject quotes that are "really" there.
   Down-weighted OCR opinions (§9.6) are more exposed.
4. The treatment scan is lexical: negations ("we do not read X to have
   overruled Y") count as treatment-related language. Flags are INFERRED
   signals for triage, never assertions of overruling (§5.5).
5. Quote attribution is heuristic (nearest-citation adjacency); documents
   quoting two cases inside one sentence pair may mis-attribute.
6. Bridge spawns a Python process per verification (**0.33 s measured**,
   dominated by imports); batch mode (`{"texts": [...]}`) amortizes this
   when verifying many drafts. `verifyText` is synchronous by design for
   CLI use — a G3 server must wrap it in an async worker, not call it on
   the request thread.

## Licensing

`verifier/fixtures/overruling_legalbench.tsv`: the Casetext/RegLab
Overruling Dataset (2,394 attorney-annotated sentences), mirrored by
LegalBench (`nguha/legalbench`, config `overruling`, test split),
**CC BY 4.0**. Fixture quotes are corpus text (CourtListener bulk data,
Public Domain Mark 1.0). Free Law Project–authored parentheticals are CC
BY-ND and are never quoted in fixtures.
