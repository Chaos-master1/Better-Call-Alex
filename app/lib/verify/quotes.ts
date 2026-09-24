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
 *
 * Rung 5 (veto, independent audit 2026-09-20 probe02): a match that begins
 * IMMEDIATELY AFTER a negator word in the source ("no|not|never|none|
 * neither|nor|cannot " + space) is rejected when the quote itself does not
 * open with that negator. This is the dropped-negator signature: the two
 * mutations that escaped every exact-matching rung ("No person shall be
 * deprived…" quoted as "person shall be deprived…") are verbatim substrings
 * of the source, so no textual ladder can catch them — but a legitimate
 * quote of a negated span virtually always includes the negator, while a
 * quote that silently sheds one flips the meaning. If the same span also
 * occurs somewhere WITHOUT a preceding negator, that occurrence matches
 * and the veto never fires. Conservative toward failing by design.
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

// Opinion texts are re-normalized on every findQuote call against the same
// source (verbatim repeats, sibling scans, true-source probes) — the
// dominant cost of a large verification. normalizeWithMap is a pure
// function of its input, so results are cached. Bounded FIFO (Map keeps
// insertion order; first key evicted): worst case ~12 opinion texts of
// norm+index ≈ tens of MB, released as new texts rotate in.
const NORM_CACHE_MAX = 12;
/** Total source chars held across cached entries — a multi-megabyte
 *  opinion (norm + index map) must not evict everything else, and enough
 *  of them must not balloon process memory. */
const NORM_CACHE_CHAR_BUDGET = 6_000_000;
const normCache = new Map<string, Normed>();

/** Chars processed between scheduling points. Bounds the event-loop stall
 *  of normalizing a multi-megabyte opinion to ~100ms per chunk. */
const NORM_CHUNK = 1 << 17;

/**
 * Chunked normalization — a generator so the cooperative drain can give
 * the event loop a turn mid-normalization of huge corpus texts. The sync
 * drain (normalizeWithMap) runs it uninterrupted: identical result.
 */
export function* normalizeWithMapGen(s: string): Generator<void, Normed, void> {
  const hit = normCache.get(s);
  if (hit) return hit;
  const out: string[] = [];
  const map: number[] = [];
  let pendingWs = false;
  let sinceYield = 0;
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
    if (++sinceYield >= NORM_CHUNK) {
      sinceYield = 0;
      yield;
    }
  }
  map.push(s.length);
  const normed: Normed = { norm: out.join(""), map };
  if (s.length >= 4096 && s.length <= NORM_CACHE_CHAR_BUDGET) {
    let charSum = 0;
    for (const k of normCache.keys()) charSum += k.length;
    while (
      normCache.size > 0 &&
      (normCache.size >= NORM_CACHE_MAX || charSum + s.length > NORM_CACHE_CHAR_BUDGET)
    ) {
      const oldest = normCache.keys().next().value!;
      charSum -= oldest.length;
      normCache.delete(oldest);
    }
    normCache.set(s, normed);
  }
  return normed;
}

function normalizeWithMap(s: string): Normed {
  const gen = normalizeWithMapGen(s);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
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

/** Negator set for the dropped-negator veto (rung 5). Whole words only —
 *  "noted"/"known"/"number" must never trigger it. */
function matchIsNegatorShed(text: string, start: number, quote: string): boolean {
  // The quote opening with the negator itself is the honest form.
  if (/^(?:no|not|never|none|neither|nor|cannot)\s/i.test(quote.trimStart())) return false;
  // Canonicalized window before the match: whitespace-collapsed and
  // curly-quote-mapped, so `‘no person…`, `"no person…`, and `(no person…`
  // all expose the negator as its own token. normalizeWithMap SWALLOWS
  // trailing whitespace (it flushes only when a following char arrives),
  // so the window ends directly at the negator token; the pattern matches
  // "start-or-space, negator, optional punctuation, end". A 48-char window
  // keeps ^ from landing mid-word.
  const before = normalizeWithMap(text.slice(Math.max(0, start - 48), start)).norm;
  // Boundary before the negator: start-of-window, whitespace, or an opening
  // quote/bracket (curly forms are mapped to straight ones above) — a
  // negator that opens a quoted segment (`‘no person…`) is precisely the
  // shed-negator signature. A letter boundary ("known", "casino") never
  // matches.
  return /(?:^| |['"(\[])(?:no|not|never|none|neither|nor|cannot)[.,;:]?$/i.test(before);
}

/** Test seam: clears the normalization cache (pure-function tests expect
 *  independence between cases). */
export function resetQuoteCaches(): void {
  normCache.clear();
}

/** Sync drain — byte-identical to the pre-generator ladder (tests, evals). */
export function findQuote(text: string, quote: string): QuoteResult {
  const gen = findQuoteGen(text, quote);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

export function* findQuoteGen(
  text: string,
  quote: string
): Generator<void, QuoteResult, void> {
  if (!quote.trim()) return { found: false };

  // Rung 1: exact — scan occurrences; the first non-vetoed one wins. If a
  // source repeats a span both after a negator and clean, the clean
  // occurrence still verifies (the veto is per-occurrence, not per-quote).
  let cursor = 0;
  for (;;) {
    const raw = text.indexOf(quote, cursor);
    if (raw === -1) break;
    if (!matchIsNegatorShed(text, raw, quote)) {
      return { found: true, start: raw, end: raw + quote.length };
    }
    cursor = raw + 1;
  }

  // Rungs 2-4 share the canonicalized haystack — the chunked generator
  // yields inside multi-megabyte normalizations.
  const hay = yield* normalizeWithMapGen(text);
  const q = normalizeWithMap(quote);

  // Rung 2: canonicalized.
  const hit2 = locate(hay, q.norm);
  if (hit2 && !matchIsNegatorShed(text, hit2.start, quote)) {
    return { found: true, ...hit2 };
  }

  // Rung 3: bracket alterations expanded.
  const qExpanded = expandBrackets(q.norm);
  if (qExpanded !== q.norm) {
    const hit3 = locate(hay, qExpanded);
    if (hit3 && !matchIsNegatorShed(text, hit3.start, quote)) {
      return { found: true, ...hit3 };
    }
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
    if (ok && !matchIsNegatorShed(text, spanStart, quote)) {
      return { found: true, start: spanStart, end: hay.map[cursor - 1] + 1 };
    }
  }

  return { found: false };
}
