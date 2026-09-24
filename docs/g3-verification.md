# G3 verification — six fact patterns end to end

Run timestamp: 2026-09-24 (Phase E) — **LIVE PASS**, verified rate **90.1%** (109/121) vs the Phase D floor **68.6%** (same local engine, same six patterns); the ratchet floor moved 68.6% → 90.1%. Phase E, each fix diagnosed from a per-citation census (`logs/g3-report.partial.json`, 3 weakest patterns): (1) **pin trust gate** — star pagination only strikes when its anchors match the cited reporter's first page (parallel-paginated captures like `104 S. Ct. 1868` were producing false strikes); (2) **verify-then-revise** — one bounded repair pass where the analyst fixes its own struck sentences from the supplied canonical cites, accepted only if verified-rate rises ≥2pt with no >25% LAW shrinkage, re-verified from scratch, original draft stands on any failure (parser unwraps the model's observed `{"repairs": [...]}` wrapper; any repair error is caught — a repair crash must never kill a pattern); (3) **US Code live** — Title 42 (8,044 sections) loaded via the govinfo-package ETL stage, `42 U.S.C. § 1983` now verifies end-to-end; (4) paraphrase honesty — `[LAW]` sentences with verified cites but zero quote checks carry a "holding not quote-checked" detail line. Per-pattern: g3-01 47%→70.6%, g3-02 95%, g3-03 73%, g3-04 54%→100%, g3-05 93%→100%, g3-06 85%→100%. Repair provenance lands in the certificate's engine list and audit (`verifier.repair`). Committed evidence `logs/g3-report.json` overall:pass.
Prior: 2026-09-23 (Phase D) LIVE PASS 68.6% (81/115) vs pre-grounding baseline 66.0% (70/106, same local engine, same six patterns); the ratchet floor in `evals/g3-baseline-local.json` moved up. Phase D grounding: research hits now carry the corpus's own canonical citation strings (`SearchHit.cites` from indexed `citation_strings`), the analyst must copy pin cites from them verbatim (live run 54 had Sharpe as "488 U.S. 197" — real 470 U.S. 675 — and Hicks as "479 U.S. 118" — real 480 U.S. 321, both from memory, both rightly struck), and render backfills a dropped `pin_cite` field from the checked extraction. tarasoff 47%→73%, regulatory-taking 73%→93%. The harness now runs on a scratch app DB (it previously wrote 6 runs into production). Committed evidence `logs/g3-report.json` overall:pass; prior live passes 2026-08-30 and 2026-08-29 documented below.
Pipeline: `alex run "<facts>"` (CLI) or `POST /api/run` (web UI).
Composition: intake → researcher (qwen3.5:9b) → swap → analyst + adversary (qwen3:14b, batched, ≤2 swaps) → **async** G2 Verifier (`verify_async.ts`, `spawn` not `spawnSync`) → **drafter template** (`draft.ts`, banner in code) → render.
Harness: `evals/g3-patterns.json` (5 patterns) + `evals/run_g3.ts` (`pnpm g3` / `pnpm g3:offline`). Single-flight mutex `run.ts:50` + `llm.ts:66` retry serializes swaps so concurrent `POST /api/run` queue instead of `fetch failed`. Offline harness skips LLM but checks deterministic gates (tag, adversary, audit).

---

## 2026-08-28 addendum — P1 recheck + G3 components

**P1 fixes landed (all 8):** `lib/repo.ts` marker-walk, `verify/quotes.ts` bracket-space, `lib/db.ts` volume/page normalization + ETL `build_corpus.citations`, `retrieval/search.ts` explicit ` AND ` + hay normalization, `build_corpus` dedup to `common.BOUNDARY_RE`, `llm.ts` verify both models at startup, `common.parse_bool` trim, `app_db.ts` trigger `WHEN` + remove global `query_only` ATTACH (which made the app DB read-only). Verifier `make_fixtures` duplicate `raise` removed, `run_g2_fixtures` `caughtAdversarial` fix, `build_authority` `1<<25` guard, `app_db` `cases.updated_at` trigger.

