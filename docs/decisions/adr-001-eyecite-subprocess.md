# ADR-001: Citation extraction via eyecite as a Python subprocess

**Status:** accepted (2026-08-24)
**Deciders:** project canon (CLAUDE.md §3, §12); recorded here per §2.

## Context

The G2 Verifier must extract citations from arbitrary draft text and reject
any that do not resolve in the corpus. The runtime is TypeScript
(CLAUDE.md §3: "Python is ETL-only"). However:

- Citation syntax is enormous: reporter variants, parallel cites, pin cites,
  parentheticals, court/year parentheses, short forms.
- The repo already lost weeks to hand-rolled assumptions (CLAUDE.md §12:
  the `gemma4:12b` incident). Hand-writing a citation grammar repeats that
  mistake.
- CourtListener itself parses with `eyecite` — matching its behavior keeps
  corpus-side and verifier-side citation semantics aligned.

## Decision

Run `eyecite` as a **Python subprocess** behind a JSON stdin/stdout bridge
(`verifier/bridge.py`), called synchronously by `app/lib/verify/verify.ts`.
Python remains ETL/runtime-tool-only; no daemon, no service boundary.

## Consequences

- +1 Python dependency at runtime (`eyecite`, pulls `reporters-db`,
  `lxml`). Accepted: canon §12 pre-confirmed eyecite for exactly this role.
- ~1.5 s process spawn including imports per verification; batch mode
  amortizes across drafts. Irrelevant at this volume.
- Reporter normalization arrives via eyecite's bundled `reporters-db`,
  so the deferred JS `reporters-db` package stays deferred (§12).

## Escape condition

A TS port may replace the bridge **only if it matches real eyecite 100% on
the G2 gold set** (`verifier/fixtures/golden.json` plus the LegalBench
overruling split for treatment scanning). Until such a port exists and
passes, the subprocess stays.
