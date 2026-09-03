# ADR-003 — Retrieval surfacing policies (status set + cited-by definition)

Date: 2026-09-03. Records two G1-era behaviors that shipped without an ADR
(Phase 1 audit P1-9) plus one Phase 3 correction.

## 1. Searchable status = Published ∪ Unknown

`search()` filters `precedential_status ∈ {Published, Unknown}` (772,539
Unknown opinions stay searchable). Decided at G1 kickoff: `Unknown` is a
sourcing artifact (Harvard/Lawbox rows without an editorial status), not a
quality signal — excluding it would silently drop ~7% of the corpus.
Lookup (`resolveCluster`) enforces only `blocked = 0`, not status: a direct
citation lookup must never fail on status grounds. The asymmetry is
deliberate (filter browsing, never exact lookup).

## 2. cited_by = direct, unblocked citers only

`resolveCluster` counts `DISTINCT citing_id` where the edge is direct
(`cites.depth = 1`, or `NULL` for anchor-only in-text mentions, which are
direct by construction) and the citing opinion is not de-indexed
(`blocked = 0`). Transitive depth > 1 edges previously inflated the count
with cases that never cited the target. Same-case (cluster) citers still
count — a citation is a citation.

## Verification

Status set: `evals/golden/golden.json` jur-* cases + G1 baseline.
cited_by: `app/lib/verify/core.test.ts` ("excludes transitive and
de-indexed citers").
