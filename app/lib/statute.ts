/**
 * Statutory citation parsing and resolution (G4, CLAUDE.md §5.7).
 *
 * eyecite handles case law; statutes are detected here with a narrow
 * FULL-FORM pattern — "42 U.S.C. § 1983", "12 C.F.R. § 1026.36", "29 USC
 * 1910.1200". Bare "§ 1983" short forms stay `unsupported_form` (v1: the
 * title/code context they abbreviate is not tracked). Resolution looks the
 * (source, title, section) key up in the `statutes` table the G4 ETL
 * loads; quoted statute text is checked against the stored section text by
 * the same quote ladder cases use.
 */
import type Database from "better-sqlite3";

export type StatuteSource = "usc" | "ecfr";

export interface ParsedStatuteCite {
  source: StatuteSource;
  title: string;
  section: string;
  /** char offsets of the full cite in the scanned text */
  start: number;
  end: number;
  text: string;
}

export interface StatuteRow {
  id: number;
  source: StatuteSource;
  title: string;
  section: string;
  heading: string;
  text: string;
}

/**
 * Full-form statutory citations. The volume group anchors the match so
 * case cites ("410 U.S. 113") never hit: they lack the C. The section
 * stops at subsection parentheses ("1983(a)" captures "1983").
 */
const STATUTE_CITE_RE =
  /(\d{1,3})\s+(U\.?S\.?C\.?A?\.?|C\.?F\.?R\.?A?\.?)(?:\s*§+\s*|\s+)(\d{1,6}[A-Za-z]?(?:\.\d{1,4})?)/g;

export function parseStatuteCites(text: string): ParsedStatuteCite[] {
  const out: ParsedStatuteCite[] = [];
  for (const m of text.matchAll(STATUTE_CITE_RE)) {
    const idx = m.index ?? 0;
    const norm = m[2].toUpperCase().replace(/\./g, "");
    const source: StatuteSource = norm.startsWith("USC") ? "usc" : "ecfr";
    out.push({
      source,
      title: m[1],
      section: m[3],
      start: idx,
      end: idx + m[0].length,
      text: m[0],
    });
  }
  return out;
}

export function statuteTableExists(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='statutes'"
    )
    .get();
  return row != null;
}

export function resolveStatute(
  db: Database.Database,
  source: StatuteSource,
  title: string,
  section: string
): StatuteRow | null {
  const row = db
    .prepare(
      "SELECT id, source, title, section, heading, text FROM statutes WHERE source = ? AND title = ? AND section = ?"
    )
    .get(source, title, section) as
    | { id: number; source: StatuteSource; title: string; section: string; heading: string; text: string }
    | undefined;
  return row ?? null;
}

/** Display label for a statute, in the reporter's own style. */
export function statuteLabel(r: {
  source: StatuteSource;
  title: string;
  section: string;
}): string {
  const code = r.source === "usc" ? "U.S.C." : "C.F.R.";
  return `${r.title} ${code} § ${r.section}`;
}

/** The shape returned by the lookup surfaces (CLI, /api/lookup) for a
 *  resolved statute — a case-law LookupResult alternative. */
export interface StatuteLookup {
  type: "statute";
  citation: string;
  source: StatuteSource;
  title: string;
  section: string;
  heading: string;
  text: string;
}

export function toStatuteLookup(row: StatuteRow): StatuteLookup {
  return {
    type: "statute",
    citation: statuteLabel(row),
    source: row.source,
    title: row.title,
    section: row.section,
    heading: row.heading,
    text: row.text,
  };
}
