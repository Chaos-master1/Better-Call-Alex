# ADR-002 — Forward intake jurisdiction into retrieval

Date: 2026-09-03. Phase 1 audit finding (jurisdiction filter dead in pipeline).

## Context

`intake.jurisdiction` (the user's asserted forum) was collected by the intake
agent but never forwarded: `researcherAgent` called `search(db, q.q,
{ limit: 8 })` with no jurisdiction, so out-of-forum hits were presented as
relevant. The filter path itself (`search()` + CLI `--jurisdiction`) worked.

## Decision

The researcher resolves `intake.jurisdiction` via `matchJurisdiction()` and
filters retrieval when it resolves; an unresolvable forum falls back to
unfiltered search.

Naive forwarding (passing the raw string into `search()`'s jurisdiction
option) was rejected: `courts.jurisdiction` holds opaque codes (`ST`, `F`,
…), not names, so a forum like "California" would resolve to the empty set
and `search()` returns `[]` on empty — the whole pipeline would return zero
hits. `matchJurisdiction()` tries exact id/code/citation-string first, then
a court-NAME match plus subtree walk, and returns null (→ unfiltered) when
nothing matches. Lost recall is safer than zero results; the verifier still
gates every citation either way.

## Known limitation (not fixed here)

The `courts` hierarchy is incomplete (`courthouses` never ingested,
`courts.level` never populated — Phase 2 items), so a subtree walk may
under-cover a forum (e.g. `cal` walks to itself only). The filter is
therefore a precision aid, not a recall guarantee.

## Verification

`app/lib/retrieval/search.test.ts` — exact-id, name-fallback+subtree,
null-fallback, LIKE-escape cases.
