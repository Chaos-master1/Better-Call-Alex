import Database from "better-sqlite3";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
export const CORPUS_PATH = path.join(REPO, "data", "corpus.sqlite");
export const APP_PATH = path.join(REPO, "data", "app.sqlite");

export function openCorpus(): Database.Database {
  const db = new Database(CORPUS_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = 1");
  // 2 GB window: keeps hot regions of opinions_fts addressable across calls.
  db.pragma("mmap_size = 2147483648");
  return db;
}

export interface LookupResult {
  opinion_id: number;
  cluster_id: number;
  case_name: string | null;
  case_name_short: string | null;
  date_filed: string | null;
  court_id: string | null;
  court_name: string | null;
  precedential_status: string | null;
  citation_count: number | null;
  cited_by: number;
  citations: { volume: string; reporter: string; page: string; type: string }[];
}

/** Fallback spellings when a parsed reporter does not match storage. */
export const REPORTER_ALIASES: Record<string, string> = {
  "u.s.": "U.S.",
  us: "U.S.",
  "f.2d": "F.2d",
  "f.3d": "F.3d",
  "f.4th": "F.4th",
  "s.ct.": "S. Ct.",
};

export function normalizeReporter(reporter: string): string {
  return REPORTER_ALIASES[reporter.trim().toLowerCase()] ?? reporter.trim();
}

/**
 * Exact citation -> cluster resolution (§3 step 1: citation lookup is never
 * a search). Shared by the CLI and the G2 Verifier. De-indexed opinions are
 * excluded (§9.7); orphan citation_strings cannot produce degenerate cards.
 */
export function resolveCluster(
  db: Database.Database,
  volume: string,
  reporter: string,
  page: string
): LookupResult | null {
  const candidates = [reporter, normalizeReporter(reporter)];
  for (const rep of candidates) {
    const rows = db
      .prepare(
        `SELECT DISTINCT cs.cluster_id, cs.volume, cs.reporter, cs.page, cs.type,
                o.id AS opinion_id, o.case_name, o.case_name_short, o.date_filed,
                o.court_id, o.precedential_status, o.citation_count
         FROM citation_strings cs
         JOIN opinions o ON o.cluster_id = cs.cluster_id
         WHERE cs.volume = ? AND cs.reporter = ? AND cs.page = ?
           AND o.blocked = 0
         ORDER BY CASE WHEN o.type LIKE '%lead%' THEN 0
                       WHEN o.type LIKE '%combined%' THEN 1 ELSE 2 END, o.id`
      )
      .all(String(Number(volume)), rep, String(Number(page))) as Array<
      LookupResult & {
        volume: string;
        reporter: string;
        page: string;
        type: string;
      }
    >;
    if (rows.length === 0) continue;

    const first = rows[0];
    const clusterId = first.cluster_id;

    let citedBy = 0;
    if (clusterId != null) {
      citedBy =
        (
          db
            .prepare(
              `SELECT count(DISTINCT ci.citing_id) AS n FROM cites ci
               JOIN opinions po ON po.id = ci.cited_id
               WHERE po.cluster_id = ?`
            )
            .get(clusterId) as { n: number } | undefined
        )?.n ?? 0;
    }

    let courtName: string | null = null;
    if (first.court_id) {
      courtName =
        (
          db.prepare(`SELECT name FROM courts WHERE id = ?`).get(first.court_id) as
            | { name: string }
            | undefined
        )?.name ?? null;
    }

    return {
      opinion_id: first.opinion_id ?? -1,
      cluster_id: first.cluster_id,
      case_name: first.case_name,
      case_name_short: first.case_name_short,
      date_filed: first.date_filed,
      court_id: first.court_id,
      court_name: courtName,
      precedential_status: first.precedential_status,
      citation_count: first.citation_count,
      cited_by: citedBy,
      citations: rows.map((r) => ({
        volume: r.volume,
        reporter: r.reporter,
        page: r.page,
        type: r.type,
      })),
    };
  }
  return null;
}
