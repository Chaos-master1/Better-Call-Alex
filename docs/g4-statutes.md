# G4 — Statutes + Deterministic Calculators

Status: **PASS** (with one environment-conditional item), verified live 2026-09-02.
Evidence: `logs/g4-report.json`, `logs/g4-statutes-spotcheck.json`.

## What was built

### Statutes ingestion — `etl/statutes.py`

Two source adapters, one storage shape (the schema CLAUDE.md reserved):

```
statutes(source, title, section, heading, text, effective_date)
statutes_fts   — external-content FTS5 over statutes(heading, text), porter unicode61
```

- **eCFR** (regulations): `ecfr-title --title N [--date D] [--part P]` streams
  `api/versioner/v1/full/{date}/title-{N}.xml` with `iterparse`, so a full
  title never sits in RAM. Section nodes are `DIV8`/`TYPE=SECTION`; body
  text is gathered from paragraph-level tags only (`P`, `FP`, `PSPACE`,
  `EXTRACT`, `CITA`, `HD*`) — sweeping container tags like `NOTE` would
  double-count their inner paragraphs.
- **US Code** (the Code itself): `usc-title --title N --congress C --law L`
  downloads the OLRC release-point zip
  (`uscode.house.gov/download/releasepoints/us/pl/{C}/{L}/xml_usc{NN}@{C}-{L}.zip`)
  and parses the usc-md `<section>/<num>/<heading>/<content>` format,
  namespace-agnostically, carrying inline `<effective_date>` when present.
  **uscode.house.gov is unreachable from the development network** (connection
  reset), so US Code ingestion is fixture-tested but not yet live-loaded;
  run it from a host that reaches OLRC. eCFR — the source the gate names for
  spot-checking — is live and verified.

Loaded as of 2026-08-31: title 37 (1,331 sections) + title 42 (7,290) =
8,621 eCFR sections in ~6 s of fetch time.

Safety hardening (the codebase's security gate required, and warranted,
all of it): host allow-list + resolved-IP public-range check + redirects
refused in `fetch()`; URL components strict-validated before interpolation;
DTD/ENTITY rejected before parse (defusedxml added as the only new Python
dependency); every SQL statement is a single-line literal with bound
parameters.

### The gate's spot-check — 20/20 against the live eCFR API

`spot-check --n 20` takes a strided deterministic sample of loaded sections,
re-fetches each from the live versioner API, and compares section number,
heading, and the first 120 chars of body text. Result: **20/20 matched**
(`logs/g4-statutes-spotcheck.json`).

### Calculators — `app/lib/calc/dates.ts`

`solDeadline(startISO, years, tolling?)` completes the promised SOL
calculator. Tolling windows are inclusive of both endpoints (a lawyer's
"absent June 1 through August 31" is 92 days); the extension is iterated to
its fixed point so a window straddling the original deadline is fully
counted and overlapping windows count once (union). The unrolled deadline
composes with `nextBusinessDay` for the filing date. Also fixed in this
gate's pass: the cross-year observed New Year's Day bug in
`nextBusinessDay` (Jan 1 on a Saturday is observed Friday **Dec 31 of the
prior year** — federal-deadline math previously returned a closed day).

36/36 calculator tests: leap years (incl. the 2000/2100 century trap),
weekend/holiday rolls (incl. cross-year, Christmas/Juneteenth/Veterans-Day
observed chains), Feb 29 month-end clamping, tolling convergence, unions,
and bad-input rejection.

### Verifier integration — `app/lib/statute.ts` + `app/lib/verify/core.ts`

Full-form statutory cites (`42 U.S.C. § 1983`, `12 C.F.R. § 1026.36`,
`29 USC 1910.1200`) are detected by a narrow pattern anchored on the volume
token, resolved against `statutes`, and checked like case citations; a
quoted statute is verified against the stored section text by the same
quote ladder, and a fabricated statute quote fails the draft. Bare `§ 1983`
short forms remain `unsupported_form` (v1 limitation — the title/code
context they abbreviate is not tracked). When the statutes table has not
been loaded, the verifier keeps its pre-G4 behavior exactly. This closes
the dominant `unsupported_form` rejections for full-form statutory cites
seen in the G3 live run.

**Status nuance (2026-09-23):** the shipped corpus loads eCFR titles only
— there is no US Code — so a valid cite like `42 U.S.C. § 1983` cannot
resolve and is reported `statute_not_loaded` (struck, draft not failed):
the corpus cannot judge it, and the annotation says so instead of
implying the cite is wrong. A wrong section under a loaded title is
still `unresolved_citation` and fails the draft. Loading the US Code
into `statutes` would resolve the common federal cites with no code
change.

Lookup surfaces: `alex lookup "42 C.F.R. § 483.35"` and
`GET /api/lookup?cite=...` resolve statutes after (not instead of) case
citations.

### Adversary retrieval ladder

The Adversary's counter-frame was the named weak point of the G3 live run
(g3-04 returned zero hits). The counter retrieval now degrades in steps:
the model's inverted frame → its longest tokens → a deterministic,
model-free fallback that mines citing cases whose citation context against
the analyst's primary authority speaks of overruling/abrogation/declining.
Verified against the live corpus: the fallback returns real
counter-authority for Roe's cluster (Dobbs-era citation graph).

## Regression evidence

- TypeScript: 60/60 unit tests; G2 fixture gate 9/9 (100%) fabrication
  catch; G3 offline harness PASS; `next build` clean with the merged
  tsconfig (pages/routes are now actually type-checked).
- Python: statutes 5/5, bridge 8/8, textclean 7/7; G0 gate checks pass on
  the live corpus.

## Known limitations (honest list)

- US Code not yet live-loaded (network-blocked dev machine); until then,
  U.S.C. cites resolve only after a US Code title is ingested.
- Statutory subsection pins (`§ 1983(a)`) are annotated `pin_unverified`,
  consistent with the corpus having no star pagination; the subsection text
  is inside `statutes.text` and IS quote-checked.
- The statutes FTS index rebuilds on each title load (fine at corpus
  scale: statutes are ~1% of opinions' size).
- eCFR content is regulations only — the U.S. Code must come from the OLRC
  release points, per CLAUDE.md §4.
