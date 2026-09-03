/**
 * Verifier integration (CLAUDE.md §3, §5). The agents produce
 * `tagged_sentences` with [RECORD] / [LAW] / [INFERRED] tags and
 * optional pin cites. The G2 Verifier checks every citation and every
 * quoted span against the corpus. This module joins the two:
 *
 *   1. Joins the agent sentences into a single draft text, with tags
 *      preserved as a sidecar array.
 *   2. Runs the G2 Verifier on the draft (async bridge for the server,
 *      sync bridge for the CLI/evals — both share one analysis core).
 *   3. Cross-references: each sentence that the verifier flags as
 *      `unresolved_citation` / `quote_not_found` / `quote_wrong_case` /
 *      `unattributed` is marked `verified: false`.
 *   4. Emits a final render struct that the UI consumes: per-sentence
 *      text + tag + verification status + pin cite. Sentences that fail
 *      verification are rendered struck-through; the user must see them
 *      (§3, §11 — never silently dropped).
 *
 * [RECORD] sentences hold the client's own facts (§5.3). Quotes inside
 * them are the user's words — a contract line, a text message — not
 * corpus claims, so their char ranges are passed to the verifier as
 * `skipQuoteRanges`: they are not checked, and quoting the client can
 * never fail an otherwise-clean draft. Citations inside [RECORD]
 * sentences are still resolved.
 *
 * The claim-tag gate (§5.3) is enforced HERE, not by prompt. If the
 * analyst returns a sentence that is not tagged, the gate rejects it.
 */
import { verifyText, type VerificationReport } from "./verify/verify.js";
import { verifyTextAsync } from "./verify/verify_async.js";
import type { AnalyzeOptions } from "./verify/core.js";
import type Database from "better-sqlite3";

export type ClaimTag = "RECORD" | "LAW" | "INFERRED";

export interface TaggedSentence {
  tag: ClaimTag;
  text: string;
  pin_cite?: string;
}

export interface VerifiedSentence {
  index: number;
  tag: ClaimTag;
  text: string;
  pin_cite?: string;
  /** True iff the verifier accepts every citation and quote in the sentence. */
  verified: boolean;
  /** Per-sentence detail: which citations/quotes were checked. */
  detail: string[];
  /** Always `true` for INFERRED — the §5.5 "never state as fact" rule. */
  inferred: boolean;
}

export interface RenderedDraft {
  /** Plain-text draft, the same string passed to the verifier. */
  draft: string;
  /** Per-sentence render array. */
  sentences: VerifiedSentence[];
  /** Full G2 report. */
  report: VerificationReport;
  /** Overall: pass iff every sentence verified AND every [LAW] sentence has a pin cite. */
  overall: "pass" | "fail";
}

/** §5.3 gate: every sentence MUST carry a known tag. Unknown or missing =
 *  reject. A truthiness check is not enough: an unknown tag would otherwise
 *  be emitted into the draft as "[FOO]" and bypass every tag-dependent rule. */
function gateTags(sentences: TaggedSentence[]): void {
  for (const [i, s] of sentences.entries()) {
    if (s.tag !== "RECORD" && s.tag !== "LAW" && s.tag !== "INFERRED") {
      throw new Error(`[verify] sentence ${i} has bad tag ${JSON.stringify((s as { tag?: unknown })?.tag)} (CLAUDE.md §5.3)`);
    }
  }
}

/** Content tokens for RECORD grounding: lowercase alphanumerics, len ≥ 2. */
function contentTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * RECORD confinement (P0-1 fix). The skipQuoteRanges exemption trusts the
 * sentence tag, and the tag comes from model JSON — so a model that labels
 * argued law as RECORD would launder quotes past the verifier. A RECORD
 * sentence must share substance with the intake facts; one that does not
 * is re-tagged INFERRED (labeled reasoning, never verified as fact, never
 * silently dropped). Non-RECORD sentences pass through untouched.
 * Returns the confined sentences plus the re-tag count for the audit log.
 */
export function confineRecordSentences(
  sentences: TaggedSentence[],
  intakeFacts: string
): { sentences: TaggedSentence[]; retagged: number } {
  const factTokens = new Set(contentTokens(intakeFacts));
  let retagged = 0;
  const out = sentences.map((s) => {
    if (s.tag !== "RECORD") return s;
    const toks = contentTokens(s.text);
    // Too short to judge: keep. Citations inside still resolve; a LAW
    // claim without a pin still fails at cross-reference.
    if (toks.length < 3) return s;
    const hit = toks.filter((t) => factTokens.has(t)).length;
    if (hit / toks.length >= 0.4) return s;
    retagged++;
    return { ...s, tag: "INFERRED" as const };
  });
  return { sentences: out, retagged };
}

/** Build the draft text. The pin cite rides as a parenthetical so eyecite
 *  can extract it; the renderer strips it back out. */
