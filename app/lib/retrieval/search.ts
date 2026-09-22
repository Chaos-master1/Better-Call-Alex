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
  via_parenthetical_recall?: boolean;
  /** surfaced through citation-graph co-citation expansion (opts.prf) */
  via_prf?: boolean;
  /** re-ranked by query-term passage density (opts.densityRerank) */
  density?: number;
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
  /** pre-resolved court set (researcher path) — preferred over `jurisdiction` */
  jurisdictionIds?: Set<string>;
  /** results to return (default 10) */
  limit?: number;
  /**
   * Citation-graph pseudo-relevance feedback (audit Phase B): opinions that
   * co-cite ≥2 of the top organic hits join the doctrine family even when
   * their phrasing buries them at bm25 rank #200–#5,000. Eval-arbitrated —
   * kept only if the mechanical p@10 rewards it. Fills leftover slots only,
   * after parenthetical-recall seeds.
   */
  prf?: boolean;
  /**
   * Passage-density re-rank (audit Phase B): among the top organic
   * candidates, opinions whose query terms cluster densely in one passage
   * outrank those with scattered single mentions. Whole-opinion bm25 cannot
   * see this — a 300k-char opinion dilutes its one dense section. Multiply
   * the final score by (1 + w·log1p(densest-window term count)).
   * Eval-arbitrated like prf.
   */
  densityRerank?: boolean;
  /**
   * When provided, per-phase timings are filled in (milliseconds). Zero
   * cost when absent — the common path never allocates or clocks.
   */
  timings?: SearchTimings;
}

/** Per-phase latency breakdown (audit 2026-09-20: the 4.1 s warm tail was
 *  attributed by eye, not by measurement — this makes the gate diagnosable). */
export interface SearchTimings {
  tokenize_ms: number;
  courts_ms: number;
  fts_pool_ms: number;
  fetch_meta_ms: number;
  paren_ms: number;
  score_ms: number;
  seeds_ms: number;
  prf_ms: number;
  text_ms: number;
  total_ms: number;
}

export function newTimings(): SearchTimings {
  return {
    tokenize_ms: 0, courts_ms: 0, fts_pool_ms: 0, fetch_meta_ms: 0,
    paren_ms: 0, score_ms: 0, seeds_ms: 0, prf_ms: 0, text_ms: 0, total_ms: 0,
  };
}

/** §9.7: honor de-indexing requests. */
const EXCLUDE_BLOCKED = 1;
/**
 * Decided at G1 kickoff (docs/g0-audit.md): Unknown-status opinions remain
 * searchable, with status surfaced in every hit rather than hidden.
 */
const SEARCHABLE_STATUS = ["Published", "Unknown"];

/**
 * Rung 1 is deliberately large: FTS5 ranking cost is LIMIT-independent
 * (measured — ORDER BY over the match set dominates), so widening the pool
 * is nearly free and lets the authority multiplier rescue landmarks that sit
 * at bm25 rank #200–#5,000 behind shorter, denser opinions.
 */
const POOL_LADDER = [1_000, 20_000];
const PAREN_POOL = 500;
/**
 * §3 step 3 as RECALL, not just re-ranking: a landmark that predates the
 * query's vocabulary (International Shoe lacks "personal jurisdiction")
 * can never enter an AND-conjunction pool, no matter how often later
 * judges describe it in parentheticals. When the query names doctrine
 * phrases, reserve this many result slots for the most-described
 * matching opinions so the parenthetical index can rescue them.
 */
const PAREN_SEED_SLOTS = 2;
const PAREN_SEED_SCAN = 100;
/** PRF (opts.prf): top organic opinions whose citers are mined. */
const PRF_TOP = 5;
/** PRF: a citer must cite at least this many of the top hits (co-citation). */
const PRF_MIN_COCITES = 2;
/** PRF: citer pool scanned by bm25 before filtering. */
const PRF_CITER_POOL = 60;
/** PRF: max slots fillable (never displaces organic or parenthetical hits). */
const PRF_SLOTS = 2;
/** Density re-rank: how many top organic candidates get text-scanned. */
const DENSITY_TOP = 50;
/** Density re-rank: multiplier weight per log-doubling of window density. */
const DENSITY_WEIGHT = 0.5;
/** Density re-rank: window size in chars (matches PASSAGE_LEN semantics). */
const DENSITY_WINDOW = 600;
const PASSAGE_LEN = 600;
/** §9.6: OCR-extracted text is degraded; down-weight it. */
const OCR_WEIGHT = 0.7;
/** weight of the parenthetical-index agreement signal in the multiplier */
const PAREN_BOOST = 0.25;

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "for", "on", "and", "or", "is",
  "was", "were", "be", "been", "by", "with", "at", "as", "that", "this",
]);