**G3 components added:**
- `app/lib/verify/verify_async.ts` — async eyecite bridge (does not block event loop)
- `app/lib/verify/verify_async.ts` + `app/lib/render.ts:verifyTaggedSentencesAsync` — server uses async, CLI/evals keep sync canonical path
- `app/lib/draft.ts` — `DRAFT_BANNER` + `draftDocument()` pure template, deduplicates `authority_appendix`, audit `drafter.render`
- `app/lib/calc/dates.ts` — deterministic `parseISO/addDays/daysBetween/nextBusinessDay/isExpired` (§5.7)
- `app/app/page.tsx` — authority cards (BM25/authority/parenthetical/recent/inferred), passages with char offsets, element checklist table, adversary + counter-authority, authority appendix, audit log, banner in code, struck-through `!verified`
- `app/app/api/run/route.ts` — now returns `research.hits`, `draft.report`, `drafted`, `audit` (12 rows), `run_id`
- `evals/g3-patterns.json` + `evals/run_g3.ts` (offline passes; full run needs `ollama pull qwen3.5:9b && ollama pull qwen3:14b`, `ALEX_VERIFY_SYNC` toggle, 60s budget per pattern documented as model-bound)

### Live harness 2026-08-29 (after hardening, other apps freed, swap 6.9→1.1 GiB, 9.5 GiB free, single-flight + retry)

```
pre-flight: audit_log append-only trigger ✓

g3-01 motel-§1983                    PASS  8/11 verified overall=fail adversary=5  420s  note 60s warn
g3-02 terry-stop                     PASS 13/16 verified overall=fail adversary=5  401s  note 60s warn
g3-03 tarasoff (cal)                 PASS 14/15 verified overall=fail adversary=5  459s  note 60s warn
g3-04 personal-jurisdiction          PASS  8/8  verified overall=pass adversary=0  739s  note 600s warn (narrow query, empty adversary is correct per prompt, not invented)
g3-05 regulatory-taking              PASS 10/11 verified overall=fail adversary=5  408s  note 60s warn

G3 report → logs/g3-report.json  overall=pass  offline:false  patterns 5/5
```

Wall-clock is model-bound (cold load 22s 9b + 18s 14b + 5 generates + verifier 90-candidate scan over 197 GB FTS). `llm.ts:66` now retries `fetch failed` 3× with backoff, `run.ts:50` single-flight queues concurrent runs, `run_g3.ts:34` hard budget 600s warn-only. The 60s demo target is **CONDITIONAL** on ≥16 GiB or `num_ctx 16k` — same root cause as G1 `p95 616ms >500ms` (page-cache, `docs/retrieval.md:76`). Every sentence still gated; `overall=fail` means some `LAW` without pin was correctly struck-through, not dropped.

Prior offline harness still green:
```
pre-flight: audit_log append-only trigger ✓
g3-01..g3-05 offline: skipped LLM run, spec shape OK
G3 report → logs/g3-report.json  overall=pass (offline)
```
Single-agent probe prior to full run:
```
intakeAgent → ok
researcher  → 3 queries, 18 hits, Stoddard / Rowland / Braswell
useModel swap → ok (33%GPU/67%CPU → after free 100%GPU 5.6 GiB, swap trimmed)
```

---

## 2026-08-27 run (prior build, kept for history)

Pipeline: `alex run "<facts>"` (CLI) or `POST /api/run` (web UI).
Composition: intake → researcher (qwen3.5:9b) → analyst + adversary (qwen3:14b) → G2 Verifier → render.

G3 §8 acceptance:
- Every sentence either carries a resolving pin cite or is visibly
  struck through.
- The Adversary returns real opposing authority.
- Nothing reaches the UI ungated by G2.

## Summary

| #  | Pattern                                | Verdict                       | Verified | Adversary hits | Time   |
|----|----------------------------------------|-------------------------------|----------|----------------|--------|
| 01 | False arrest at motel — § 1983         | FAIL (struck-through rendered)| 8/13     | 5              | 7.0m   |
| 02 | Warrantless vehicle search — 4A        | **PASS**                      | 16/16    | 5              | 7.3m   |
| 03 | Qualified immunity — taser             | FAIL (struck-through rendered)| 7/10     | 0              | 4.4m   |
| 04 | Title VII — hostile work environment   | FAIL (struck-through rendered)| 8/9      | 5              | 4.6m   |
| 05 | Miranda — custodial interrogation      | FAIL (struck-through rendered)| 8/12     | 5              | 4.2m   |

Acceptance check:

| §8 criterion                                           | Met? | Notes |
|--------------------------------------------------------|------|-------|
| Every sentence carries a resolving pin cite or is struck through | ✅ | Verifier gates the render; unverified sentences carry the strikethrough tag in the response payload |
| Adversary returns real opposing authority             | ⚠️ | 4/5 patterns returned real hits (5/5/0/5/5); fact-03 returned 0, which is a known weak point — the inverted frame query is generic |
| Nothing reaches the UI ungated by G2                   | ✅ | render.ts is the only path; `verifyTaggedSentences` is the only way to turn agent JSON into UI sentences |

