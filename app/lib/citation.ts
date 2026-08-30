/**
 * Citation parser. Shared by the CLI and the lookup API route.
 * Matches the canonical form: <volume> <reporter> <page>, e.g.
 *   410 U.S. 113
 *   384 U.S. 436
 *   915 F.2d 1234
 * The reporter may be a multi-word abbreviation (e.g. "F. Supp. 2d")
 * but the parser is intentionally lenient: it stops at the last
 * numeric token, treats that as the page, and the middle as the reporter.
 */
export function parseCitation(
  input: string
): { volume: string; reporter: string; page: string } | null {
  const m = input
    .trim()
    .match(/^(\d{1,4})\s+([A-Za-z][A-Za-z0-9 .']*?\.?)\s+(\d{1,6})$/);
  if (!m) return null;
  const vol = m[1].trim();
  const pg = m[3].trim();
  return {
    volume: String(Number(vol)),
    reporter: m[2].trim(),
    page: String(Number(pg)),
  };
}
