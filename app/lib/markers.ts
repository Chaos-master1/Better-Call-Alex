/**
 * Internal pipeline marker contract — the ONE definition.
 *
 * run.ts wraps the gated IRAC fields and the adversary's counter-argument
 * in these markers so they ride the verifier gate as ordinary sentences
 * (§5.3); draft.ts routes them into their structured document slots and
 * strips them from the published sentence list. Both sides import the
 * patterns from here, so the contract cannot drift between emitter and
 * consumer. Markers are assembly scaffolding, never document content —
 * and never something a model is prompted to echo.
 */

/** The gated IRAC fields, in slot order. */
export const IRAC_FIELDS = ["issue", "rule", "application", "conclusion"] as const;
export type IracField = (typeof IRAC_FIELDS)[number];

/** `[IRAC:issue]` … `[IRAC:conclusion]` (capture 1 = the field). */
export const IRAC_MARKER = new RegExp(`^\\[IRAC:(${IRAC_FIELDS.join("|")})\\]\\s*`);
/** `[COUNTER-ARGUMENT]` */
export const COUNTER_ARGUMENT_MARKER = /^\[COUNTER-ARGUMENT\]\s*/;
/** Either marker, for stripping published sentences. */
export const ANY_MARKER = new RegExp(`${IRAC_MARKER.source}|${COUNTER_ARGUMENT_MARKER.source}`);

/** Emit a marked IRAC sentence (run.ts). */
export function iracSentence(field: IracField, text: string): { tag: "INFERRED"; text: string } {
  return { tag: "INFERRED", text: `[IRAC:${field}] ${text}` };
}

/** Emit the marked counter-argument sentence (run.ts). */
export function counterArgumentSentence(text: string): { tag: "INFERRED"; text: string } {
  return { tag: "INFERRED", text: `[COUNTER-ARGUMENT] ${text}` };
}

/** Slot name carried by a marked IRAC sentence, or null (draft.ts). */
export function iracFieldOf(text: string): IracField | null {
  const m = text.match(IRAC_MARKER);
  return m ? (m[1] as IracField) : null;
}
