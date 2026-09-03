# Better Call Alex

A local US case-law research and litigation-strategy workbench. Every assertion
it produces is traceable to a verbatim quote in a real opinion, and every cited
case carries a treatment signal computed from the citation graph.

**The one invariant: nothing reaches the user that cannot be verified against the
corpus.** Hallucinated citations are the reason lawyers don't trust legal AI.
A system that structurally cannot emit one is the product.

Runs entirely on one machine. No cloud inference, no telemetry, no subscription.

---

## 1. Locked decisions

These were settled deliberately. Do not re-litigate them without an eval case
that forces the change (see §3).

| Decision | Why |
|---|---|
| **US jurisdictions only** for v1 | The 418 GB CourtListener corpus is the only defensible asset here. It is US-only. Other jurisdictions come after this one works. |
| **Local inference only** (Ollama) | Privileged client material never leaves the machine. Cloud is a later opt-in behind one seam (`app/lib/llm.ts`), not a rewrite. |
| **SQLite, one file, no servers** | Benchmarked: FTS5 ingests real opinions at 15.28 MB/s/core, 1.48× text on disk, 3–7 ms queries. Replaces Qdrant + Neo4j + Postgres + Redis + Langfuse + turbovec + the embedding pipeline. |
| **No embeddings in v1** | BM25 over opinion text plus BM25 over judge-written parentheticals is strong for legal queries, which are terminology-heavy. Costs zero GPU-hours. Upgrade path is pre-computed (§5). |
| **Four agents** | The 27 "agents" in the old plans are sections of two prompts, not services. Their prompt text is salvaged into `docs/prompts/`. |
| **Clean repo** | Two prior codebases (8,046 LOC Next.js with one squashed commit; 14,690 LOC Python with no git) never touched the corpus. Content salvaged, code not. |

Deferred, not rejected: multi-tenancy, billing, beta gates, i18n. Nothing in the
data model precludes them.

---

## 2. The change rule

This project previously accumulated ten plan documents (v1 → v7, ~17,400 lines)
across three months, growing from 11 agents to 27 plus 5 "engines", and never
completed its second build phase under any of them. Four documents each claimed
to be canonical. That was a process failure, not a code failure.

> **No new agent, engine, service, dependency, or model without a failing eval
> case that it fixes, named in the change.**
>
> **No additive plan documents.** This file is the canon and is edited in place.
> Reversals go in `docs/decisions/` as one ADR each, so the history stays legible.
>
> **Anything in §11 stays cut** unless an eval reopens it.

If a proposed addition cannot name the eval case it fixes, it is speculation.
Skip it.

---

## 3. Architecture

Two runtimes, one repo. **Python is ETL-only and runs once. TypeScript is
everything at runtime.** No service mesh, no daemons, no docker-compose.

### Storage

`data/corpus.sqlite` — read-only, ~170 GB, built once by `etl/`:

```sql
opinions(id PK, cluster_id, court_id, date_filed, case_name, case_name_short,
         precedential_status, citation_count, author_id, author_str, type,
         page_count, ocr, text)
opinions_fts        -- FTS5(text, content='opinions', content_rowid='id',
                    --      tokenize='porter unicode61')
cites(citing_id, cited_id, depth, char_pos, context)          -- ~132 M rows
citation_strings(cluster_id, volume, reporter, page, type)     -- "410 U.S. 113"
parentheticals(described_id, describing_id, text, score)
parentheticals_fts  -- FTS5
courts(id PK, name, jurisdiction, citation_string, parent_id)
# no `level`: designed, never populated, nothing reads it (removed Phase 2
# rather than filled with invented values; the walk uses parent_id)
judges(id PK, name_first, name_last, fjc_id)
statutes(source, title, section, heading, text, effective_date)      -- G4
authority(opinion_id PK, pagerank, recent_cites_2y, treatment_flags) -- batch
```

`data/app.sqlite` — read-write: `cases`, `documents`, `messages`, `runs`,
`audit_log`.

`audit_log` is append-only, enforced by triggers that reject UPDATE and DELETE —
not by convention.

Node 22's built-in `node:sqlite` is experimental — and on some builds it is
compiled without the FTS5 extension, which this design depends on twice. Use
`better-sqlite3`. ATTACH both files; open the corpus read-only.

