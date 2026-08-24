import type Database from "better-sqlite3";

export interface Passage {
  text: string;
  /** character offset of `text` inside the stored opinion text */
  start: number;
  end: number;
}

export interface SearchHit {
  opinion_id: number;
  cluster_id: number | null;
  case_name: string | null;
  case_name_short: string | null;
  date_filed: string | null;
  court_id: string | null;
  precedential_status: string | null;
  ocr: boolean;
  scores: {
    bm25: number;
    authority_multiplier: number;
    final: number;
    parenthetical_hits: number;
  };
  treatment_flags: number;
  cited_by_recent: number;
  passages: Passage[];
}

export interface SearchOptions {
  /** court_id, jurisdiction string, or parent court whose subtree is included */
  jurisdiction?: string;
  /** results to return (default 10) */
  limit?: number;
}

/** §9.7: honor de-indexing requests. */
const EXCLUDE_BLOCKED = 1;
/**
 * Decided at G1 kickoff (docs/g0-audit.md): Unknown-status opinions remain
 * searchable, with status surfaced in every hit rather than hidden.
 */
const SEARCHABLE_STATUS = ["Published", "Unknown"];

const POOL_LADDER = [200, 2_000, 20_000];
const PAREN_POOL = 500;
const PASSAGE_LEN = 600;
/** §9.6: OCR-extracted text is degraded; down-weight it. */
const OCR_WEIGHT = 0.7;
/** weight of the parenthetical-index agreement signal in the multiplier */
const PAREN_BOOST = 0.25;

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "for", "on", "and", "or", "is",
  "was", "were", "be", "been", "by", "with", "at", "as", "that", "this",
]);

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .slice(0, 24);
}

