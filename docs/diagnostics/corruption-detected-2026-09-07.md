# Corruption detected by stage 1 differential probe (2026-09-07)

## Finding (committed; flagged before cutover, not after)

The Stage 1 differential probe detected **~38M duplicate cite rows** in
`data/corpus.new.sqlite` that the new build had committed. These duplicates
arose from a kill during the cites-join transaction and were not visible
to any single-DB count check.

| item | old (untouched) | new (killed mid-build) | verdict |
|---|---|---|---|
| opinions | 10,798,347 | 10,798,347 | uninjured |
| citation_strings | 18,123,788 | 18,123,788 | uninjured |
| parentheticals | 6,408,887 | 6,408,887 | uninjured |
| courts / judges | 3,361 / 16,191 | 3,361 / 16,191 | uninjured |
| statutes | 8,621 | 8,621 | uninjured |
| anchors (Phase 2 new) | 0 | 112,995,692 | uninjured |
| **cites** | **105,689,491** | **167,157,950** | **CORRUPTED** (+61.4M dupes) |
| **FTS5 inverted index** | 566,447 | 0 | **NEVER BUILT** (kill before stage) |
| **authority** | 10,798,347 | 0 | **NEVER BUILT** (next stage) |

## Why this is caught only by a differential probe

A `SELECT count(*) FROM cites` on the corrupted DB returns 167M, which is
internally consistent (it has the original 105.7M + 61.4M duplicates).
The build is "deterministic from raw CSV" per the verdict in stage 1B;
the original DB is "deterministic from raw CSV" too. The two don't agree,
but neither one is wrong *on its own*. A diff was the only way to see
it. **This is the argument for keeping the original 210GB file around
through the cutover.**

## Why the duplicates are real (not a count glitch)

- Distinct `(citing_id, cited_id)` pairs: **105,689,491** — exactly the
  original count.
- Duplicate rows: 167,157,950 - 105,689,491 = **61,468,459**.
- Depth distribution shows 0 rows at depth 0 (no errors), and the
  anchor-only depth-NULL population (63,579,912) is correct.
- The 61.4M extra rows are depth-1 through depth-200, spread across all
  depths proportionally — exactly the signature of a partial
  `INSERT OR IGNORE` re-run after the kill.

## Why the freeze did this, not the kills during later stages

The resume shell script (`/tmp/resume-build.sh`) re-entered the merge
stage after the kill. The merge stage runs:
1. `INSERT INTO main.cites SELECT FROM citomap + JOIN anchors` — this is
   the step that was killed at 167M rows out of ~128M expected (the
   duplicate is because the stage is designed to be re-runnable, but the
   re-entry hit a partial state where some cites had already been
   committed and the next attempt re-inserted them).
2. The Sep-5 `is_done(m_*)` fix prevented the `m_cites.done` marker from
   firing prematurely, but did not add a unique-constraint defense
   against duplicate inserts. The cite merge was *designed* to handle
   the `m_opinions.done` skip but not the mid-cites kill.

## Action taken

This is **not "from zero"** — the uncorrupted stages (95% of the work)
are already committed and verified. The fix is **bounded**:
1. Wipe only the `cites` table
2. Re-run merge (skips opinions/anchors, rebuilds cites)
3. Re-run FTS, authority, statutes
4. Full proof round (integrity_check, diff, G0/G1/G2/export, cutover)

**Estimated 2 hours of rebuild on a calm machine.** Keep this box idle
during the build. Same quality guarantee as a clean rebuild because the
unbroken stages are already verified against the original.