### Retrieval

1. Parse the query for citations. If one is present, resolve it exactly through
   `citation_strings` and return that case. Citation lookup is never a search.
2. BM25 over `opinions_fts`, filtered by `court_id ∈ jurisdiction` and
   `precedential_status = 'Published'`.
3. BM25 over `parentheticals_fts` in parallel. These are judge-written "(holding
   that…)" summaries of other cases — a small, very high-precision index. This is
   the highest-value retrieval asset in the corpus.
4. Re-score: `bm25 × authority(pagerank, recency, scotus boost, parenthetical hits)`.
5. Return **passages with character offsets**, never whole opinions. Offsets are
   what make every citation pin, and they keep the local model inside 32k context.

### The Verifier

Pure code. No LLM. This is the component that must never regress.

Given generated text:

- Extract every citation with `eyecite` (the parser CourtListener itself runs)
  → resolve against `citation_strings`. **Unresolved → reject.** `eyecite` is
  Python; it runs as a subprocess per verification (~100 ms startup, nothing at
  this volume). A TS port (`eyecite-ts`) may replace it only if it matches real
  eyecite 100% on the G2 gold set. [ADR-001]
- Extract every quoted span → match against the cited opinion's `text`.
  **No match → reject.**
- Attach treatment from `cites`: cited-by count, plus a negative-language scan of
  the citing contexts ("overrule", "abrogat", "distinguish", "but see",
  "declined to follow"; extended with the overruling family — "disapprov",
  "supersed", "depart from", "no longer good law" — measured against the
  Casetext/LegalBench Overruling split: recall .525 → .774 at FPR ≤ .014).
- Emit a verification report. The UI renders unverifiable sentences **struck
  through**, never silently dropped — the user must see what failed.

The adversarial case that citation-existence checks structurally miss is a *real
case with an invented quote*, and a *real quote attributed to the wrong case*.
Both are covered by the quote-match step. Test both.

### Agents

| # | Role | Model | Output |
|---|---|---|---|
| 1 | Intake | `qwen3.5:9b` | Facts → structured JSON. `UNVERIFIED` for anything not stated. |
| 2 | Researcher | `qwen3.5:9b` | Three retrieval queries; runs retrieval; ranks results. |
| 3 | Analyst | `qwen3:14b` | IRAC with pin cites + element checklist. |
| 4 | Adversary | `qwen3:14b` | Strongest counter-argument plus retrieved counter-authority. |

Then the Verifier gates the output, and the Drafter is a template plus one call.

The Adversary is the feature nobody else ships: "here is the best case against
you," retrieved rather than invented.

### Model and VRAM rules — 12 GB is the hard constraint

- `qwen3.5:9b` (6.6 GB) is the resident workhorse at 32k context.
- Swap to `qwen3:14b` (9.3 GB) **once**, for the Analyst + Adversary pass,
  batched so a run costs at most two swaps.
- Set `OLLAMA_KV_CACHE_TYPE=q8_0`.
- **Never set `OLLAMA_NUM_CTX=2048`.** The previous Python build shipped that
  against payloads containing full IRAC trees; every downstream agent was reading
  truncated input and nobody noticed. Assert the effective context at startup.
- Verify a model tag exists with `ollama list` before writing it into config. A
  previous build lost weeks to `gemma4:12b`, which does not exist.
- All model selection goes through `app/lib/llm.ts`. Adding a cloud provider is a
  config change there and nowhere else.

---

## 4. Data facts

Everything in this section is measured, not assumed. It exists to prevent the
expensive mistakes.

### The CSV escape trap

CourtListener bulk CSVs are written with Postgres
`COPY … WITH (FORMAT csv, ENCODING utf8, ESCAPE '\', HEADER)` —
**backslash-escaped quotes, not RFC-4180 doubled quotes.**

Default parsers (`csv`, pandas, DuckDB) mis-read them. A first pass over 900 MB
yielded 335 rows. The correct config yielded 13,966 with one misaligned:

```python
csv.field_size_limit(10**9)              # single fields exceed 1 MB
csv.reader(f, doublequote=False, escapechar='\\')
```