export function matchExpression(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

function jurisdictionCourtIds(
  db: Database.Database,
  jurisdiction: string
): Set<string> {
  const rows = db
    .prepare(
      `WITH RECURSIVE cs(id) AS (
         SELECT id FROM courts
          WHERE id = ?
             OR jurisdiction = ? COLLATE NOCASE
             OR citation_string = ? COLLATE NOCASE
         UNION ALL
         SELECT c.id FROM courts c JOIN cs ON c.parent_id = cs.id
       )
       SELECT id FROM cs`
    )
    .all(jurisdiction, jurisdiction, jurisdiction) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

interface PoolRow {
  id: number;
  bm25: number;
  cluster_id: number | null;
  case_name: string | null;
  case_name_short: string | null;
  date_filed: string | null;
  court_id: string | null;
  precedential_status: string | null;
  ocr: number;
  pagerank: number | null;
  recent_cites_2y: number | null;
  treatment_flags: number | null;
}

function fetchPool(
  db: Database.Database,
  ids: number[]
): Map<number, PoolRow> {
  const map = new Map<number, PoolRow>();
  for (let i = 0; i < ids.length; i += 800) {
    const chunk = ids.slice(i, i + 800);
    const marks = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT o.id, o.cluster_id, o.case_name, o.case_name_short,
                o.date_filed, o.court_id, o.precedential_status, o.ocr,
                a.pagerank, a.recent_cites_2y, a.treatment_flags
           FROM opinions o
           LEFT JOIN authority a ON a.opinion_id = o.id
          WHERE o.id IN (${marks})`
      )
      .all(...chunk) as Array<Omit<PoolRow, "bm25">>;
    for (const r of rows) map.set(r.id, { ...r, bm25: 0 });
  }
  return map;
}

/**
 * Authority multiplier per CLAUDE.md §3 step 4:
 *   bm25 × authority(pagerank, recency, court level)
 * Monotone, deterministic, defined even while the authority table is empty
 * (multiplier 1.0 until build_authority.py has written rows).
 */
function authorityMultiplier(row: PoolRow): number {
  let s = 0;
  if (row.pagerank != null && row.pagerank > 0) {
    s += 0.5 * Math.log1p(row.pagerank * 1e6);
  }
  if (row.recent_cites_2y != null && row.recent_cites_2y > 0) {
    s += 0.3 * Math.log1p(row.recent_cites_2y);
  }
  if (row.court_id === "scotus") s += 1.0;
  return 1 + s;
}

function parenBoosts(
  db: Database.Database,
  expr: string
): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT p.described_id AS described_id, count(*) AS n FROM (
         SELECT rowid, bm25(parentheticals_fts) AS r
           FROM parentheticals_fts
          WHERE parentheticals_fts MATCH ?
          ORDER BY r LIMIT ?
       ) f JOIN parentheticals p ON p.rowid = f.rowid
       WHERE p.described_id IS NOT NULL
       GROUP BY p.described_id`
    )
    .all(expr, PAREN_POOL) as Array<{ described_id: number; n: number }>;
  return new Map(rows.map((r) => [r.described_id, r.n]));
}

/** First high-density window of the query terms, as absolute char offsets. */
export function extractPassage(
  text: string,
  tokens: string[],
  len: number = PASSAGE_LEN
): Passage {
  const hay = text.toLowerCase();
  let best = -1;
  let bestCount = -1;
  const positions: number[] = [];
  for (const t of tokens) {
    let idx = hay.indexOf(t);
    let guard = 0;
    while (idx !== -1 && guard++ < 200) {
      positions.push(idx);
      idx = hay.indexOf(t, idx + t.length);
    }
  }
  positions.sort((a, b) => a - b);
  // sliding window over term positions; densest window wins, earliest breaks ties
  let lo = 0;
  for (let hi = 0; hi < positions.length; hi++) {
    while (positions[hi] - positions[lo] >= len) lo++;
    const count = hi - lo + 1;
    if (count > bestCount) {
      bestCount = count;
      best = positions[lo];
    }
  }
  const start =
    best === -1 ? 0 : Math.max(0, best - Math.floor(len / 4));
  return { text: text.slice(start, start + len).trim(), start, end: start + len };
}

export function search(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {}
): SearchHit[] {
  const limit = opts.limit ?? 10;
  const tokens = tokenize(query);
  const expr = matchExpression(tokens);
  if (!expr) return [];

  const courts =
    opts.jurisdiction != null
      ? jurisdictionCourtIds(db, opts.jurisdiction)
      : null;
  if (courts && courts.size === 0) return [];

  const statusMarks = SEARCHABLE_STATUS.map(() => "?").join(",");

  let candidates: PoolRow[] = [];
  let usedPool = 0;
  for (const poolSize of POOL_LADDER) {
    usedPool = poolSize;
    const ranked = db
      .prepare(
        `SELECT rowid AS id, bm25(opinions_fts) AS bm25
           FROM opinions_fts
          WHERE opinions_fts MATCH ?
          ORDER BY bm25 LIMIT ?`
      )
      .all(expr, poolSize) as Array<{ id: number; bm25: number }>;
    if (ranked.length === 0) return [];
    const meta = fetchPool(db, ranked.map((r) => r.id));
    candidates = [];
    for (const r of ranked) {
      const m = meta.get(r.id);
      if (!m) continue; // orphan edge noise cannot happen here, defensive
      if (m.precedential_status == null ||
          !SEARCHABLE_STATUS.includes(m.precedential_status)) continue;
      if (courts && (m.court_id == null || !courts.has(m.court_id))) continue;
      m.bm25 = r.bm25;
      candidates.push(m);
    }
    const distinctClusters = new Set(
      candidates.map((c) => c.cluster_id ?? c.id)
    ).size;
    if (distinctClusters >= limit) break;
  }

  const boosts = parenBoosts(db, expr);

  const scored = candidates.map((row) => {
    const mult = authorityMultiplier(row);
    const pb = boosts.get(row.id) ?? 0;
    const parenMult = 1 + PAREN_BOOST * Math.log1p(pb);
    const w = (row.ocr ? OCR_WEIGHT : 1) * mult * parenMult;
    return { row, final: -row.bm25 * w, pb };
  });
  scored.sort(
    (a, b) => b.final - a.final || a.row.id - b.row.id
  );
  // A case is a cluster: its lead/dissent/concurrence opinions must not
  // crowd out other authority. Keep the best-scoring opinion per cluster.
  const seenClusters = new Set<number>();
  const top: typeof scored = [];
  for (const s of scored) {
    const key = s.row.cluster_id ?? s.row.id;
    if (seenClusters.has(key)) continue;
    seenClusters.add(key);
    top.push(s);
    if (top.length >= limit) break;
  }
  if (top.length === 0) return [];

  const textStmt = db.prepare("SELECT text FROM opinions WHERE id = ?");
  return top.map(({ row, final, pb }) => {
    const text = (textStmt.get(row.id) as { text: string } | undefined)?.text ?? "";
    return {
      opinion_id: row.id,
      cluster_id: row.cluster_id,
      case_name: row.case_name,
      case_name_short: row.case_name_short,
      date_filed: row.date_filed,
      court_id: row.court_id,
      precedential_status: row.precedential_status,
      ocr: !!row.ocr,
      scores: {
        bm25: row.bm25,
        authority_multiplier: authorityMultiplier(row),
        final,
        parenthetical_hits: pb,
      },
      treatment_flags: row.treatment_flags ?? 0,
      cited_by_recent: row.recent_cites_2y ?? 0,
      passages: text ? [extractPassage(text, tokens)] : [],
    };
  });
}