The fact-03 adversary-zero result is the same gap the canon calls out
in §3: "The Adversary is the feature nobody else ships — here is the
best case against you, retrieved rather than invented." The retrieval
found nothing, and the agent (correctly per its prompt) reported
"counter_authority: []" rather than inventing. That is the right
behavior; the gap is the inverted-frame query in
`agents/index.ts:counterQueryFrom`, which is a generic retrieval and
should be the next thing tightened once the underlying retrieval
itself is reliable.

## Per-pattern detail

### fact-01 — False arrest at motel

**Issue:** Whether the motel and police officers violated the
plaintiff's constitutional rights under 42 U.S.C. § 1983 by arresting
him without probable cause and potentially engaging in racial
discrimination.

**Conclusion:** The plaintiff may have a claim for false arrest under
42 U.S.C. § 1983 if it can be shown that the arrest was without
probable cause. However, the claim is not yet fully established due to
the lack of information regarding the motel's status as a state actor
and the absence of specific allegations of racial discrimination.

**Adversary argument:** The counter-argument is that false arrest
under 42 U.S.C. § 1983 does not require a showing of absence of
probable cause, but rather focuses on whether the arrest was supported
by probable cause. The existence of probable cause for an arrest
constitutes a complete defense to a claim of false arrest under
§ 1983, as established in Jenkins v. City Of New York.

**Unverified sentences (rendered struck-through):**

- ~~In Jenkins v. City Of New York, the court held that a claim of
  false arrest under § 1983 requires the plaintiff to establish that
  the arrest was without probabl…~~ — cite '§' → unsupported_form
- ~~In Gold v. City of Miami, the court noted that a false arrest
  claim under § 1983 must be based on the absence of probable cause
  for the arrest.~~ — cite '§' → unsupported_form
- ~~However, the facts do not provide sufficient information to
  determine whether the arrest was racially motivated or whether the
  motel is a state actor, which is…~~ — cite '§' → unsupported_form
- ~~The counter-argument is that false arrest under 42 U.S.C. § 1983
  does not require a showing of absence of probable cause, but rather
  focuses on whether the arre…~~ — cite '42 U.S.C. § 1983' → unsupported_form
- ~~The existence of probable cause for an arrest constitutes a
  complete defense to a claim of false arrest under § 1983, as
  established in Jenkins v. City Of New Y…~~ — cite '§' →
  unsupported_form; LAW sentence without pin cite → unverified

**Diagnosis:** The model cites "Jenkins v. City Of New York" and
"Gold v. City of Miami" without pin cites (volume + reporter + page),
and uses "§ 1983" which eyecite (per the G2 contract, docs/verifier.md
§"short/id/supra forms") does not treat as a resolvable citation
form. Both are correct rejections; the user sees the unverified
material and knows the boundary.

### fact-02 — Warrantless vehicle search

**Issue:** Whether the officer's warrantless search of the entire
vehicle was lawful under the Fourth Amendment.

**Conclusion:** The officer's warrantless search of the entire
vehicle may have been unlawful under the Fourth Amendment if there
was no probable cause to believe that contraband was hidden in other
parts of the vehicle. The officer had probable cause to search the
vehicle for marijuana based on the smell of marijuana, but it is
unclear whether the officer had probable cause to search the entire
vehicle for other contraband, such as cocaine.

**Adversary argument:** The officer's warrantless search of the
entire vehicle was lawful under the automobile exception because the
smell of marijuana provided probable cause to search the entire
vehicle for contraband. United States v. Ross, 456 U.S. 798, 800
(1982).

**Unverified sentences:** none — all 16 verified.

**Diagnosis:** This is the strongest run. The model retrieved
United States v. Ross via the researcher's "automobile exception"
query and produced a properly-formed pin cite. Adversary returned the
canonical counter-authority for the same question.

### fact-03 — Qualified immunity taser

**Issue:** Whether the officer's use of a taser on a non-resisting
suspect constituted excessive force under the Fourth Amendment and
42 U.S.C. § 1983.

**Conclusion:** The officer's use of a taser on a non-resisting
suspect that caused serious injury may constitute excessive force
under the Fourth Amendment and may give rise to a claim under
42 U.S.C. § 1983.

**Adversary argument:** The use of a taser on a non-resisting suspect
does not automatically constitute excessive force. The reasonableness
of the force used depends on the specific circumstances.

**Adversary hits: 0** — the inverted-frame retrieval found nothing
that contradicts the analyst's framing. The agent correctly
reported this rather than inventing.

**Unverified sentences:**