When starting mid-file (sharded ETL), **resync to a real record boundary** by
scanning for `^"\d+","\d{4}-`. A shifted row can still have exactly 22 fields and
will silently write garbage into every column. Guard every `int()` parse.

### The text is not in `plain_text`

Byte share of `opinions.csv`, measured over 13,966 correctly parsed rows:

| column | share |
|---|---|
| `html_with_citations` | 51.0% |
| `html_anon_2020` | 42.4% |
| `plain_text` | **3.4%** |
| everything else | ~3% |

`plain_text` is **empty for 92% of rows** at the head of the file and **57%** at
the middle. All of those are recoverable. COALESCE in this order, then strip
markup and unescape entities:

```
plain_text → html_with_citations → html_anon_2020 → xml_harvard
           → html_lawbox → html → html_columbia → xml_scan
```

Selecting `plain_text` alone silently drops most of the corpus.

### Corpus scale

Sampled at six byte offsets across `opinions-2026-06-30.csv` (349.7 GB):

| offset | rows/MB | usable text share |
|---|---|---|
| 0 | 16.1 | 31.4% |
| 60 GB | 17.5 | 29.7% |
| 130 GB | 33.1 | 35.5% |
| 200 GB | 37.1 | 33.7% |
| 270 GB | 20.9 | 28.1% |
| 315 GB | 78.8 | 39.1% |

→ **~11.3 M opinions, ~115 GB of usable text.** Density varies 5× across the
file, so **shard the ETL by byte range, not row count**, and make it resumable.

`opinion-clusters-2026-06-30.csv` (12.05 GB) → ~10.8 M clusters. Ratio ≈ 1.02,
consistent with most clusters holding one opinion.

~95% of opinions are `precedential_status = 'Published'`.

### `html_with_citations` already contains the citation graph

```html
<a href="/opinion/1184769/mcguffey-v-turner/"
   aria-description="Citation for case: McGuffey v. Turner">18 Utah 2d 354</a>
<a href="/opinion/486398/ramon-chaparro-v-otis-r-bowen/#1011" …>
```

Present on **82.2%** of opinions, averaging **12.0 links each** → ~132 M edges.
Each gives the target opinion id, the case name, the citation string as anchor
text, and `#1011` star-page pin-cite anchors. Extract with
`<a[^>]*href="/opinion/(\d+)/`, and keep `m.start()` as `char_pos` — the text
around that position is the citing sentence, which is where treatment language
lives.

Use `citation-map` (the authoritative file) as the primary source and these
anchors to add in-text position and cover overlaps; the 18% without anchors come
from `citation-map` alone.

### Files required and not yet on disk

All free, from `https://storage.courtlistener.com/bulk-data/`, same `2026-06-30`
snapshot. ~6 GB total.

| File | bz2 | Why |
|---|---|---|
| `dockets-2026-06-30.csv.bz2` | 4.7 GB | **Hard blocker.** There is no `court_id` anywhere in `opinions` or `opinion-clusters`; clusters carry only `docket_id`. Without this there is no jurisdiction, circuit, or federal-vs-state filter at all. |
| `citation-map-2026-06-30.csv.bz2` | 502 MB | `search_opinionscited(cited_opinion_id, citing_opinion_id, depth)` — the citator. |
| `citations-2026-06-30.csv.bz2` | 121 MB | `search_citation(volume, reporter, page, cluster_id)`. Nothing on disk contains the string "410 U.S. 113". |
| `parentheticals-2026-06-30.csv.bz2` | 275 MB | Judge-written holdings. Drives retrieval step 3. |
| `courts-` (+ `people-db-*`, `schema-*.sql`) | 0.1 MB | Jurisdiction hierarchy (`courthouses-` exists upstream but no stage reads it — deliberately not fetched). |
| `people-db-*` | ~2 MB | Judges. `opinions.author_id` is currently a dangling FK. |
| `schema-2026-06-30.sql` | 0.47 MB | Authoritative column definitions. |
| `fjc-integrated-database-` | 267 MB | Optional. Federal outcome base rates. |

