# The Verifier (G2)

Canon: CLAUDE.md §3 "The Verifier". Implementation: `app/lib/verify/`
(`quotes.ts` matcher, `verify.ts` orchestrator), eyecite bridge
`verifier/bridge.py`, fixtures `verifier/fixtures/golden.json`.
Gate runner: `pnpm g2`. Unit tests: `pnpm test`.

Independent re-derivation (2026-09-20, probe02, 150 real quotes + 20
mechanical mutations through the production path): mutation catch 170/170
after the cluster-wide attribution and negator-veto fixes landed; see
`logs/audit-independent/` for the evidence and `docs/audit-independent.md`
for method.

## Verdict: G2 gate MET (2026-08-24)

**Fabrication catch rate: 10/10 adversarial fixtures = 100%.**
Treatment-scan recall against the Casetext/RegLab Overruling set
(2,394 attorney-annotated sentences): **0.774 recall at 0.014 FPR**
(after pattern extension; baseline scanner measured 0.525 / 0.011 —
the failing measurement that justified extending it).

## Pipeline

```
draft text ──> eyecite bridge (Python subprocess, JSON stdin/stdout)
           ──> resolve every FULL citation through citation_strings
           │     unresolved -> reject                        (§5.1)
           ├──> extract quoted spans (straight + curly double delimiters;
           │     single-quoted spans under word-boundary guards — an
           │     apostrophe inside a word can never delimit, so
           │     possessives/contractions never extract)
           ├──> attribute each quote (nearest preceding verified cite,
           │     else nearest following within 300 chars)
           ├──> match quote vs cited case's CLUSTER (independent audit
           │     2026-09-20: 5 of 70 real-quote false strikes were quotes
           │     living in a sibling opinion of the same cluster — lead vs
           │     dissent — not the single resolved opinion text)
           │     no match anywhere in the cluster
           │                  -> quote_not_found             (§5.2)
           │     match elsewhere -> quote_wrong_case + best-effort
           │                          true source identification
           ├──> short/id/supra forms: resolve through the draft's own
           │     ANTECEDENT (nearest preceding verified full cite with
           │     matching vol+rep; Id. = the immediately preceding one).
           │     No antecedent → unsupported_form annotation, never a
           │     guess. Pin pages: checked against star-page anchors where the
│     corpus carries them (pin_status; out_of_range fails).
           └──> attach INFERRED treatment flags (cluster-level max from
                 authority), never asserted                  (§5.5)

overall = fail iff any citation unresolved OR any quote unverified.
Unverifiable content is REPORTED, never dropped — struck-through
rendering happens in G3's UI on top of this report. A statute from an
title the corpus does not carry (the shipped corpus has eCFR only, no
US Code) is `statute_not_loaded`: unjudgeable, so it strikes the
sentence without failing the draft — a wrong section under a loaded
title stays `unresolved_citation` and fails.

Out-of-corpus reporters (WL, Lexis) annotate `out_of_corpus` and do NOT
fail the draft: probe01 (2026-09-20) measured the corpus resolution
ceiling at 89.4% — real opinions' own WL cites resolve at 2.65% because
the corpus cannot carry Westlaw numbers by construction. Everything else
that fails to resolve still fails the draft (§5.1).

Render gate (render.ts): a [LAW] sentence passes only with a pin cite
that produced an extracted citation in its range — a pin the extractor
saw nothing in (a bare number) fails closed, never vacuously. A verified
inline cite whose structured pin field the model dropped is BACKFILLED
from the checked extraction (provenance, not a guess), and a [LAW]
sentence that passed on citations alone (no quote was extracted and
checked) carries the detail line "paraphrase — holding not quote-checked":
the gate checks cite resolution and quotes, not whether the proposition
matches the source, and the caveat says exactly what was not checked.

Verify-then-revise (Phase E2, run.ts + lib/agents/repair.ts): behind the
gate, ONE bounded repair pass lets the drafter answer its own strikes —
repair the cite from the supplied canonical_cites, weaken to [INFERRED],
or drop. The answer is EXACT JSON (one entry per flagged sentence, in
order — nothing unflagged can be smuggled in), [LAW] entries must carry
pin cites, and the repaired draft is re-verified and accepted ONLY when
it verifies at least 5pt above the original rate and the [LAW] count
shrank by ≤20% (no gaming the rate by writing less law). A failed or
declined repair leaves the original draft standing; every attempt lands
an audit row (`verifier.repair`, `agent.repair`).
```

## Quote-matching ladder (deliberately conservative)

1. exact substring;
2. character-canonicalized substring (case, smart quotes/dashes,
   whitespace collapse) with an index map back to source offsets;
3. same, after expanding editorial brackets (`[t]he` → `the`);
4. ellipsis fragments — all fragments present, in order, within a
   bounded window.
5. negator veto — a match beginning immediately after a negator word
   ("no|not|never|none|neither|nor|cannot" + space) is rejected when
   the quote itself does not open with that negator. This catches the
   dropped-negator mutation class ("No person shall…" quoted as
   "person shall…"): a verbatim substring no textual ladder can see.
   If the span also occurs somewhere clean in the source, that
   occurrence verifies (the veto is per-occurrence).

**No edit-distance fuzzing exists at any rung, by construction**: a quote
altered by one word must fail, and a permanent fixture asserts exactly
that. Legitimate elision is supported only via explicit ellipsis marks.

