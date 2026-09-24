/**
 * F2 — support evidence (Phase F): the difference between a citation that
 * RESOLVES and a proposition the corpus actually BACKS. For every verified
 * citation this probes the resolved opinion's text and surfaces the passage
 * a reader would check first:
 *
 *   - with a pin: the star-anchor window for the pinned page (pin cites
 *     claim "this proposition is on page N"; the window is the best
 *     textual evidence of what page N holds);
 *   - without a pin: the opinion's opening span (the case itself is the
 *     evidence; the passage orients the reader).
 *
 * Advisory only, never a strike: the overlap check between the sentence's
 * words and the window is a lexical heuristic, not proposition understanding.
 * When a pinned window shares almost nothing with the sentence, that is
 * surfaced honestly (`pin_unsupported`) so the user verifies the proposition
 * themselves — the verifier strikes only what it can prove (§5.5).
 *
 * All failures degrade to "no evidence" — an advisory pass can never break
 * verification.
 */
import type Database from "better-sqlite3";
import { parseStarAnchors } from "./pins.js";
import type { CitationCheck } from "./core.js";

export interface SupportEvidence {
  /** The citation this evidence backs (CitationCheck.citation_text). */
  citation: string;
  /** Resolved opinion the passage comes from. */
  opinion_id: number;
  case_name: string | null;
  /** Pin string the window was located for, when present. */
  pin: string | null;
  /** Verbatim corpus span (trimmed to ~240 chars at a word boundary). */
  passage: string;
  /** Char offset of the passage inside the opinion's stored text. */
  passage_offset: number;
  /** Advisory: the pinned window shares almost none of the sentence's
   *  content words — check the proposition yourself. Never set when the
   *  window could not be located (no anchors) — unjudgeable ≠ unsupported. */
  pin_unsupported?: boolean;
}

/** Window size for the surfaced passage. */
const WINDOW = 240;
/** Below this content-word overlap a pinned window is flagged unsupported. */
const OVERLAP_FLOOR = 0.25;

const STOP = new Set(
  "the that this with from have has had was were are was been being which whose there their they them then than thus because about into over under also would could should shall must may might will very such where when while these those upon said same other another between among each more most some any all both".split(
    " "
  )
);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-zà-ÿ']{4,}/g) ?? []).filter(
    (w) => !STOP.has(w)
  );
}

/** Trim a slice to ≤ max chars without cutting a word. */
function trimAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return (cut > max * 0.5 ? text.slice(0, cut) : text.slice(0, max)).trim();
}

/** Leading page number of a pin/page string ("1871-72" → 1871). */
function pinPage(raw: string | null | undefined): number | null {
  const m = /^(\d{1,4})/.exec(String(raw ?? "").trim());
  return m ? Number(m[1]) : null;
}

export function supportForCitation(
  db: Database.Database,
  c: CitationCheck,
  sentenceText: string
): SupportEvidence | null {
  if (c.status !== "verified" || c.opinion_id == null) return null;
  const row = db
    .prepare(`SELECT text, case_name FROM opinions WHERE id = ?`)
    .get(c.opinion_id) as { text: string | null; case_name: string | null } | undefined;
  const text = row?.text;
  if (!text) return null;

  // The pin page: full cites keep it in cite_pin_raw; short forms carry the
  // pin in `.page` itself (the full-cite first page is not a pin).
  const rawPin =
    c.form === "full" ? (c.cite_pin_raw ?? null) : (c.page ?? null);
  const page = pinPage(rawPin);

  let start: number;
  let end: number;
  let judged = false;
  if (page != null) {
    const anchors = parseStarAnchors(text);
    if (anchors.length > 0) {
      // Window for the pinned page: from its anchor to the next one (or
      // end of text). Outside the span → clamp to the nearest end window;
      // the pin gate already strikes true out-of-range pins.
      let i = anchors.findIndex((a) => a.page >= page);
      if (i < 0) i = anchors.length - 1;
      start = anchors[i].offset;
      end = i + 1 < anchors.length
        ? Math.min(anchors[i + 1].offset, start + WINDOW + 40)
        : start + WINDOW + 40;
      judged = true;
    } else {
      start = 0; // no anchors: cannot judge, orient with the opening span
      end = WINDOW + 40;
    }
  } else {
    start = 0;
    end = WINDOW + 40;
  }

  const passage = trimAtWord(text.slice(start, end), WINDOW);
  const evidence: SupportEvidence = {
    citation: c.citation_text,
    opinion_id: c.opinion_id,
    case_name: row?.case_name ?? c.case_name ?? null,
    pin: rawPin,
    passage,
    passage_offset: start,
  };

  // Advisory overlap: only when a real pin window was located. Sentence
  // context = the citation's surroundings (a sentence-ish span), so other
  // draft sentences do not dilute the check.
  if (judged) {
    const ctxStart = Math.max(0, c.cite_start - 300);
    const ctx = sentenceText.slice(ctxStart, c.cite_end + 300);
    const sentWords = new Set(contentWords(ctx));
    if (sentWords.size > 0) {
      const windowWords = contentWords(passage);
      const hit = windowWords.filter((w) => sentWords.has(w)).length;
      const frac = windowWords.length > 0 ? hit / windowWords.length : 0;
      if (frac < OVERLAP_FLOOR) evidence.pin_unsupported = true;
    }
  }
  return evidence;
}