**Statutes and regulations are absent from CourtListener entirely.** Verified
live: the eCFR API (`https://www.ecfr.gov/api/versioner/v1/titles.json`) responds
and is current; govinfo bulkdata `CFR` and `USCOURTS` endpoints return 200; US
Code comes from `uscode.house.gov` release points. This is G4.

### Dense retrieval upgrade path (do not build until an eval demands it)

CourtListener publishes pre-computed, legal-fine-tuned ModernBERT embeddings, one
JSON per opinion id, on a public bucket:

```
s3://com-courtlistener-storage/embeddings/opinions/freelawproject/modernbert-embed-base_finetune_512/{opinion_id}.json
```

~2 TB in total but fetchable per id, so a filtered subset costs a fraction — and
no local GPU embedding run is ever required.

### Licensing

CourtListener bulk data is Public Domain Mark 1.0. Free Law Project–authored
*content* (parentheticals, headnotes) is CC BY-ND: attribute, do not remix.

---

## 5. Invariants

Regression in any of these is a release blocker.

1. No citation reaches the UI without resolving through `citation_strings`.
2. No quoted span reaches the UI without matching the cited opinion's text.
3. Every claim carries `[RECORD]`, `[LAW]`, or `[INFERRED]`. **Enforced by a code
   gate, not a prompt instruction.** Untagged claims are rejected.
4. Every number carries a basis label. No dollar figure is presented as observed
   when it is heuristic.
5. Treatment is labelled *inferred*. Never state "overruled" as fact — there is
   no editorial citator behind it.
6. `audit_log` is append-only, trigger-enforced.
7. Deterministic things are computed, never inferred: dates, deadlines, statutes
   of limitations, arithmetic. A date subtraction is never an LLM call.
8. Ship only what the data supports. If a feature's data is partial, it is
   labelled `LOW_CONFIDENCE`; if absent, the feature does not ship.

---

## 6. Repo map

```
CLAUDE.md              this file — the canon
docs/
  data-pipeline.md     ETL detail
  retrieval.md         scoring, filters, offsets
  verifier.md          the contract and its adversarial cases
  g4-statutes.md       statutes ingestion + calculators + gate evidence
  decisions/           one ADR per reversal
etl/                   Python 3.12 via uv — runs once, never in production
  build_corpus.py      sharded by byte range, resumable
  build_authority.py   pagerank, recency, treatment flags — power iteration on
                       scipy.sparse CSR (~132 M edges; NetworkX will not hold)
  statutes.py          eCFR (live) + US Code release points (G4)
  audit_g0.py          the G0 audit harness
  tests/
verifier/              G2 runtime Python: eyecite subprocess bridge (ADR-001),
                       fixture generator + golden set, treatment-recall
                       measurement against the LegalBench overruling split
app/                   Next.js + TypeScript
  cli.ts               alex lookup / search / run
  lib/db.ts  lib/statute.ts (G4)  lib/llm.ts  lib/app_db.ts
  lib/retrieval/  lib/verify/ (core.ts + sync/async bridges)  lib/agents/
  lib/calc/  lib/draft.ts  lib/render.ts
  app/                 routes, page, error boundary
evals/                 golden sets + runners (retrieval p@10, latency, G2
                       fixtures, G3 five-pattern harness with --offline mode)
data/                  corpus.sqlite, app.sqlite — gitignored
logs/                  committed run evidence: g3-report.json, g4-report.json,
                       g4-statutes-spotcheck.json, g5-report.json,
                       g5-motion.docx, audit/*.json
```

Python 3.14 has thin ML wheel coverage. Pin a 3.12 venv with `uv`.

---

## 7. Commands

```bash
# corpus (once)
uv run etl/download.py                 # ~6 GB of missing bulk files
uv run etl/build_corpus.py --shards 12 # overnight; resumable by byte range
uv run etl/build_authority.py

# checks
uv run etl/tests/                      # ETL invariants
alex lookup "410 U.S. 113"             # citation resolution
alex search "qualified immunity clearly established"

# app
pnpm dev
pnpm eval                              # golden sets; compares to stored baseline
pnpm test
```

---

## 8. Build gates

No gate begins before the previous one's verification passes.