/**
 * Compound legal doctrine terms (lever #1, docs/retrieval.md): matched as
 * FTS5 phrases instead of loose AND-conjunctions. Slashes the candidate set
 * for doctrine queries (latency tail) and stops short dense opinions from
 * crowding landmarks out of the top-10 (precision).
 */
const PHRASES = new Set([
  // constitutional law
  "first amendment", "second amendment", "fourth amendment", "fifth amendment",
  "sixth amendment", "fourteenth amendment", "takings clause",
  "equal protection",
  "strict scrutiny", "intermediate scrutiny", "rational basis",
  "procedural due process", "substantive due process",
  "commerce clause", "dormant commerce clause", "substantial effects",
  "interstate commerce", "necessary and proper", "supremacy clause",
  "separation of powers", "executive privilege", "political question",
  "sovereign immunity", "full faith and credit", "privileges and immunities",
  "free speech", "free exercise", "establishment clause", "prior restraint",
  "actual malice", "cruel and unusual punishment", "double jeopardy",
  "self incrimination", "confrontation clause",
  "keep and bear arms", "public use",
  // criminal procedure
  "probable cause", "reasonable suspicion", "reasonable doubt",
  "beyond a reasonable doubt", "miranda warnings", "custodial interrogation",
  "warrantless search", "warrantless seizure",
  "plain view", "exclusionary rule", "good faith exception",
  "inevitable discovery", "independent source", "exigent circumstances",
  "search incident to arrest", "habeas corpus", "plea bargain",
  "guilty plea", "ineffective assistance of counsel", "excessive force",
  "false arrest", "false imprisonment", "malicious prosecution",
  "section 1983",
  // evidence & procedure
  "summary judgment", "directed verdict", "class action",
  "best evidence", "collateral estoppel",
  "res judicata", "statute of limitations", "statute of frauds",
  "burden of proof", "preponderance of the evidence",
  "clear and convincing evidence",
  "attorney client privilege", "personal jurisdiction",
  "subject matter jurisdiction", "long arm statute",
  "forum non conveniens", "choice of law", "minimum contacts",
  // torts
  // NOTE: "duty of care" deliberately NOT a phrase — measured 2026-08-24:
  // its common-word components ("duty","care") make the phrase form 4.4x
  // slower than loose AND (1,597 ms vs 364 ms rank@20k); loose AND is
  // precision-equivalent here.
  "proximate cause",
  "negligence per se", "res ipsa loquitur", "comparative negligence",
  "contributory negligence", "contributory fault", "assumption of risk",
  "products liability", "strict liability", "punitive damages",
  "compensatory damages", "liquidated damages",
  "informed consent", "medical malpractice", "wrongful death",
  "loss of consortium",
  // contracts & property
  "breach of contract", "promissory estoppel", "parol evidence rule",
  "specific performance", "adverse possession", "eminent domain",
  "just compensation", "regulatory taking", "regulatory takings",
  "qualified immunity", "official immunity",
  // employment, admin, commercial
  "hostile work environment", "disparate impact", "disparate treatment",
  "at will employment", "chevron deference",
  "arbitrary and capricious", "substantial evidence", "notice and comment",
  "rule of reason", "restraint of trade", "public accommodations",
  "fiduciary duty", "business judgment rule",
  "piercing the corporate veil", "joint and several liability",
]);
/** longest dictionary phrase is four words */
const MAX_PHRASE_WORDS = 4;

/**
 * Maximal-munch tokenization: adjacent words forming a dictionary phrase
 * become one FTS5 phrase token; remaining words are standalone terms.
 * Phrase detection runs BEFORE stopword removal so entries like
 * "right to counsel" survive.
 */
