/**
 * Quote matching for the G2 Verifier (§5.2 invariant).
 *
 * Conservative by design: canonicalization NEVER edits words. A quote that
 * differs from the source by a single altered word must fail — that is the
 * adversarial case this module exists to catch. The ladder is:
 *
 *   1. exact substring
 *   2. character-canonicalized substring (case, smart quotes/dashes,
 *      whitespace collapse) with an index map back to source offsets
 *   3. same, after expanding editorial bracket alterations ("[t]he" -> "the")
 *   4. ellipsis fragments: every fragment present, in order, within a
 *      bounded window (agents legitimately elide)
 *
 * No edit-distance fuzzing exists at any rung, by construction.
 */

export interface QuoteMatch {
  found: true;
  /** char offsets of the matched span inside the opinion text */
  start: number;
  end: number;
}

export type QuoteResult = QuoteMatch | { found: false };

interface Normed {
  norm: string;
  /** map[i] = index in the ORIGINAL string of norm[i]; last entry = orig.length */
  map: number[];
}

const CURLY_MAP: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u00a0": " ",
};

function normalizeWithMap(s: string): Normed {
  const out: string[] = [];
  const map: number[] = [];
  let pendingWs = false;
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (ch === "\u00ad") continue;
    ch = CURLY_MAP[ch] ?? ch;
    if (/\s/.test(ch)) {
      pendingWs = out.length > 0;
      continue;
    }
    if (pendingWs) {
      out.push(" ");
      map.push(i);
      pendingWs = false;
    }
    out.push(ch.toLowerCase());
    map.push(i);
  }
  map.push(s.length);
  return { norm: out.join(""), map };
}

/** Expand editorial bracket alterations: "[t]he" -> "the", "[her]" -> "her". */
function expandBrackets(normQuote: string): string {
  return normQuote.replace(/\[([a-z][a-z']*)\]/g, "$1");
}

function locate(
  hay: Normed,
  needleNorm: string
): { start: number; end: number } | null {
  const j = hay.norm.indexOf(needleNorm);
  if (j === -1) return null;
  return { start: hay.map[j], end: hay.map[j + needleNorm.length - 1] + 1 };
}

// Legal elision marks: … ... […] (...) (…). Single-quoted spans ARE
// extracted (by extractQuotedSpans in core.ts) under word-boundary guards
// on both delimiters, so intra-word apostrophes ("plaintiff's", "don't")
// can never delimit — G2 fixture invented_quote_single-15.
const ELLIPSIS_SPLIT = /(?:\u2026|\.\.\.|\[\u2026\]|\(\u2026\)|\[\.\.\.\]|\(\.\.\.\))/;

export function findQuote(text: string, quote: string): QuoteResult {
  if (!quote.trim()) return { found: false };

  // Rung 1: exact.
  const raw = text.indexOf(quote);
  if (raw !== -1) return { found: true, start: raw, end: raw + quote.length };

  // Rungs 2-4 share the canonicalized haystack.
  const hay = normalizeWithMap(text);
  const q = normalizeWithMap(quote);

  // Rung 2: canonicalized.
  const hit2 = locate(hay, q.norm);
  if (hit2) return { found: true, ...hit2 };

  // Rung 3: bracket alterations expanded.
  const qExpanded = expandBrackets(q.norm);
  if (qExpanded !== q.norm) {
    const hit3 = locate(hay, qExpanded);
    if (hit3) return { found: true, ...hit3 };
  }

  // Rung 4: ellipsis elision — ordered fragments within a bounded window.
  const frags = qExpanded
    .split(ELLIPSIS_SPLIT)
    .map((f) => f.replace(/^\s+|\s+$/g, ""))
    .filter((f) => f.length >= 4);
  if (frags.length >= 2) {
    let cursor = 0;
    let spanStart = -1;
    let ok = true;
    for (const f of frags) {
      const at = hay.norm.indexOf(f, cursor);
      // bounded gap: fragments may not drift arbitrarily far apart
      if (at === -1 || (cursor > 0 && at - cursor > 400 + f.length * 5)) {
        ok = false;
        break;
      }
      if (spanStart === -1) spanStart = hay.map[at];
      cursor = at + f.length;
    }
    if (ok) {
      return { found: true, start: spanStart, end: hay.map[cursor - 1] + 1 };
    }
  }

  return { found: false };
}