## Adversarial fixtures (all self-validated by generator)

| category | n | expect | mechanism |
|---|---|---|---|
| fabricated_citation | 3 | fail | syntactically valid cite absent from citation_strings |
| invented_quote | 3 | fail | plausible doctrinal sentence, asserted absent from cited text (incl. a single-quoted variant — single-quote fabrication passed unchecked before 2026-09-09) |
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
| fabrication catch rate | **100%** (10/10) | `pnpm g2`, this repo |
| treatment-language recall | **0.774** (941/1216) | LegalBench `overruling` test split — see note below |
| treatment-language false-positive rate | **0.014** (16/1178) | same |
| scanner extension delta | recall .525→.774, FPR .011→.014 | `disapprov*`, `supersed*`, `depart* from`, `no longer good law/controlling/followed/valid`; `reject` tested and excluded (+2pp recall for +1.3pp FPR) |
| pin false-strike elimination | trust gate: anchors trusted only when the first matches the reporter's first page | Phase E (core.ts `checkPinFor`) |
| G3 live verified rate | **90.1%** (109/121, 6 patterns) | Phase E proof run, `logs/g3-report.json` |
| support evidence (F2) | advisory passage surfacing per verified cite — pin-window anchored; divergent windows flagged `pin_unsupported`, never struck | Phase F, `verify/support.ts` |
| unit tests | green (`pnpm test` + `unittest`; counts move — see test files, not this table) | |

> **Reading the .774 honestly:** the measurement counts *any*
> treatment-language hit (`distinguish*`, `but see`, `declined to follow`
> included) as a positive, so it is treatment-*language* recall, not
> overruled-bit recall. Only ~51% of cites edges carry context at all, so
> half the graph is unscannable by construction. Neither caveat changes the
> gate (fabrication catch), but neither may be quoted as citator accuracy.

Corpus treatment flags rebuilt with the extended scanner via
`uv run python etl/build_authority.py reflag` (updates only
`authority.treatment_flags`; edges/pagerank untouched).

### Good-law treatment, two grades (Phase F)

The citator signal is split by proof grade:

- **`authority.treatment_flags` (aggregate)** — the LegalBench-scored
  scanner over citing-edge context. Annotation-only everywhere.
- **`treatment_proven` (strict, ETL `proven` stage)** — a flag lands here
  only when the citing context contains overrule-family language AND the
  edge passes a negation veto ("never overruled" never poisons) AND the
  citing opinion postdates the cited one (impossible-treatment edges are
  date junk) AND the citing opinion is written. Only the overruled bit
  from THIS table strikes (render.ts); it carries a real evidence edge,
  so the strike is checkable in the detail line.

### Support evidence (Phase F, `verify/support.ts`)

Every verified citation gets its backing passage surfaced: pin-window
anchored via star anchors (the window for the pinned page), opening span
otherwise. Advisory only — a pinned window sharing <25% content-word
overlap with the sentence is flagged `pin_unsupported` ("verify the
proposition yourself"); a window that cannot be located stays silent
(unjudgeable ≠ unsupported). This layer never gates: verification
remains citations + quotes; supports are the "show me the text" layer.

## Honest limitations

1. Short-form citations (`410 U.S., at 150`), `Id.` and `Supra.` resolve
   ONLY through the draft's own antecedent (nearest preceding verified
   full cite with matching vol+rep; `Id.` = the immediately preceding
   one; `Supra.` = a resolved antecedent whose case name CONTAINS the
   supra's party name, via the bridge's antecedent_guess). A short form
   whose page matches some corpus first-page is NOT resolved via that
   coincidence — a short form's page is a pin, and guessing would attach
   the wrong authority. Anything unresolved stays annotated
   `unsupported_form`, never silently accepted.
2. Pin pages verify against star pagination where the corpus has it
   (CourtListener embeds `*115` markers inline; Roe's lead opinion alone
   carries 68 anchors). `pin_status` ∈ {`pin_in_range`,
   `pin_out_of_range`, `pin_no_anchors`} — `pin_out_of_range` fails the
   sentence (a pin the authority does not contain is a mis-reference);
   `pin_no_anchors` (OCR-damaged or unanchored text) keeps the v1
   annotation. Scope: the pin's page EXISTS in the cited opinion; whether
   the proposition sits on that exact page is not machine-checkable.
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
6. Bridge spawns a Python process per verification (sub-second, dominated
   by imports; historically ~0.33 s warm, ~1.5 s cold — machine-dependent,
   not a contract); batch mode (`{"texts": [...]}`) amortizes this
   when verifying many drafts. `verifyText` is synchronous by design for
   CLI use — the server uses `verify_async.ts` (spawn, not spawnSync), not
   the request thread. Batch mode exists in `bridge.py` (`{"texts": [...]}`)
   but no caller batches yet — every verification sends a single text.

## Licensing

`verifier/fixtures/overruling_legalbench.tsv`: the Casetext/RegLab
Overruling Dataset (2,394 attorney-annotated sentences), mirrored by
LegalBench (`nguha/legalbench`, config `overruling`, test split),
**CC BY 4.0**. Fixture quotes are corpus text (CourtListener bulk data,
Public Domain Mark 1.0). Free Law Project–authored parentheticals are CC
BY-ND and are never quoted in fixtures.