- ~~The officer's actions may also be subject to liability under
  42 U.S.C. § 1983 if the use of force was unreasonable and violated
  clearly established law.~~ — cite '42 U.S.C. § 1983' → unsupported_form
- ~~The reasonableness of the force used depends on the specific
  circumstances, including the severity of the crime, the threat
  posed by the suspect, and the need f…~~ — LAW sentence without pin cite → unverified
- ~~Therefore, the officer's actions may not necessarily violate
  clearly established law, and the claim under 42 U.S.C. § 1983 may
  not be viable.~~ — cite '42 U.S.C. § 1983' → unsupported_form

### fact-04 — Title VII hostile work environment

**Issue:** Whether the employer is liable for Title VII hostile work
environment and retaliation claims.

**Conclusion:** The female employee has potentially met the elements
of a hostile work environment and retaliation claim under Title VII,
but further information is needed to determine the employer's
liability and the specific nature of the retaliation.

**Adversary argument:** The employer may not be liable if it
demonstrated prompt and appropriate corrective action. The employer
may also argue time-bar and that the alleged retaliation was unrelated
to the protected activity.

**Unverified sentences:**

- ~~42 U.S.C. § 2000e-3(a).~~ — cite '§' → unsupported_form

**Diagnosis:** 8/9 verified; the lone failure is a fragment the model
emitted mid-sentence. The substantive content is verified.

### fact-05 — Miranda custodial interrogation

**Issue:** Whether the incriminating statements made by the suspect
are admissible in court, given that the suspect was not given
Miranda warnings prior to being questioned.

**Conclusion:** The incriminating statements made by the suspect are
likely inadmissible in court because the suspect was not given
Miranda warnings prior to being questioned.

**Adversary argument:** The statements may still be admissible if
voluntary. As demonstrated in Berkemer v. McCarty, 468 U.S. 420
(1984), and Pennsylvania v. Muniz, 494 U.S. 560 (1990).

**Unverified sentences:**

- ~~The incriminating statements made by the suspect may still be
  admissible even in the absence of Miranda warnings if they were
  made voluntarily and without coerc…~~ — LAW sentence without pin cite → unverified
- ~~As demonstrated in cases such as Berkemer v. McCarty, 468 U.S. 420
  (1984), and Pennsylvania v. Muniz, 494 U.S. 560 (1990), courts have
  admitted statements made…~~ — cite '468 U.S. 420' → verified; cite '494 U.S. 560' → unresolved_citation
- ~~Additionally, in Salinas v. Texas, 570 U.S. 171 (2013), the Court
  held that a suspect's silence during police questioning may not
  always be protected by the Fif…~~ — cite '570 U.S. 171' → unresolved_citation
- ~~These cases support the argument that the absence of Miranda
  warnings does not automatically render statements inadmissible,
  and the admissibility of the suspec…~~ — LAW sentence without pin cite → unverified

**Diagnosis:** The model invented two citations ("494 U.S. 560"
Muniz and "570 U.S. 171" Salinas). eyecite rejected both; Berkemer
(468 U.S. 420) resolved. This is the failure mode the Verifier
exists to catch: the user sees "Pennsylvania v. Muniz, 494 U.S. 560"
struck through and knows it is not a real pin cite in the corpus.

## What was checked

- `alex run` end-to-end output against five hand-built fact patterns.
- Verifier gating produces per-sentence `verified: true/false`; false
  sentences carry `detail: string[]` naming the failing check.
- DRAFT banner applied in the CLI render path.
- audit_log rows appended for every step (run, intake, researcher,
  analyst, adversary, verifier, error).
- No ungated path to the UI: `verifyTaggedSentences` is the only way
  to turn agent JSON into `VerifiedSentence[]`.

## What was NOT checked (and why)

- **60-second demo target.** Per-pattern time was 4–7 minutes on the
  24 GB dev machine. FTS5 bm25 over the 197 GB corpus index is
  page-cache-bound, and the LLM model load (~110 s cold for 14b)
  cannot be hidden in interactive use here. The architecture is
  correct (uncontended runs in the g0 audit measured retrieval at
  257–442 ms) and on a machine that holds the corpus working set
  this gate will pass. Documented in docs/retrieval.md and
  ba3f9ef ("G1: latency gate deferred — environment, not architecture").
- **Treatment-scan FPR.** G2 is unchanged. The §3 Adversary's
  treatment_caveats field renders with the inferred label and is
  not asserted as fact, per §5.5.
- **Statutes (G4).** Out of scope for G3.
- **DOCX/PDF export (G5).** Out of scope for G3.
