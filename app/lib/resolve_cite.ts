/**
 * Shared citation-resolution gate (G5). One implementation used by both the
 * export route and evals/run_g5.ts — the pre-dedup copies had already
 * drifted apart, and a gate that exists twice is a gate that rots.
 *
 * Two entry points:
 *   resolvesCitation(db, cite) — pin-stripped case resolve, else full-form
 *     statute resolve. False = unresolvable in this corpus.
 *   collectExportCandidates(drafted) — every citation string the .docx will
 *     contain: authority appendix + sentence pin cites + inline cites mined
 *     from the IRAC, counter-argument, and caveat free text. The G5 gate is
 *     "every citation in the exported file resolves", not "every citation
 *     in two of its sections".
 */
import type Database from "better-sqlite3";
import { resolveCluster } from "./db.js";
import { parseCitation } from "./citation.js";
import {
  parseStatuteCites,
  resolveStatute,
  statuteTableExists,
} from "./statute.js";
import type { DraftDoc } from "./draft.js";

/** Strip a pin page ("456 U.S. 798, 800" → "456 U.S. 798") then resolve as
 *  a case cite first, a full-form statute cite second. */
export function resolvesCitation(db: Database.Database, cite: string): boolean {
  const base = cite.split(",")[0].trim();
  const parsed = parseCitation(base);
  if (parsed && resolveCluster(db, parsed.volume, parsed.reporter, parsed.page)) {
    return true;
  }
  if (statuteTableExists(db)) {
    for (const s of parseStatuteCites(cite)) {
      if (resolveStatute(db, s.source, s.title, s.section)) return true;
    }
  }
  return false;
}

/** Global full-form case cites in free text. The reporter must contain a
 *  period ("U.S.", "F.2d", "S. Ct.") — that single rule rejects the common
 *  false positives (dollar amounts, acreage, "500 lots covering 20 acres")
 *  without a stoplist. Each hit is re-validated through parseCitation, so
 *  the extractor can never emit a form the resolver would not accept. */
const INLINE_CASE_RE =
  /\b(\d{1,4})\s+([A-Z][A-Za-z.']*(?:\s+[A-Za-z.']+){0,4}?)\s+(\d{1,6})\b/g;

export function extractCaseCites(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(INLINE_CASE_RE)) {
    if (!m[2].includes(".")) continue;
    const candidate = `${m[1]} ${m[2].trim()} ${m[3]}`;
    if (parseCitation(candidate)) out.push(candidate);
  }
  return [...new Set(out)];
}

/** Every citation string the exported .docx will contain. */
export function collectExportCandidates(drafted: DraftDoc): string[] {
  const candidates = new Set<string>();
  for (const a of drafted.authority_appendix ?? []) {
    if (a.citation) candidates.add(a.citation);
  }
  for (const s of drafted.sentences ?? []) {
    if (s.pin_cite) candidates.add(s.pin_cite);
  }
  const freeText = [
    ...Object.values(drafted.irac ?? {}),
    drafted.adversary?.counter_argument ?? "",
    ...(drafted.adversary?.treatment_caveats ?? []),
  ];
  for (const t of freeText) {
    if (typeof t !== "string") continue;
    for (const c of extractCaseCites(t)) candidates.add(c);
    for (const s of parseStatuteCites(t)) candidates.add(s.text);
  }
  return [...candidates];
}
