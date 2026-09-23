/**
 * Pin verification, rung 3 (Phase B): star-page anchors.
 *
 * The corpus carries CourtListener star pagination INLINE in the opinion
 * text — "*115", "*116", … sequential through the opinion (verified live:
 * 68 anchors in the Roe lead opinion). A pin cite claims "this proposition
 * is on page N of the cited reporter"; with anchors present that claim is
 * CHECKABLE: page N must fall within the opinion's anchored page span.
 *
 * Conservative scope — this verifies the PIN'S PAGE EXISTENCE within the
 * cited opinion, not that the quoted proposition sits on that exact page
 * (the corpus has no per-page text mapping). A pin pointing outside the
 * opinion's pages is a real defect; a pin inside the span is anchored.
 */

const STAR_RE = /(?<![\w*])\*(\d{1,4})(?!\w)/g;

/** Star-page anchors in source order: { page, char offset of the marker }. */
export interface StarAnchor {
  page: number;
  offset: number;
}

export function parseStarAnchors(text: string): StarAnchor[] {
  const anchors: StarAnchor[] = [];
  for (const m of text.matchAll(STAR_RE)) {
    const page = Number(m[1]);
    // Corrupt-OCR guard: real reporter pages are small; a 4-digit "page"
    // above 2999 is far more likely a footnote artifact or OCR junk.
    if (page >= 1 && page <= 2999) {
      anchors.push({ page, offset: m.index! });
    }
  }
  // Anchors must be non-decreasing in page within one opinion; a decrease
  // signals OCR damage — keep the longest well-formed prefix and stop.
  const clean: StarAnchor[] = [];
  for (const a of anchors) {
    if (clean.length > 0 && a.page < clean[clean.length - 1].page) break;
    clean.push(a);
  }
  return clean;
}

export type PinStatus =
  | "pin_unverified"
  | "pin_in_range"
  | "pin_out_of_range"
  | "pin_no_anchors";

/**
 * Check a pin page against an opinion's star anchors.
 *
 * @param pin raw pin string ("113", "113-114")
 * @param firstPage the reporter first page of the citation (anchor 0 base)
 */
export function checkPin(
  pin: string | null,
  firstPage: string | null,
  anchors: StarAnchor[]
): PinStatus {
  if (!pin || anchors.length === 0) return anchors.length === 0 ? "pin_no_anchors" : "pin_unverified";
  const m = pin.trim().match(/^(\d{1,4})/);
  if (!m) return "pin_unverified";
  const page = Number(m[1]);
  if (!Number.isFinite(page)) return "pin_unverified";
  // Anchor pages are absolute reporter pages (star markers carry the
  // reporter page number), so no first-page offset is needed.
  void firstPage;
  const min = anchors[0].page;
  const max = anchors[anchors.length - 1].page;
  if (page >= min && page <= max) return "pin_in_range";
  return "pin_out_of_range";
}