function buildDraft(sentences: TaggedSentence[]): string {
  return sentences
    .map((s) => `[${s.tag}] ${s.text}${s.pin_cite ? ` (${s.pin_cite})` : ""}`)
    .join(" ");
}

/**
 * Char ranges of the [RECORD] sentences in the draft, for the verifier's
 * `skipQuoteRanges`: quotes inside them are the client's own facts, not
 * corpus claims (§5.3).
 */
function recordCharRanges(
  draft: string,
  sentences: TaggedSentence[]
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const offsets = sentenceCharRanges(draft, sentences);
  for (const [i, s] of sentences.entries()) {
    if (s.tag === "RECORD") ranges.push(offsets[i]);
  }
  return ranges;
}

/** Cross-reference the verifier's report with the per-sentence char ranges. */
function crossReference(
  draft: string,
  sentences: TaggedSentence[],
  report: VerificationReport
): RenderedDraft {
  const offsets = sentenceCharRanges(draft, sentences);
  const bySentence: VerifiedSentence[] = sentences.map((s, i) => {
    const [a, b] = offsets[i];
    const cits = report.citations.filter((c) => c.cite_start >= a && c.cite_end <= b);
    const quotes = report.quotes.filter((q) => q.start >= a && q.end <= b);
    const detail: string[] = [];
    let verified = true;
    for (const c of cits) {
      detail.push(`cite '${c.citation_text}' → ${c.status}`);
      if (c.status !== "verified") verified = false;
    }
    for (const q of quotes) {
      detail.push(`quote '${q.quote.slice(0, 30)}…' → ${q.status}`);
      if (q.status !== "verified") verified = false;
    }
    // [LAW] without a pin cite cannot be verified. §5.3 + §5.1.
    if (s.tag === "LAW" && !s.pin_cite) {
      detail.push("LAW sentence without pin cite → unverified");
      verified = false;
    }
    return {
      index: i,
      tag: s.tag,
      text: s.text,
      pin_cite: s.pin_cite,
      verified,
      detail,
      inferred: s.tag === "INFERRED",
    };
  });
  const overall: "pass" | "fail" =
    report.overall === "pass" && bySentence.every((s) => s.verified)
      ? "pass"
      : "fail";
  return { draft, sentences: bySentence, report, overall };
}

/**
 * Async variant — does not block the event loop (preferred for the server).
 * `intakeFacts` grounds RECORD confinement; omit it only when the caller
 * has no intake (evals), in which case RECORD sentences pass unconfined.
 */
export async function verifyTaggedSentencesAsync(
  db: Database.Database,
  sentences: TaggedSentence[],
  intakeFacts?: string
): Promise<RenderedDraft> {
  gateTags(sentences);
  const confined =
    intakeFacts != null
      ? confineRecordSentences(sentences, intakeFacts).sentences
      : sentences;
  const draft = buildDraft(confined);
  const opts: AnalyzeOptions = { skipQuoteRanges: recordCharRanges(draft, confined) };
  const report = await verifyTextAsync(db, draft, opts);
  return crossReference(draft, confined, report);
}

/**
 * Stitch `tagged_sentences` into a single draft text and run the G2
 * Verifier over it (sync bridge). Returns the per-sentence render array
 * with the verifier verdict for each.
 */
export function verifyTaggedSentences(
  db: Database.Database,
  sentences: TaggedSentence[],
  intakeFacts?: string
): RenderedDraft {
  gateTags(sentences);
  const confined =
    intakeFacts != null
      ? confineRecordSentences(sentences, intakeFacts).sentences
      : sentences;
  const draft = buildDraft(confined);
  const opts: AnalyzeOptions = { skipQuoteRanges: recordCharRanges(draft, confined) };
  const report = verifyText(db, draft, opts);
  return crossReference(draft, confined, report);
}

/**
 * Build the per-sentence char ranges used to cross-reference the
 * verifier's report with the agent's tagged sentences.
 */
function sentenceCharRanges(
  draft: string,
  sentences: TaggedSentence[]
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cursor = 0;
  for (const s of sentences) {
    const tag = `[${s.tag}]`;
    const idx = draft.indexOf(tag, cursor);
    if (idx < 0) {
      out.push([cursor, cursor]);
      continue;
    }
    const after = idx + tag.length + 1; // skip the space after the tag
    const cite = s.pin_cite ? ` (${s.pin_cite})` : "";
    // The char range covers the text AND the parenthetical pin cite, so
    // citations placed inside the parenthetical (e.g. "410 U.S. 113")
    // still get cross-referenced to this sentence. Without the cite in
    // the range, an unresolved citation in the parenthetical would not
    // mark the sentence as unverified, and a verified-by-text citation
    // would not be associated with the sentence.
    const a = after;
    const b = a + s.text.length + cite.length;
    out.push([a, b]);
    cursor = idx + tag.length + 1 + s.text.length + cite.length + 1; // +1 = space between
  }
  return out;
}
