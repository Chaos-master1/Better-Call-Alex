/**
 * Verifier integration (CLAUDE.md §3, §5). The agents produce
 * `tagged_sentences` with [RECORD] / [LAW] / [INFERRED] tags and
 * optional pin cites. The G2 Verifier checks every citation and every
 * quoted span against the corpus. This module joins the two:
 *
 *   1. Joins the agent sentences into a single draft text, with tags
 *      preserved as a sidecar array.
 *   2. Runs the G2 Verifier (verifyText) on the draft.
 *   3. Cross-references: each sentence that the verifier flags as
 *      `unresolved_citation` / `quote_not_found` / `quote_wrong_case` /
 *      `unattributed` is marked `verified: false`.
 *   4. Emits a final render struct that the UI consumes: per-sentence
 *      text + tag + verification status + pin cite. Sentences that fail
 *      verification are rendered struck-through; the user must see them
 *      (§3, §11 — never silently dropped).
 *
 * The claim-tag gate (§5.3) is enforced HERE, not by prompt. If the
 * analyst returns a sentence that is not tagged, the gate rejects it.
 */
import { verifyText, type VerificationReport } from "./verify/verify.js";
import { verifyTextAsync } from "./verify/verify_async.js";
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

/** Async variant — does not block the event loop (preferred for the server). */
export async function verifyTaggedSentencesAsync(
  db: Database.Database,
  sentences: TaggedSentence[]
): Promise<RenderedDraft> {
  for (const [i, s] of sentences.entries()) {
    if (!s.tag) throw new Error(`[verify] sentence ${i} is untagged (CLAUDE.md §5.3)`);
  }
  const parts = sentences.map((s) => {
    const cite = s.pin_cite ? ` (${s.pin_cite})` : "";
    return `[${s.tag}] ${s.text}${cite}`;
  });
  const draft = parts.join(" ");
  const report = await verifyTextAsync(db, draft);
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
    if (s.tag === "LAW" && !s.pin_cite) {
      detail.push("LAW sentence without pin cite → unverified");
      verified = false;
    }
    return { index: i, tag: s.tag, text: s.text, pin_cite: s.pin_cite, verified, detail, inferred: s.tag === "INFERRED" };
  });
  const overall: "pass" | "fail" = report.overall === "pass" && bySentence.every((s) => s.verified) ? "pass" : "fail";
  return { draft, sentences: bySentence, report, overall };
}

/**
 * Stitch `tagged_sentences` into a single draft text and run the G2
 * Verifier over it. Returns the per-sentence render array with the
 * verifier verdict for each.
 */
export function verifyTaggedSentences(
  db: Database.Database,
  sentences: TaggedSentence[]
): RenderedDraft {
  // §5.3 gate: every sentence MUST be tagged. Untagged = reject.
  for (const [i, s] of sentences.entries()) {
    if (!s.tag) {
      throw new Error(`[verify] sentence ${i} is untagged (CLAUDE.md §5.3)`);
    }
  }
  // Build the draft text. We include the pin cite as a parenthetical so
  // eyecite can extract it; the renderer strips it back out.
  const parts = sentences.map((s) => {
    const cite = s.pin_cite ? ` (${s.pin_cite})` : "";
    return `[${s.tag}] ${s.text}${cite}`;
  });
  const draft = parts.join(" ");
  const report = verifyText(db, draft);

  // Cross-reference: walk each sentence in the draft; find the citations
  // whose char range lies inside the sentence's char range; mark
  // verified = (every such citation status === 'verified').
  const offsets = sentenceCharRanges(draft, sentences);
  const bySentence: VerifiedSentence[] = sentences.map((s, i) => {
    const [a, b] = offsets[i];
    const cits = report.citations.filter(
      (c) => c.cite_start >= a && c.cite_end <= b
    );
    const quotes = report.quotes.filter(
      (q) => q.start >= a && q.end <= b
    );
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