| Gate | Deliverable | Verification |
|---|---|---|
| **G0** | Repo, this file, downloads, `corpus.sqlite` (opinions + FTS5 + cites + citation_strings + courts + parentheticals + judges) | `alex lookup "410 U.S. 113"` returns Roe v. Wade with court, date, cited-by count. Row counts within 10% of ~11.3 M. 20 hand-checked opinions have non-empty text and correct `court_id`. **Report the `clusters.docket_id → dockets.court_id` join coverage before building anything on top of it.** |
| **G1** | Retrieval + `alex search`: BM25 × authority × parentheticals, passages with offsets | A 30-query hand-built golden set (doctrine, citation lookup, fact pattern, jurisdiction filter) plus LegalBench-RAG (6,858 expert-annotated query/span pairs) for retrieval plumbing — its corpus is contracts, not case law, so the hand-built set is the real quality measure. Record precision@10 — this is the baseline every later change is measured against. p95 latency < 500 ms. |
| **G2** | **The Verifier** | Adversarial fixtures: fabricated citations, real case / invented quote, real quote / wrong case, one-word-altered quotes, correct cites to overruled cases. **100% catch rate on fabrications is the gate.** Treatment-scan recall checked against `casehold` (2,400 attorney-annotated overruling-vs-nonoverruling sentences). Unit tests, no LLM. |
| **G3** | The four agents + UI. The 60-second demo. | Five real fact patterns end to end. Every sentence either carries a resolving pin cite or is visibly struck through. The Adversary returns real opposing authority. Nothing reaches the UI ungated by G2. |
| **G4** — **COMPLETE** (2026-09-02, one environment-conditional item) | Statutes (eCFR + US Code) + deterministic calculators | 20/20 sections spot-checked against the live eCFR API (`logs/g4-statutes-spotcheck.json`); 8,621 eCFR sections loaded; calculator tests 36/36 (leap years, cross-year weekend/holiday rolls, tolling fixed-point). US Code adapter + parser are fixture-tested but not live-loaded — uscode.house.gov is unreachable from the dev network. Evidence: `logs/g4-report.json`, `docs/g4-statutes.md`. |
| **G5** — **COMPLETE** (2026-09-03) | Case files, drafting, DOCX export | Motion end to end on case 32 (G3 live run): 4/4 citations resolve through the export gate; 28-paragraph `.docx` with banner + appendix; HTTP 200 with documents + audit rows persisted; fabricated `494 U.S. 560` refused 409 with zero side effects. DOCX only — no PDF path (react-pdf silently ignores `whiteSpace: pre-wrap`; no eval demands a second format). Evidence: `logs/g5-report.json`, `logs/g5-motion.docx`, `docs/g5-export.md`. |

G2 precedes G3 deliberately. Without a proven Verifier, the agents are just
another hallucination surface.

---

## 9. Honest limitations

State these in the product, not just here.

1. Local 9B/14B legal reasoning is weaker than frontier models. The
   retrieval-heavy, verification-gated design compensates; it does not eliminate
   the gap. The model assembles verified quotes rather than reasoning from
   memory — which is why a weaker model costs less here than it would elsewhere.
2. **No verdict or settlement ground truth exists for free.** Any dollar figure
   is heuristic and must say so. Three prior plan versions ignored this after
   their own data reference stated it flatly.
3. **No editorial citator.** Treatment is inferred from citing language.
4. RECAP covers roughly 30–40% of federal filings; full PACER history costs
   $2,000–5,000 per judge. Docket-level features are gated on that.
5. Cluster editorial fields (`syllabus`, `headnotes`, `summary`, `posture`,
   `procedural_history`, `disposition`) are populated on a small minority —
   Harvard/Lawbox-sourced only. Do not build a feature that assumes them.
6. `extracted_by_ocr = 't'` opinions have degraded text. Down-weight them.
7. Honor `blocked` / `date_blocked` on clusters — those are de-indexing requests.
8. The corpus DB is ~170 GB. If that becomes a constraint, store zstd-compressed
   text with FTS5 contentless indexing (~70 GB). An optimization, not v1.

---

## 10. Cut, and staying cut

Each of these was proposed in a prior plan version. None ships without an eval
case that reopens it (§2).

