/**
 * Model-output normalizer (Phase A — cloud text hygiene).
 *
 * Frontier models are fluent markdown writers; the local 9B/14B tier is
 * not. The verifier's quote ladder canonicalizes case, smart quotes,
 * dashes, and whitespace (docs/verifier.md) but deliberately has NO
 * edit-distance fuzzing — so a quote wrapped in `**bold**` or `code`
 * markers would fail verbatim matching that should succeed, and eyecite
 * would mis-extract cites split across emphasis markers.
 *
 * This module strips PRESENTATION-ONLY artifacts from agent string fields
 * before verification:
 *   - emphasis/strong markers: **x**, *x*, __x__, _x_ (word-boundary safe)
 *   - inline code backticks: `x` (but never a quote's own apostrophes)
 *   - markdown list debris at line starts: "- ", "* ", "+ ", "1. "
 *   - heading markers: ## x
 *
 * It is applied to BOTH engines (harmless locally, load-bearing for
 * cloud). It NEVER touches quoted-span internals beyond removing the
 * markers themselves — a one-word-altered quote still fails, which is the
 * permanent fixture's guarantee (docs/verifier.md ladder, no fuzzing).
 *
 * Deliberately NOT stripped: blockquotes (`> `) inside quoted spans are
 * left to the verifier's whitespace canonicalization; footnote syntax;
 * tables (agents do not emit them into sentence fields).
 */

/** Inline emphasis + code. Order matters: strong before emphasis, and the
 *  doubled underscores before single to avoid leaving stray tildes. */
const INLINE_PATTERNS: Array<[RegExp, string]> = [
  [/\*\*\*([^*\n]+)\*\*\*/g, "$1"],
  [/\*\*([^*\n]+)\*\*/g, "$1"],
  [/__([^_\n]+)__/g, "$1"],
  // *emphasis* — requires a non-space char right after the opener and
  // before the closer, and no space before the closer, so bullet "* item"
  // and multiplication "3 * 4" are untouched.
  [/(?<![\w*])\*(\S[^*\n]*?)\*(?![\w*])/g, "$1"],
  // _emphasis_ — same shape; word chars before the opener exclude
  // snake_case identifiers.
  [/(?<![\w_])_(\S[^_\n]*?)_(?![\w_])/g, "$1"],
  [/`([^`\n]+)`/g, "$1"],
];

/** Line-start debris: markdown bullets, headings, bold-only lines. */
const LINE_PATTERNS: Array<[RegExp, string]> = [
  [/^#{1,6}\s+/gm, ""],
  [/^[-*+]\s+/gm, ""],
  [/^\d+[.)]\s+/gm, ""],
];

export function normalizeModelText(text: string): string {
  let out = String(text ?? "");
  for (const [re, rep] of LINE_PATTERNS) out = out.replace(re, rep);
  for (const [re, rep] of INLINE_PATTERNS) out = out.replace(re, rep);
  // Collapse runs of 3+ blank lines that list stripping can leave behind.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

/** Normalize every string field of an agent sentence array (tag preserved;
 *  pin cites normalized too — a model may write pin cites in bold). */
export function normalizeTaggedSentences<
  T extends { text: string; pin_cite?: string }
>(sentences: T[]): T[] {
  return sentences.map((s) => ({
    ...s,
    text: normalizeModelText(s.text),
    ...(s.pin_cite !== undefined
      ? { pin_cite: normalizeModelText(s.pin_cite).trim() }
      : {}),
  }));
}

/** Normalize a plain prose field (IRAC values, counter-argument, caveat
 *  strings, queries). */
export function normalizeProse(s: string): string {
  return normalizeModelText(s);
}
