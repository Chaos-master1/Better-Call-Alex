# G5 — Case files, drafting, DOCX export

Status: **PASS**, verified live 2026-09-03.
Evidence: `logs/g5-report.json`, `logs/g5-motion.docx`.

## What was built

### Exporter — `app/lib/export_docx.ts`

Two layers, matching the repo's pure-core / thin-shell split:

- `planMotionParagraphs(drafted)` — pure, corpus-free planner. Every draft
  sentence becomes its own block (the G5 "line breaks survive" criterion is
  met with real OOXML paragraphs, never `\n` inside a run — asserted by
  test); unverified sentences are kept and flagged, never dropped (§3);
  the §11 banner leads in code.
- `buildMotionDocx(drafted)` — thin `docx` serialization (the
  canon-confirmed G5 tool). Verified sentences plain, unverified
  struck-through + `UNVERIFIED` suffix (mirrors the UI), inferred italic
  (§5.5). Omitted attrs (not `false`): the serializer otherwise emits
  explicit `w:val="false"` noise on every run.

### Resolve gate — `app/app/api/cases/[id]/export/route.ts`

The G5 criterion ("every citation in the exported file resolves") is
enforced in code, fail-closed: appendix citations + sentence pins are
re-resolved (pin stripped, case parse → `resolveCluster`, statute parse →
`resolveStatute`) before any bytes are built. Unresolvable → **409** naming
the offenders, zero side effects. Then: build → `documents` row
(`kind='motion'`, plain-text body) → `audit_log drafter.export` → stream
with `Content-Disposition: attachment`.

### UI + runner

- `Export .docx` button beside `Copy draft` in the Result header; a 409
  refusal renders inline (e.g. the fabricated cite, listed).
- `evals/run_g5.ts` (`pnpm g5`) runs the same gate offline and writes
  `logs/g5-motion.docx`.

## Verification (all live, this tree)

- Demo motion: case 32 (G3 live run, regulatory taking) — 4/4 citations
  resolve, 28-paragraph `.docx` with banner + appendix intact.
- HTTP: 200 + correct content-type/disposition for case 32; documents +
  audit rows persisted; 404 for caseless id; **409 for a fabricated
  `494 U.S. 560`** (real Muniz cite is 496 U.S. 582) with no leaked rows;
  scratch case deleted after.
- Regressions: 67/67 unit, G2 9/9, G3 offline PASS, tsc + next build clean.

## Known limitations (honest list)

- DOCX only — no PDF path (see scope notes in `logs/g5-report.json`).
- Drafts carrying an unresolvable citation cannot export at all (409);
  fix the draft (new run), don't work around the gate.
