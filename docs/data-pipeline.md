# Data pipeline (G0) — BUILT AND VERIFIED

Everything here is measured against the `2026-06-30` CourtListener snapshot on
this machine. Canon: `CLAUDE.md` §3–§4.

## Result (measured 2026-08-22)

| table | rows |
|---|---|
| opinions | **10,798,347** (95.6% of the ~11.3M estimate — within gate ±10%) |
| cites | **105,689,491** (77.5M from citation-map + ~28M anchor-only; 51.5M with char_pos+context) |
| citation_strings | 18,123,788 |
| parentheticals | 6,408,887 (+ FTS5) |
| courts / judges | 3,361 / 16,191 |
| dockets→court join coverage | **100.00%** (10,070,727/10,070,727 clusters) |

`corpus.sqlite` = 210.8 GB. Build time: prep stages ~35 min, 12 shards ~73 min,
merge (opinions + cites + FTS5 rebuild + indexes) ~8 h wall.
Gate suite: `uv run python etl/tests/test_g0.py` — 7/7 pass, including
`alex lookup "410 U.S. 113"` → Roe v. Wade, scotus, 1973-01-22, cited_by 5,575
(cluster-level distinct citing opinions).

## Source layout

```
data/raw/opinions-2026-06-30.csv        349,716,707,859 bytes  (~11.3 M rows)
data/raw/opinion-clusters-2026-06-30.csv       ~12 GB         (~10.8 M rows)
data/bulk/*.csv.bz2                     dockets, citation-map, citations,
                                        parentheticals, courts, courthouses,
                                        people-db-people, schema.sql
```

## CSV dialect — the escape trap

Postgres `COPY … (FORMAT csv, ESCAPE '\')`. Backslash-escaped quotes, not
RFC-4180. Every reader must use:

```python
csv.reader(f, doublequote=False, escapechar="\\")
csv.field_size_limit(10**9)
```

## Sharding by byte range

Records span multiple physical lines (embedded newlines inside quoted text), so
shards are cut by byte offset and resynchronized to a record boundary with
`^"\d+","\d{4}-` (`etl/build_corpus.py::find_resync`). Each shard validates
every row: parsed id must equal the leading integer of its first physical line;
>50 consecutive mismatches aborts the worker instead of silently writing
garbage.

## Text extraction

COALESCE order per CLAUDE.md §4:
`plain_text → html_with_citations → html_anon_2020 → xml_harvard → html_lawbox
→ html → html_columbia → xml_scan`, then strip markup, unescape entities,
collapse whitespace.

`html_with_citations` anchors (`<a href="/opinion/ID/…">cite</a>`) are captured
during cleaning; positions are mapped into cleaned-text coordinates so
`cites.char_pos` is exact against the stored `text`. Context window ±150 chars
stored alongside.

## Stages

| stage | reads | writes |
|---|---|---|
| `clusters-dockets` | dockets.bz2 | sidecar `.clusters.sqlite` docket→court map |
| `clusters-join` | clusters.csv | sidecar clusters table + `docs/g0-join-coverage.json` |
| `small` | courts/people/citations bz2 | corpus.sqlite courts, judges, citation_strings |
| `citormap` | citation-map.bz2 | staging citormap (~132 M edges) |
| `parentheticals` | parentheticals.bz2 | parentheticals + FTS5 rebuild |
| `shard --index N --total 12` | opinions.csv byte range | `.shards/shard_N.sqlite` |
| `merge` | shards + citormap + anchors | main opinions; cites = citormap ⟕ anchors; FTS5 rebuild; indexes |

All stages are idempotent via `.done` markers; a crashed stage reruns safely.
Shard workers write isolated DB files, then merge ATTACHes them — no writer
contention at any point.

## G0 verification

```bash
uv run python etl/tests/test_g0.py
pnpm --dir app alex lookup "410 U.S. 113"
```

Gate: row counts within 10 % of ~11.3 M; Roe resolves with court/date/cited-by;
20 hand-checked landmark opinions non-empty with correct court; join coverage
reported before anything builds on it.