export function tokenize(query: string): string[] {
  const words = query.toLowerCase().split(/[^a-z0-9']+/);
  const tokens: string[] = [];
  let i = 0;
  while (i < words.length && tokens.length < 24) {
    let matchedLen = 0;
    for (
      let len = Math.min(MAX_PHRASE_WORDS, words.length - i);
      len >= 2;
      len--
    ) {
      if (PHRASES.has(words.slice(i, i + len).join(" "))) {
        matchedLen = len;
        break;
      }
    }
    if (matchedLen) {
      tokens.push(words.slice(i, i + matchedLen).join(" "));
      i += matchedLen;
    } else {
      const w = words[i];
      if (w.length > 1 && !STOPWORDS.has(w)) tokens.push(w);
      i++;
    }
  }
  return tokens.slice(0, 24);
}

export function matchExpression(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND ");
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

/**
 * Resolve free-text forum ("California", "9th Circuit", "cal") to a court
 * set for filtering. Exact id/jurisdiction/citation-string match first
 * (the CLI path); otherwise a case-insensitive court-NAME match plus the
 * same subtree walk. Returns null when nothing matches — the caller falls
 * back to unfiltered search rather than an empty set, because an
 * unresolvable forum string must cost recall, never all results
 * (jurisdictionCourtIds feeds `return []` on empty, which is correct for
 * an explicit CLI filter but wrong for model-supplied intake text).
 */
export function matchJurisdiction(
  db: Database.Database,
  text: string
): Set<string> | null {
  const exact = jurisdictionCourtIds(db, text);
  if (exact.size > 0) return exact;
  const like = `%${text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  let seeds: Array<{ id: string }>;
  try {
    seeds = db
      .prepare(`SELECT id FROM courts WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE`)
      .all(like) as Array<{ id: string }>;
  } catch {
    return null;
  }
  if (seeds.length === 0) return null;
  const out = new Set<string>();
  const walk = db.prepare(
    `WITH RECURSIVE cs(id) AS (
       SELECT id FROM courts WHERE id = ?
       UNION ALL
       SELECT c.id FROM courts c JOIN cs ON c.parent_id = cs.id
     )
     SELECT id FROM cs`
  );
  for (const s of seeds.slice(0, 25)) {
    for (const r of walk.all(s.id) as Array<{ id: string }>) out.add(r.id);
  }
  return out.size > 0 ? out : null;
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
  blocked: number;
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
                o.blocked,
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
  const d = densityOf(text, tokens, len);
  return d.passage;
}

/**
 * Densest fixed window of query-term occurrences: returns the term count in
 * the best window plus the passage extraction. Shared by extractPassage and
 * the density re-rank so both see identical geometry.
 */
function densityOf(
  text: string,
  tokens: string[],
  len: number
): { passage: Passage; count: number } {
  // Stored text is WS-collapsed to single spaces by the ETL (textclean.WS_RE),
  // but defensively normalise here so phrase tokens like "qualified immunity"
  // (joined by a single space) never miss because hay still contains \n or
  // double spaces on legacy rows (P1-7). Offsets are computed on the
  // collapsed string, so the slice MUST come from the same string — slicing
  // the raw text with collapsed offsets shifts the window left on legacy rows.
  const collapsed = text.replace(/\s+/g, " ");
  const hay = collapsed.toLowerCase();
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
  // end tracks the TRIMMED text exactly: text[start:end] === text must hold
  // for any consumer that slices with these offsets.
  const sliced = collapsed.slice(start, start + len);
  const lead = sliced.length - sliced.trimStart().length;
  const body = sliced.trim();
  return {
    passage: { text: body, start: start + lead, end: start + lead + body.length },
    count: Math.max(0, bestCount),
  };
}

export function search(
  db: Database.Database,
  query: string,
  opts: SearchOptions = {}
): SearchHit[] {
  const T = opts.timings;
  const t0 = T ? performance.now() : 0;
  const mark = (k: keyof SearchTimings, from: number) => {
    if (T) T[k] += performance.now() - from;
  };
  // Clamp: a NaN/negative/zero limit would disable every early-exit below
  // (comparisons against NaN are always false), scan the full 20k ladder,
  // and then slice to nothing.
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 10) || 10), 100);
  let phase = t0;
  const tokens = tokenize(query);
  const expr = matchExpression(tokens);
  if (T) { mark("tokenize_ms", phase); phase = performance.now(); }
  if (!expr) return [];

  const courts =
    opts.jurisdictionIds ??
    (opts.jurisdiction != null
      ? jurisdictionCourtIds(db, opts.jurisdiction)
      : null);
  if (courts && courts.size === 0) return [];

  const statusMarks = SEARCHABLE_STATUS.map(() => "?").join(",");
  if (T) { mark("courts_ms", phase); phase = performance.now(); }

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
    // Zero opinions at this rung: a bigger pool cannot conjure hits for the
    // same expression — but the parenthetical-recall seeds below may still
    // rescue the query. Fall through; never return empty from here.
    if (ranked.length === 0) break;
    let m0 = 0;
    if (T) m0 = performance.now();
    const meta = fetchPool(db, ranked.map((r) => r.id));
    if (T) T.fetch_meta_ms += performance.now() - m0;
    candidates = [];
    for (const r of ranked) {
      const m = meta.get(r.id);
      if (!m) continue; // orphan edge noise cannot happen here, defensive
      if (m.precedential_status == null ||
          !SEARCHABLE_STATUS.includes(m.precedential_status)) continue;
      if (EXCLUDE_BLOCKED && m.blocked) continue; // §9.7 de-indexing honored
      if (courts && (m.court_id == null || !courts.has(m.court_id))) continue;
      m.bm25 = r.bm25;
      candidates.push(m);
    }
    const distinctClusters = new Set(
      candidates.map((c) => c.cluster_id ?? c.id)
    ).size;
    if (distinctClusters >= limit) break;
  }
  if (T) { mark("fts_pool_ms", phase); phase = performance.now(); }

  const boosts = parenBoosts(db, expr);
  if (T) { mark("paren_ms", phase); phase = performance.now(); }

  const scored: Array<{ row: PoolRow; final: number; pb: number; density?: number }> =
    candidates.map((row) => {
      const mult = authorityMultiplier(row);
      const pb = boosts.get(row.id) ?? 0;
      const parenMult = 1 + PAREN_BOOST * Math.log1p(pb);
      const w = (row.ocr ? OCR_WEIGHT : 1) * mult * parenMult;
      return { row, final: -row.bm25 * w, pb };
    });
  scored.sort(
    (a, b) => b.final - a.final || a.row.id - b.row.id
  );

  // Passage-density re-rank (opts.densityRerank): rescan the top organic
  // candidates' text and boost the densest discussion. bm25 sees the whole
  // opinion; this sees where the doctrine actually lives.
  const densityStmt = opts.densityRerank
    ? db.prepare("SELECT text FROM opinions WHERE id = ?")
    : null;
  if (densityStmt && scored.length > 1) {
    const head = scored.slice(0, Math.min(DENSITY_TOP, scored.length));
    for (const s of head) {
      const r = densityStmt.get(s.row.id) as { text: string } | undefined;
      if (!r?.text) continue;
      const { count } = densityOf(r.text, tokens, DENSITY_WINDOW);
      s.density = count;
      s.final = s.final * (1 + DENSITY_WEIGHT * Math.log1p(count));
    }
    scored.sort((a, b) => b.final - a.final || a.row.id - b.row.id);
  }
  if (T) { mark("score_ms", phase); phase = performance.now(); }
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
  // Parenthetical-recall seeds (§3 step 3): gated on doctrine queries —
  // a phrase token present means the query names legal doctrine, which is
  // exactly where vocabulary drift hides landmarks from conjunctive match.
  // With zero ranked candidates the gate is bypassed: any parenthetical
  // match beats an empty result, and there is no precision to protect.
  const hasPhrase = tokens.some((t) => t.includes(" "));
  const seeds: Array<{ row: PoolRow; pb: number; final: number }> = [];
  if (boosts.size > 0 && (hasPhrase || top.length === 0)) {
    const claimed = new Set(seenClusters);
    const descIds = [...boosts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, PAREN_SEED_SCAN)
      .map(([id]) => id);
    const meta = fetchPool(db, descIds);
    for (const id of descIds) {
      if (seeds.length >= Math.min(PAREN_SEED_SLOTS, limit)) break;
      const m = meta.get(id);
      if (!m) continue;
      if (m.precedential_status == null ||
          !SEARCHABLE_STATUS.includes(m.precedential_status)) continue;
      if (EXCLUDE_BLOCKED && m.blocked) continue;
      if (courts && (m.court_id == null || !courts.has(m.court_id))) continue;
      const key = m.cluster_id ?? m.id;
      if (claimed.has(key)) continue;
      claimed.add(key);
      seeds.push({ row: { ...m, bm25: 0 }, pb: boosts.get(id)!, final: 0 });
    }
  }
  if (T) { mark("seeds_ms", phase); phase = performance.now(); }

  // Citation-graph PRF (opts.prf): direct citers of the top organic hits that
  // co-cite >=PRF_MIN_COCITES of them are pulled in as doctrine-family
  // reinforcements. Fills leftover slots only — organic and parenthetical
  // hits are never displaced.
  const prfSeeds: Array<{ row: PoolRow; pb: number; final: number }> = [];
  if (opts.prf && top.length > 0 && top.length < limit) {
    const claimed = new Set(top.map((s) => s.row.cluster_id ?? s.row.id));
    for (const s of seeds) claimed.add(s.row.cluster_id ?? s.row.id);
    const topIds = top.slice(0, Math.min(PRF_TOP, top.length)).map((s) => s.row.id);
    const marks = topIds.map(() => "?").join(",");
    const citers = db
      .prepare(
        `SELECT ci.citing_id AS citing_id, count(DISTINCT ci.cited_id) AS n
           FROM cites ci
          WHERE ci.cited_id IN (${marks}) AND ci.depth = 1
          GROUP BY ci.citing_id
          HAVING n >= ?
          ORDER BY n DESC
          LIMIT ?`
      )
      .all(...topIds, PRF_MIN_COCITES, PRF_CITER_POOL) as Array<{
      citing_id: number;
      n: number;
    }>;
    if (citers.length > 0) {
      const meta = fetchPool(db, citers.map((c) => c.citing_id));
      const budget = Math.min(PRF_SLOTS, limit - top.length - seeds.length);
      for (const c of citers) {
        if (prfSeeds.length >= Math.max(0, budget)) break;
        const m = meta.get(c.citing_id);
        if (!m) continue;
        if (m.precedential_status == null ||
            !SEARCHABLE_STATUS.includes(m.precedential_status)) continue;
        if (EXCLUDE_BLOCKED && m.blocked) continue;
        if (courts && (m.court_id == null || !courts.has(m.court_id))) continue;
        const key = m.cluster_id ?? m.id;
        if (claimed.has(key)) continue;
        claimed.add(key);
        // pb stays 0: co-citation counts must not masquerade as
        // parenthetical_hits (scores.parenthetical_hits is that field alone).
        prfSeeds.push({ row: { ...m, bm25: 0 }, pb: 0, final: 0 });
      }
    }
  }
  if (T) { mark("prf_ms", phase); phase = performance.now(); }

  const merged = [
    ...top.slice(0, Math.max(0, limit - seeds.length - prfSeeds.length)),
    ...seeds,
    ...prfSeeds,
  ];
  const parenIds = new Set(seeds.map((s) => s.row.id));
  const prfIds = new Set(prfSeeds.map((s) => s.row.id));
  const densityById = new Map(
    merged.map((s) => [s.row.id, (s as { density?: number }).density])
  );

  const textStmt = db.prepare("SELECT text FROM opinions WHERE id = ?");
  const out = merged.map(({ row, final, pb }) => {
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
      ...(parenIds.has(row.id) ? { via_parenthetical_recall: true as const } : {}),
      ...(prfIds.has(row.id) ? { via_prf: true as const } : {}),
      ...(densityById.get(row.id) != null
        ? { density: densityById.get(row.id) as number }
        : {}),
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
  if (T) {
    mark("text_ms", phase);
    T.total_ms = performance.now() - t0;
  }
  return out;
}