| Cut | Reason |
|---|---|
| **Lex-Z3 theorem prover** | Its own reference implementation is `And(signed, delivered, Not(paid))` with every value asserted — that is boolean evaluation, not proof. An element checklist gives the same answer honestly. Genuine constraint solving would be deadline/tolling arithmetic, which is the deterministic calculator and needs no solver. |
| **Kinematic Spatial Engine** | NeRF reconstruction plus Blender raycasting to produce findings its own spec forbids from appearing in any filing. Daubert exposure. A separate company. |
| **Deposition Biometric Decoder** | Contested science. Its own spec writes a code-level ban on every external use. A feature whose every use is prohibited. |
| **Litigation-Alpha MCTS** | AlphaGo works because Go has a ground-truth terminal reward. Litigation has none until outcomes accrue, and the spec concedes the value network "starts out miscalibrated". |
| **Juris-LoRA per-judge twins** | Retrieval over that judge's own opinions gets ~90% of it at zero training cost. |
| **DeLP / ASPIC+ / LTLf / Carneades / CFR / AB-MCTS** | Proposed for a Z3 module that never ran once. Each is a PhD. |
| **turbovec** | Unverified package, unsourced benchmarks. This project already lost weeks to a model tag that did not exist. |
| **Qdrant, Neo4j, Redis, Langfuse, Postgres** | One SQLite file does all of it, benchmarked. Neo4j alone cost 2.5 GB of a 16 GB budget for queries that are joins. |
| **Five-model per-agent routing** | 12 GB VRAM holds one model. Every route change is a 9 GB swap. |
| **23 of the 27 agents** | They are sections of two prompts, not services. Their text is salvaged into `docs/prompts/`. |
| **Council Mode, Reflexion, 3× multi-shot, the 7-stage adversarial loop** | Four un-benchmarked ensembling mechanisms stacked on one another. |
| **The 11-phase roadmap** | Rewritten in every version; never once reached its second phase. |

---

## 11. Not legal advice

Alex produces attorney work product in draft. It does not practice law.

Every generated document carries
`DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE`, applied at the render and
export layer in code, not by prompt instruction. Every response surfaces its
verification state. The system says "no authority found in the corpus" — never
"no authority exists."

---

## 12. Tooling — confirmed and deferred

Confirmed (verified against the ecosystem, not assumed):

| Tool | Use | Verified |
|---|---|---|
| `better-sqlite3` | Storage | Canonical, MIT, actively maintained. Node's built-in `node:sqlite` additionally lacks FTS5 on some builds — a harder blocker than "experimental". |
| `eyecite` | Verifier citation extraction | Canonical Free Law Project parser; the repo `freelawproject/eyecite` is confirmed. Python-only; runs as a subprocess per verification (see §3, ADR-001). |
| `ollama-js` | `app/lib/llm.ts` client | Official TypeScript client. |
| `qwen3.5:9b` / `qwen3:14b` | Models | Both exist on the Ollama registry at 6.6 / 9.3 GB, matching the VRAM math exactly. `qwen3:14b`'s native context is 40k, not 256k — irrelevant at our 32k cap. |
| `docx` | G5 export | Declarative .docx generation, right fit for drafting motions from scratch. |

Deferred, no failing eval case (per §2 — do not pull in):

| Tool | Why deferred |
|---|---|
| `inception` | Only serves the deferred dense-embedding path (§5). |
| `doctor` | Persistent microservice, conflicts with "no daemons"; revisit only if G5 needs PDF/DOCX intake. |
| `us-legal-tools` / `uscode` parsers | Decided at G4: hand-rolled parsers in `etl/statutes.py` (stdlib + defusedxml); no dependency needed. |
| `courts-db` / `reporters-db` | Redundant with the `courts` + `citations` CSVs we already download; revisit only if an eval shows resolution gaps. |
| `sqlite-zstd` | The deferred compression path (§9.8). |
| DuckDB for ingestion | Possible bench for CSV parse speed only; SQLite remains the store. |

G2 eval resources: `casehold` (2,400 attorney-annotated overruling sentences) for
treatment-scan recall; LegalBench-RAG (contracts corpus) validates retrieval
*plumbing* only — the hand-built golden set is the real quality measure.
