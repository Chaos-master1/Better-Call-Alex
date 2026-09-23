/**
 * Shared verifier core — the single implementation of the citation and
 * quote analysis that both bridges feed (docs/verifier.md contract).
 *
 * The sync (verify.ts) and async (verify_async.ts) wrappers differ ONLY in
 * how the eyecite subprocess is invoked. Everything after the bridge result
 * arrives lives here, so a fix lands once. The pre-dedup copies had already
 * drifted on FTS expression construction — proof the split was a bug
 * factory.
 *
 * Contract (docs/verifier.md):
 *   - every full citation must resolve through citation_strings, else
 *     `unresolved_citation` and overall=fail (§5.1);
 *   - every quoted span must match the text of the case it is attributed
 *     to, else `quote_not_found` / `quote_wrong_case` (+ best-effort true
 *     source) and overall=fail (§5.2);
 *   - short/id/supra forms are annotated `unsupported_form`, not rejected
 *     (v1 limitation);
 *   - pin pages are checked against star pagination where the corpus
 *     carries it (`pin_status`: in_range / out_of_range / no_anchors);
 *   - treatment flags are INFERRED signals read from the authority table,
 *     never asserted facts (§5.5);
 *   - [RECORD] sentence ranges passed via `skipQuoteRanges` are the
 *     client's own facts (§5.3): quotes there are user text, not corpus
 *     claims, and are not checked. Citations are still checked everywhere.
 *
 * Unverifiable content is reported, never silently dropped: bridge error
 * entries become `unresolved_citation` checks (overall=fail), not filters.
 */
import type Database from "better-sqlite3";
import {
  resolveCluster,
  normalizePage,
  normalizeReporter,
  normalizeVolume,
  type LookupResult,
} from "../db.js";
import { findQuote, findQuoteGen } from "./quotes.js";
import { parseStarAnchors, checkPin, type StarAnchor } from "./pins.js";
import {
  parseStatuteCites,
  resolveStatute,
  statuteLabel,
  statuteTableExists,
  type StatuteSource,
} from "../statute.js";

export const TREATMENT_LABELS: Array<{ bit: number; label: string }> = [
  { bit: 1, label: "overruled" },
  { bit: 2, label: "abrogated" },
  { bit: 4, label: "distinguished" },
  { bit: 8, label: "but_see" },
  { bit: 16, label: "declined_to_follow" },
];

export interface CitationCheck {
  citation_text: string;
  corrected: string;
  volume: string | null;
  reporter: string | null;
  page: string | null;
  form: string;
  /** char offsets of the citation inside the verified draft text */
  cite_start: number;
  cite_end: number;
  status:
    | "verified"
    | "unresolved_citation"
    | "unsupported_form"
    | "out_of_corpus"
    /** the statute's code/title is not loaded in this corpus at all — the
        cite may be perfectly valid, the corpus just cannot judge it */
    | "statute_not_loaded";
  pin_unverified: boolean;
  /** Rung 3 (star-page anchors): the pin's page falls INSIDE the cited
   *  opinion's anchored page span. Present only when the resolved opinion
   *  text carries star anchors and the cite has a pin; the report still
   *  always exposes pin_unverified for renderers built on v1. */
  pin_status?: "pin_in_range" | "pin_out_of_range" | "pin_no_anchors";
  /** Raw pin string, carried from the bridge for the pin check. */
  cite_pin_raw?: string | null;
  opinion_id?: number;
  cluster_id?: number;
  case_name?: string | null;
  inferred_treatment?: string[];
  /** set when form === "statute": row id in the statutes table (G4) */
  statute_id?: number;
  /** >1 entry: the cite identifies several clusters (probe04: 7.2% of
   *  (vol, rep, page) groups collide). Annotation only — the draft does
   *  not fail; ambiguity is visible to the user and the export. */
  ambiguous_cluster_ids?: number[];
}

/**
 * Reporters the corpus CANNOT carry by construction (independent audit
 * 2026-09-20, probe01: WL cites resolve at 2.65% — the corpus stores
 * published-reporter citations, never Westlaw numbers). A real opinion
 * citing "2020 WL 4673834" cites something that exists; failing it as a
 * suspected FABRICATION is a false strike that punishes honest law.
 * These get `out_of_corpus` (annotation, not rejection) — same family as
 * short-form `unsupported_form`. Anything NOT on this list that fails to
 * resolve stays `unresolved_citation` and fails the draft.
 */
const OUT_OF_CORPUS_REPORTERS = new Set([
  "WL",
  "WESTLAW",
  "LEXIS",
  "LEXSEE",
  "2017 WL", // never matched, but keeps a malformed year-prefixed form safe
]);

export interface QuoteCheck {
  quote: string;
  start: number;
  end: number;
  status: "verified" | "quote_not_found" | "quote_wrong_case" | "unattributed";
  attributed_to_citation_index?: number;
  matched_start?: number;
  matched_end?: number;
  true_source?: {
    case_name: string;
    cluster_id: number;
    opinion_id: number;  /** set when the true source sits INSIDE the cited case's cluster (a
   *  sibling opinion of it — dissent, concurrence, later text), or inside
   *  one of the clusters an ambiguous cite identifies; see the miss-branch
   *  comment in analyzeCitationsAndQuotes */
    within_cluster?: boolean;
  };
}

export interface VerificationReport {
  overall: "pass" | "fail";
  citations: CitationCheck[];
  quotes: QuoteCheck[];
  summary: Record<string, number>;
}

/** One eyecite extraction result; `error` marks a per-text bridge failure. */
export interface BridgeCitation {
  text: string;
  corrected: string;
  volume: string | null;
  reporter: string | null;
  page: string | null;
  type: string;
  pin_cite: string | null;
  /** Supra/name antecedent (eyecite antecedent_guess): the party name a
   *  supra reference points at — matched against the draft's own chain. */
  name?: string | null;
  start: number;
  end: number;
  error?: string;
}

/**
 * Transport-failure entry shared by both bridges. A dead eyecite process
 * must fail the DRAFT (via the bridge_error → unresolved_citation mapping
 * in analyzeCitationsAndQuotes), never the pipeline with an escaping
 * exception — identical shape from sync and async paths.
 */
export function bridgeErrorEntry(detail: string): BridgeCitation {
  return {
    text: "",
    corrected: "",
    volume: null,
    reporter: null,
    page: null,
    type: "bridge_error",
    pin_cite: null,
    start: 0,
    end: 0,
    error: detail.slice(0, 200),
  };
}

export function treatmentLabels(flags: number | null | undefined): string[] {
  if (!flags) return [];
  return TREATMENT_LABELS.filter((t) => flags & t.bit).map((t) => t.label);
}

// Straight and curly double-quote delimiters. /g is required by matchAll.
const SPAN_RE = /["\u201c]([^"\u201c\u201d]{8,2000}?)["\u201d]/g;

// Single-quote delimiters (straight + curly). An apostrophe inside a word
// ("plaintiff's", "don't") can never delimit in either role: the opener
// must follow start/whitespace/opening punctuation and the closer must
// precede whitespace/closing punctuation/end. Without both guards,
// possessive pairs ("dogs' ... cats'") would fake spans and fail real
// text closed (G2 fixture invented_quote_single-15).
const SINGLE_QUOTES = new Set(["'", "‘", "’"]);
const SINGLE_OPENER_BEFORE = /[\s([{'"“‘—–-]/;
const SINGLE_CLOSER_AFTER = /[\s.,;:!?)\]}"”’—–-]/;
/** Quotable shape for a single-quoted span: long enough and multi-word,
 *  so 'n', 's and other apostrophe debris never extract. */
function singleQuotable(inner: string): boolean {
  return inner.length >= 12 && inner.length <= 2000 && /\s/.test(inner);
}

/**
 * Straight + curly double-quoted spans of quotable length, plus guarded
 * single-quoted spans. Newlines are allowed inside spans (block quotes);
 * the lazy bound keeps a stray opening delimiter from swallowing more
 * than one paragraph-ish chunk. A single-quoted span fully enclosed in a
 * double-quoted span is skipped: the outer span already checks the same
 * text, so a second check adds reports, not coverage.
 */
export function extractQuotedSpans(
  text: string
): Array<{ quote: string; start: number; end: number }> {
  const out: Array<{ quote: string; start: number; end: number }> = [];
  const doubleOuter: Array<[number, number]> = [];
  for (const m of text.matchAll(SPAN_RE)) {
    if (m.index === undefined) continue; // unreachable with a /g matchAll
    out.push({
      quote: m[1],
      start: m.index + 1, // past the opening delimiter
      end: m.index + m[0].length - 1, // before the closing delimiter
    });
    doubleOuter.push([m.index, m.index + m[0].length - 1]);
  }
  for (let i = 0; i < text.length; i++) {
    if (!SINGLE_QUOTES.has(text[i])) continue;
    if (i > 0 && !SINGLE_OPENER_BEFORE.test(text[i - 1])) continue;
    // nearest following valid closer (lazy, parallel to the doubles);
    // bounded so pathological quote runs cannot go quadratic.
    for (let j = i + 1; j < text.length && j < i + 2100; j++) {
      if (!SINGLE_QUOTES.has(text[j])) continue;
      if (j + 1 < text.length && !SINGLE_CLOSER_AFTER.test(text[j + 1])) continue;
      if (singleQuotable(text.slice(i + 1, j))) {
        const enclosed = doubleOuter.some(([a, b]) => i >= a && j <= b);
        if (!enclosed) {
          out.push({ quote: text.slice(i + 1, j), start: i + 1, end: j });
        }
      }
      break; // first valid closer wins, even if the span is unquotable
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Distinctive middle run of WHOLE words from a normalized quote, for corpus
 * probing. Character-window cuts produce mid-word shards ("clude" from
 * "exclude") that cannot stem-match — so this selects complete words,
 * staying off the first/last word which may itself be truncated context.
 */
export function probeFragment(quote: string, targetWords = 10): string {
  const q = quote
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const words = q.split(" ").filter((w) => /[a-z0-9]/.test(w));
  if (words.length <= 4) return words.join(" ");
  const n = Math.min(targetWords, words.length - 2);
  const start = Math.max(1, Math.floor((words.length - n) / 2));
  return words.slice(start, start + n).join(" ");
}

function* findTrueSource(
  db: Database.Database,
  quote: string,
  excludeCluster: number | null,
  quoteMemo: Map<string, ReturnType<typeof findQuote>>,
  quoteMemoKey: (sourceText: string, quote: string) => string
): Generator<void, QuoteCheck["true_source"], void> {
  const frag = probeFragment(quote);
  const tokenize = (s: string) =>
    s.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length > 2 && t !== "the");
  const tokens = tokenize(frag);
  if (tokens.length < 3) return undefined;

  // Most distinctive first: the longest terms of the ENTIRE quote beat the
  // middle window — generic prose fragments ("these decisions will advance")
  // never rank a long landmark opinion in any bm25 order.
  const wholeTokens = tokenize(quote);
  const exprs: string[] = [];
  if (wholeTokens.length >= 3) {
    const distinct = [...wholeTokens]
      .sort((a, b) => b.length - a.length)
      .slice(0, Math.min(6, wholeTokens.length));
    exprs.push(ftsPhraseExpr(distinct));
  }
  exprs.push(ftsPhraseExpr(tokens));
  if (tokens.length > 5) {
    // relaxation: the five most distinctive (longest) fragment terms only
    const long = [...tokens].sort((a, b) => b.length - a.length).slice(0, 5);
    exprs.push(ftsPhraseExpr(long));
  }

  const seen = new Set<number>();
  let best: { src: NonNullable<QuoteCheck["true_source"]>; scotus: boolean; pr: number } | null = null;
  // Hard budget: a source probe that verifies 90 candidate texts and still
  // found nothing stops looking — the verdict is already "fail"; this only
  // refines WHERE the quote came from.
  const MAX_CANDIDATES = 90;
  let checked = 0;
  for (const expr of exprs) {
    // Wide scan: rejected-quote attribution is rare, and generic prose
    // fragments rank the true source deep in the bm25 order — so cast a
    // broad net before giving up on identification. The bm25 phrase scan
    // is one synchronous statement over a huge index (measured 0.8–2.1s),
    // so it is its own scheduling unit; the per-database cache means a
    // repeated scan of the same expression skips it entirely. WeakMap so
    // a closed corpus (tests build fresh :memory: DBs per case) drops its
    // entries and results can never leak across databases.
    yield;
    let cache = ftsRankedCache.get(db);
    if (!cache) {
      cache = new Map();
      ftsRankedCache.set(db, cache);
    }
    let ranked = cache.get(expr);
    if (!ranked) {
      ranked = db
        .prepare(
          `SELECT rowid AS id FROM opinions_fts WHERE opinions_fts MATCH ?
           ORDER BY bm25(opinions_fts) LIMIT 60`
        )
        .all(expr) as Array<{ id: number }>;
      cache.set(expr, ranked);
    }
    for (const { id } of ranked) {
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = db
        // §9.7: de-indexed opinions must never surface, even as
        // true-source attribution for a rejected quote.
        .prepare("SELECT id, cluster_id, case_name, court_id FROM opinions WHERE id = ? AND blocked = 0")
        .get(id) as
        | { id: number; cluster_id: number; case_name: string; court_id: string }
        | undefined;
      if (!meta || meta.cluster_id === excludeCluster) continue;
      // The chunked read is exact but may yield internally; the extra
      // yield keeps one scheduling point per candidate regardless.
      const text = yield* readOpinionTextGen(db, id);
      if (text == null) continue;
      checked++;
      yield;
      const pKey = quoteMemoKey(text, quote);
      let m = quoteMemo.get(pKey);
      if (!m) {
        m = yield* findQuoteGen(text, quote);
        quoteMemo.set(pKey, m);
      }
      if (!m.found) continue;
      // Among opinions containing the span verbatim, prefer SCOTUS and
      // higher-authority sources (duplicate texts and quoters exist).
      const prRow = db
        .prepare("SELECT pagerank FROM authority WHERE opinion_id = ?")
        .get(meta.id) as { pagerank: number | null } | undefined;
      const cand = {
        src: {
          case_name: meta.case_name ?? "(unnamed)",
          cluster_id: meta.cluster_id,
          opinion_id: meta.id,
        },
        scotus: meta.court_id === "scotus",
        pr: prRow?.pagerank ?? 0,
      };
      if (
        !best ||
        (cand.scotus && !best.scotus) ||
        (cand.scotus === best.scotus && cand.pr > best.pr)
      ) {
        best = cand;
      }
      if (best.scotus) break; // cannot do better
    }
    // Expressions are ordered most-distinctive-first: once any expression
    // produced a verbatim match, looser ones add IO, not accuracy.
    if (best || checked >= MAX_CANDIDATES) break;
  }
  return best?.src;
}

/** Quote each term for the FTS5 MATCH expression. The parameterized query
 *  (`MATCH ?`) treats the whole string as the expression, never as SQL, and
 *  embedded double quotes are stripped so a term cannot break out of its
 *  own quoting. */
function ftsPhraseExpr(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

/** Per-database cache of expensive pure bm25 ranked scans (see use). */
const ftsRankedCache = new WeakMap<Database.Database, Map<string, Array<{ id: number }>>>();

/** Bytes of opinion text fetched per scheduling unit. */
const OPINION_CHUNK = 1 << 20;

/**
 * Chunked opinion-text read — better-sqlite3 delivers a row in one
 * synchronous gulp, and a multi-megabyte opinion would stall the event
 * loop for the whole blob. `substr` windows make each ~1 MiB its own
 * scheduling unit (the async drain yields between them; the sync drain is
 * uninterrupted and byte-identical). Returns null when the row is absent.
 */
export function* readOpinionTextGen(
  db: Database.Database,
  id: number
): Generator<void, string | null, void> {
  const lenRow = db
    .prepare("SELECT length(text) AS len FROM opinions WHERE id = ?")
    .get(id) as { len: number | null } | undefined;
  if (!lenRow || lenRow.len == null) return null;
  const total = lenRow.len;
  if (total <= OPINION_CHUNK) {
    const row = db
      .prepare("SELECT text FROM opinions WHERE id = ?")
      .get(id) as { text: string } | undefined;
    return row?.text ?? null;
  }
  const stmt = db.prepare(
    "SELECT substr(text, ?, ?) AS chunk FROM opinions WHERE id = ?"
  );
  let out = "";
  for (let pos = 1; pos <= total; pos += OPINION_CHUNK) {
    const { chunk } = stmt.get(pos, OPINION_CHUNK, id) as { chunk: string };
    out += chunk;
    yield;
  }
  return out;
}

/**
 * Short-form resolution (Phase B rung 1) — ANTECEDENT-ONLY, by design.
 *
 * A short form ("389 U.S., at 351") resolves when the nearest PRECEDING
 * verified full citation carries the same (volume, reporter): the draft
 * itself established the referent, so resolution is not a guess.
 *
 * Deliberately ABSENT: matching the short form's page against corpus
 * first-pages. A short form's page is a PIN, not a first page — a pin that
 * coincides with some other case's first page would silently attach the
 * WRONG authority, which is worse than an annotation. No fuzzy matching:
 * a wrong resolution is the only unacceptable outcome.
 */
function resolveShortForm(
  volume: string | null,
  reporter: string | null,
  antecedent: CitationCheck | undefined
): Pick<LookupResult, "cluster_id" | "opinion_id" | "case_name"> | null {
  if (!volume || !reporter) return null;
  if (
    antecedent &&
    antecedent.status === "verified" &&
    antecedent.volume != null &&
    antecedent.reporter != null &&
    normalizeVolume(antecedent.volume) === normalizeVolume(volume) &&
    normalizeReporter(antecedent.reporter) === normalizeReporter(reporter)
  ) {
    return {
      cluster_id: antecedent.cluster_id!,
      opinion_id: antecedent.opinion_id!,
      case_name: antecedent.case_name ?? null,
    };
  }
  return null;
}

export interface AnalyzeOptions {
  /** Char ranges (e.g. [RECORD] sentences) whose quoted spans are the
   *  client's own facts, not corpus claims — quote checks are skipped for
   *  spans FULLY INSIDE a range. A span merely touching a range boundary
   *  is still checked: a quote opened in argued text must never launder
   *  through a neighboring RECORD sentence. Citations resolve everywhere. */
  skipQuoteRanges?: Array<[number, number]>;
}

function inSkippedRange(
  start: number,
  end: number,
  ranges: Array<[number, number]> | undefined
): boolean {
  if (!ranges || ranges.length === 0) return false;
  return ranges.some(([a, b]) => start >= a && end <= b);
}

/**
 * Analyze bridge output against the corpus: resolve citations, attribute
 * and check quotes, emit the verdict. Called with the bridge's RAW result
 * entries — an entry carrying `error` becomes an `unresolved_citation`
 * check so a failed extraction fails the draft instead of vanishing.
 */
/** FNV-1a — memo keys only; never security-relevant. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function* analyzeCitationsAndQuotesGen(
  db: Database.Database,
  extracted: BridgeCitation[],
  text: string,
  opts: AnalyzeOptions = {}
): Generator<void, VerificationReport, void> {
  // Per-analysis memo: identical quote spans (verbatim repeats, a draft
  // leaning on one authority) must not pay for the same source scan twice.
  // Scoped to this call so results can never leak across corpora.
  const quoteMemo = new Map<string, ReturnType<typeof findQuote>>();
  const quoteMemoKey = (sourceText: string, quote: string) =>
    `${quote}\u0000${sourceText.length}:${sourceText.length > 512 ? hashString(sourceText) : sourceText}`;
  const trueSourceMemo = new Map<string, QuoteCheck["true_source"]>();
  // Per-analysis opinion-text memo (id → text): the quote ladder and the
  // pin checks both read opinion texts; a draft leaning on one authority
  // must not re-read (nor re-parse anchors of) a multi-MB opinion.
  const textMemo = new Map<number, string | null>();
  const readOpinionMemoized = function* (
    id: number
  ): Generator<void, string | null, void> {
    if (textMemo.has(id)) return textMemo.get(id)!;
    const text = yield* readOpinionTextGen(db, id);
    textMemo.set(id, text);
    return text;
  };
  const anchorsMemo = new Map<number, StarAnchor[]>();
  function* anchorsFor(id: number): Generator<void, StarAnchor[], void> {
    if (anchorsMemo.has(id)) return anchorsMemo.get(id)!;
    const text = yield* readOpinionMemoized(id);
    const anchors = text ? parseStarAnchors(text) : [];
    anchorsMemo.set(id, anchors);
    return anchors;
  }
  /** Rung 3: attach pin_status to a RESOLVED case citation carrying a pin. */
  function* checkPinFor(
    citation: CitationCheck,
    opinionId: number
  ): Generator<void, void, void> {
    const anchors = yield* anchorsFor(opinionId);
    const ps = checkPin(citation.cite_pin_raw ?? null, null, anchors);
    if (ps === "pin_in_range" || ps === "pin_out_of_range" || ps === "pin_no_anchors") {
      citation.pin_status = ps;
    }
  }

  // ---- citations ---------------------------------------------------------
  const citations: CitationCheck[] = [];
  // Statutory cites (G4): eyecite does not carry them, so they are detected
  // against the full-form pattern and resolved from the statutes table.
  // When the G4 ETL has not run, statutory verification stays off and the
  // eyecite-only behavior applies unchanged.
  const hasStatutes = statuteTableExists(db);
  const statuteHits = hasStatutes ? parseStatuteCites(text) : [];
  // Title-existence probe for the statute_not_loaded split (indexed by the
  // UNIQUE(source,title,…) key — O(1), never a scan).
  const statuteTitleStmt = hasStatutes
    ? db.prepare("SELECT 1 FROM statutes WHERE source = ? AND title = ? LIMIT 1")
    : null;
  const overlapsStatute = (start: number, end: number): boolean =>
    statuteHits.some((s) => start < s.end && end > s.start);
  // Extraction noise (live A/B draft, 2026-09-23): eyecite's UnknownCitation
  // regex surfaces BARE section symbols — "§" with no title, section, or any
  // other content — as citations. They carry no citation semantics, flood
  // resolution denominators (12 of 20 cites in one real draft), and render
  // as meaningless rows. A bare symbol is a tokenizer artifact, not an
  // unverifiable cite; real statutory cites ("42 U.S.C. § 1983") carry
  // content and ride the G4 statute path untouched.
  const isBareSectionArtifact = (c: BridgeCitation): boolean =>
    c.type === "unknown" && /^[\s§]*$/.test(c.text);

  // Nearest preceding RESOLVED full citation — the antecedent that gives
  // short/Id./supra forms their referent under chain semantics.
  let lastFull: CitationCheck | undefined;
  // Every verified full/short resolution so far — the chain a supra NAME
  // may point into.
  const resolvedChain: CitationCheck[] = [];
  /** Supra-name match: the antecedent_guess (usually a surname) must be
   *  CONTAINED in a resolved antecedent's case name, case-insensitively.
   *  Containment, never equality or fuzz: "Roe" ⊆ "Roe v. Wade". */
  const resolveSupraByName = (
    name: string
  ): Pick<LookupResult, "cluster_id" | "opinion_id" | "case_name"> | null => {
    const needle = name.trim().toLowerCase();
    if (needle.length < 3) return null;
    for (let i = resolvedChain.length - 1; i >= 0; i--) {
      const cn = (resolvedChain[i].case_name ?? "").toLowerCase();
      if (cn.includes(needle)) {
        const a = resolvedChain[i];
        return {
          cluster_id: a.cluster_id!,
          opinion_id: a.opinion_id!,
          case_name: a.case_name ?? null,
        };
      }
    }
    return null;
  };
  for (const c of extracted) {
    yield; // cooperative scheduling point (see async drain)
    if (c.error) {
      // One bad draft must not fail a batch — but it must not pass
      // silently either. Surface it as an unresolvable citation.
      citations.push({
        citation_text: `(citation extraction failed: ${String(c.error).slice(0, 120)})`,
        corrected: "",
        volume: null,
        reporter: null,
        page: null,
        form: "bridge_error",
        cite_start: 0,
        cite_end: 0,
        status: "unresolved_citation",
        pin_unverified: false,
      });
      continue;
    }
    // A span inside a full statutory cite is superseded by the statute
    // check below — reporting both would double-fail the same reference.
    if (overlapsStatute(c.start, c.end)) continue;
    // Bare-§ tokenizer artifacts are noise, not citations — skip entirely
    // (they are not reported, because there is nothing to verify).
    if (isBareSectionArtifact(c)) continue;
    // Spans ride ON the check object: parallel-array indexing against the
    // input would silently desync.
    if (c.type !== "full") {
      // Phase B rung 1: Id. and short forms resolve through the draft's
      // own antecedent (see resolveShortForm / the id branch below). No
      // resolution → the v1 honest annotation stands.
      const shortRes =
        c.type === "id"
          ? // "Id." refers to the IMMEDIATELY preceding citation by
            // definition; it resolves only when that antecedent verified —
            // a broken chain lends no authority.
            lastFull && lastFull.status === "verified"
            ? {
                cluster_id: lastFull.cluster_id!,
                opinion_id: lastFull.opinion_id!,
                case_name: lastFull.case_name ?? null,
              }
            : null
          : c.type === "supra" && c.name
          ? // Supra: the NAME is the referent. Match it against the party
            // names of the draft's own RESOLVED antecedents (chainScan).
            // Conservative containment: the antecedent_guess is a surname
            // fragment, so it must appear inside a resolved antecedent's
            // name — never the reverse, never fuzzy.
            resolveSupraByName(c.name)
          : resolveShortForm(c.volume, c.reporter, lastFull);
      if (shortRes) {
        const auth = db
          .prepare(
            `SELECT max(a.treatment_flags) AS flags FROM authority a
             JOIN opinions o ON o.id = a.opinion_id WHERE o.cluster_id = ?`
          )
          .get(shortRes.cluster_id) as { flags: number | null } | undefined;
        citations.push({
          citation_text: c.text,
          corrected: c.corrected,
          volume: c.volume,
          reporter: c.reporter,
          page: c.page,
          form: c.type,
          cite_start: c.start,
          cite_end: c.end,
          status: "verified",
          pin_unverified: c.pin_cite != null,
          cite_pin_raw: c.pin_cite,
          opinion_id: shortRes.opinion_id,
          cluster_id: shortRes.cluster_id,
          case_name: shortRes.case_name,
          inferred_treatment: treatmentLabels(auth?.flags),
        });
        if (c.pin_cite) yield* checkPinFor(citations[citations.length - 1], shortRes.opinion_id);
        resolvedChain.push(citations[citations.length - 1]);
        continue;
      }
      citations.push({
        citation_text: c.text,
        corrected: c.corrected,
        volume: c.volume,
        reporter: c.reporter,
        page: c.page,
        form: c.type,
        cite_start: c.start,
        cite_end: c.end,
        status: "unsupported_form",
        pin_unverified: c.pin_cite != null,
      });
      continue;
    }
    // Pin pages ride through: resolveCluster normalizes to leading digits
    // ("113-114" → "113"). Never strip non-digits first — that mangles a
    // range into a different page ("113-114" → "113114", unresolvable).
    const res: LookupResult | null = resolveCluster(
      db,
      c.volume ?? "",
      c.reporter ?? "",
      c.page ?? ""
    );
    if (!res) {
      // A full cite that fails to resolve must NOT become the antecedent
      // for later short forms — a broken chain cannot lend authority.
      lastFull = undefined;
      // Out-of-corpus reporters (WL/Lexis): unresolvable BY CONSTRUCTION,
      // not evidence of fabrication. Annotate, do not fail — the corpus
      // will never carry these numbers (probe01: WL resolve rate 2.65%,
      // 415 cites sampled). Every other unresolved cite still fails.
      const rep = (c.reporter ?? "").trim().toUpperCase();
      if (OUT_OF_CORPUS_REPORTERS.has(rep)) {
        citations.push({
          citation_text: c.text,
          corrected: c.corrected,
          volume: c.volume,
          reporter: c.reporter,
          page: c.page,
          form: c.type,
          cite_start: c.start,
          cite_end: c.end,
          status: "out_of_corpus",
          pin_unverified: c.pin_cite != null,
        });
        continue;
      }
      citations.push({
        citation_text: c.text,
        corrected: c.corrected,
        volume: c.volume,
        reporter: c.reporter,
        page: c.page,
        form: c.type,
        cite_start: c.start,
        cite_end: c.end,
        status: "unresolved_citation",
        pin_unverified: c.pin_cite != null,
      });
      continue;
    }
    // Treatment aggregates at CLUSTER level: citing texts point at whichever
    // opinion id they referenced (often a legacy duplicate), and treatment
    // attaches to the case, not one text of it.
    const auth = db
      .prepare(
        `SELECT max(a.treatment_flags) AS flags FROM authority a
         JOIN opinions o ON o.id = a.opinion_id WHERE o.cluster_id = ?`
      )
      .get(res.cluster_id) as { flags: number | null } | undefined;
    citations.push({
      citation_text: c.text,
      corrected: c.corrected,
      volume: c.volume,
      reporter: c.reporter,
      page: c.page,
      form: c.type,
      cite_start: c.start,
      cite_end: c.end,
      status: "verified",
      pin_unverified: c.pin_cite != null,
      cite_pin_raw: c.pin_cite,
      opinion_id: res.opinion_id,
      cluster_id: res.cluster_id,
      case_name: res.case_name,
      inferred_treatment: treatmentLabels(auth?.flags),
      ...(res.all_cluster_ids && res.all_cluster_ids.length > 1
        ? { ambiguous_cluster_ids: res.all_cluster_ids }
        : {}),
    });
    // Rung 3: pin check rides the resolution — the anchors parse from the
    // (memoized) opinion text.
    if (c.pin_cite) {
      yield* checkPinFor(citations[citations.length - 1], res.opinion_id);
    }
    // The antecedent for later short forms: only a RESOLVED, UNAMBIGUOUS
    // full cite can lend its identity to "at 351" / "Id." references.
    if (!(res.all_cluster_ids && res.all_cluster_ids.length > 1)) {
      lastFull = citations[citations.length - 1];
      resolvedChain.push(lastFull);
    }
  }

  // Statutory citations, resolved against the statutes table. A quoted
  // statute is checked by the quote ladder below, attributed to this check.
  for (const s of statuteHits) {
    yield;
    const row = resolveStatute(db, s.source, s.title, s.section);
    const reporter = s.source === ("usc" as StatuteSource) ? "U.S.C." : "C.F.R.";
    // A subsection pin ("§ 1983(a)") rides after the cite; like case pin
    // pages it is annotated, not verified (v1).
    const pinFollows = /^\s*\(/.test(text.slice(s.end));
    // Distinguish a wrong cite from a data gap: if the title exists but the
    // section doesn't, the miss is the cite; if the whole title is absent
    // (this corpus loads eCFR only, no US Code), the corpus cannot judge
    // the cite and says so instead of implying the cite is wrong.
    const titleLoaded = row
      ? true
      : statuteTitleStmt
        ? statuteTitleStmt.get(s.source, s.title) != null
        : false;
    citations.push({
      citation_text: s.text,
      corrected: s.text,
      volume: s.title,
      reporter,
      page: s.section,
      form: "statute",
      cite_start: s.start,
      cite_end: s.end,
      status: row ? "verified" : titleLoaded ? "unresolved_citation" : "statute_not_loaded",
      pin_unverified: pinFollows,
      ...(row ? { statute_id: row.id, case_name: `${statuteLabel(row)} — ${row.heading}` } : {}),
    });
  }

  // ---- quotes -------------------------------------------------------------
  const spans = extractQuotedSpans(text);
  const quotes: QuoteCheck[] = [];
  for (const span of spans) {
    yield;
    // [RECORD] content quotes the client's own facts; it is not a corpus
    // claim (§5.3) and has no citation to attribute to.
    if (inSkippedRange(span.start, span.end, opts.skipQuoteRanges)) continue;

    // attribution: nearest preceding verified citation (case or statute),
    // else nearest following one within 300 chars (leading-quote style).
    let target: CitationCheck | undefined;
    let idx = -1;
    for (let i = citations.length - 1; i >= 0; i--) {
      const c = citations[i];
      if (
        (c.form === "full" || c.form === "statute") &&
        c.status === "verified" &&
        c.cite_end <= span.start
      ) {
        target = c;
        idx = i;
        break;
      }
    }
    if (!target) {
      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        if (
          (c.form === "full" || c.form === "statute") &&
          c.status === "verified" &&
          c.cite_start >= span.end &&
          c.cite_start - span.end <= 300
        ) {
          target = c;
          idx = i;
          break;
        }
      }
    }

    if (!target || (target.opinion_id == null && target.statute_id == null)) {
      quotes.push({
        quote: span.quote,
        start: span.start,
        end: span.end,
        status: "unattributed",
      });
      continue;
    }

    let sourceText = "";
    if (target.statute_id != null) {
      const row = db
        .prepare("SELECT text FROM statutes WHERE id = ?")
        .get(target.statute_id) as { text: string } | undefined;
      sourceText = row?.text ?? "";
    } else {
      const loaded = yield* readOpinionTextGen(db, target.opinion_id!);
      sourceText = loaded ?? "";
    }
    const mKey = quoteMemoKey(sourceText, span.quote);
    let m = quoteMemo.get(mKey);
    if (!m) {
      m = yield* findQuoteGen(sourceText, span.quote);
      quoteMemo.set(mKey, m);
    }
    if (m.found) {
      quotes.push({
        quote: span.quote,
        start: span.start,
        end: span.end,
        status: "verified",
        attributed_to_citation_index: idx,
        matched_start: m.start,
        matched_end: m.end,
      });
      continue;
    }
    // Sibling-opinion verification (audit probe02 rerun 2026-09-21): the
    // corpus's identity of "a case" is the CLUSTER (resolveCluster returns
    // one; case names are per-cluster), so a real quote of the cited case
    // can live in ANY of its opinions — a dissent, concurrence, or companion
    // text — and in any cluster an AMBIGUOUS cite identifies (probe04: 7.2%
    // of (vol, rep, page) groups collide). Verify with honest provenance
    // (within_cluster) instead of striking real law; only a quote that
    // exists NOWHERE in the clusters the cite identifies can be a
    // wrong-case quote. The earlier "downgrade to quote_not_found" design
    // still failed real quotes: probe02's positive controls carried
    // quote_not_found|cite:ok ×12 after that fix.
    const clusterIds = target.cluster_id != null
      ? [...new Set([target.cluster_id, ...(target.ambiguous_cluster_ids ?? [])])]
      : [];
    let sibVerified = false;
    if (target.statute_id == null && clusterIds.length > 0) {
      const placeholders = clusterIds.map(() => "?").join(",");
      // Ids only — texts load through the chunked reader below (one blob
      // per scheduling unit) instead of one giant synchronous .all().
      const sibs = db
        .prepare(
          `SELECT id, cluster_id, case_name FROM opinions
           WHERE cluster_id IN (${placeholders}) AND id != ? AND blocked = 0`
        )
        .all(...clusterIds, target.opinion_id) as Array<{
        id: number;
        cluster_id: number;
        case_name: string | null;
      }>;
      // Sibling candidates are the cluster's LIVE opinions: verification
      // never silently relies on de-indexed (blocked) text — same contract
      // as findTrueSource, which never names a blocked opinion.
      for (const sib of sibs) {
        // One sibling opinion is one scheduling unit — its chunked read
        // plus findQuote may each yield internally.
        yield;
        const text = yield* readOpinionTextGen(db, sib.id);
        if (text == null) continue;
        const sKey = quoteMemoKey(text, span.quote);
        let sm = quoteMemo.get(sKey);
        if (!sm) {
          sm = yield* findQuoteGen(text, span.quote);
          quoteMemo.set(sKey, sm);
        }
        if (!sm.found) continue;
        quotes.push({
          quote: span.quote,
          start: span.start,
          end: span.end,
          status: "verified",
          attributed_to_citation_index: idx,
          matched_start: sm.start,
          matched_end: sm.end,
          true_source: {
            case_name: sib.case_name ?? "case name unavailable",
            cluster_id: sib.cluster_id,
            opinion_id: sib.id,
            within_cluster: true,
          },
        });
        sibVerified = true;
        break;
      }
    }
    if (sibVerified) continue;
    // True-source probing is an opinion-text concern; a statute quote that
    // does not match its section simply failed. What remains after the
    // cluster search is a quote no live opinion of the cited cluster
    // contains in clean form:
    //   • the span exists in the cited cluster but only in vetoed form
    //     (e.g. every occurrence negator-shed) → quote_not_found with
    //     within_cluster provenance — the clean sentence is not the law
    //     of this case, which is exactly what the user must hear;
    //   • the corpus has the span in some OTHER case → quote_wrong_case
    //     (fail with the true source shown);
    //   • nowhere at all → plain quote_not_found.
    let source: QuoteCheck["true_source"];
    if (target.statute_id != null) {
      source = undefined;
    } else {
      // Memoized true-source probing: a draft that fails N quotes of the
      // same span probes N×90 candidates — identical work each time.
      const key = `${span.quote}\u0000`;
      if (trueSourceMemo.has(key)) {
        source = trueSourceMemo.get(key);
      } else {
        source = yield* findTrueSource(db, span.quote, null, quoteMemo, quoteMemoKey);
        trueSourceMemo.set(key, source);
      }
    }
    if (source && clusterIds.includes(source.cluster_id)) {
      quotes.push({
        quote: span.quote,
        start: span.start,
        end: span.end,
        status: "quote_not_found",
        attributed_to_citation_index: idx,
        true_source: { ...source, within_cluster: true },
      });
      continue;
    }
    quotes.push({
      quote: span.quote,
      start: span.start,
      end: span.end,
      status: source ? "quote_wrong_case" : "quote_not_found",
      attributed_to_citation_index: idx,
      ...(source ? { true_source: source } : {}),
    });
  }

  // ---- verdict ------------------------------------------------------------
  const summary: Record<string, number> = {};
  for (const c of citations) summary[`citation:${c.status}`] = (summary[`citation:${c.status}`] ?? 0) + 1;
  for (const q of quotes) summary[`quote:${q.status}`] = (summary[`quote:${q.status}`] ?? 0) + 1;

  const anyUnresolved = citations.some((c) => c.status === "unresolved_citation");
  const anyQuoteFail = quotes.some(
    (q) =>
      q.status === "quote_not_found" ||
      q.status === "quote_wrong_case" ||
      q.status === "unattributed"
  );

  return {
    overall: anyUnresolved || anyQuoteFail ? "fail" : "pass",
    citations,
    quotes,
    summary,
  };
}

/**
 * Sync drain — byte-identical to running the analysis as one direct
 * function (tests, G2 evals, offline audits all keep this contract).
 */
export function analyzeCitationsAndQuotes(
  db: Database.Database,
  extracted: BridgeCitation[],
  text: string,
  opts: AnalyzeOptions = {}
): VerificationReport {
  const gen = analyzeCitationsAndQuotesGen(db, extracted, text, opts);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/**
 * Cooperative drain — same result, but the event loop gets a turn between
 * analysis units, so a large verification (CiteGuard, the pipeline) can no
 * longer pin the single-threaded server for the full duration.
 */
export async function analyzeCitationsAndQuotesAsync(
  db: Database.Database,
  extracted: BridgeCitation[],
  text: string,
  opts: AnalyzeOptions = {}
): Promise<VerificationReport> {
  const gen = analyzeCitationsAndQuotesGen(db, extracted, text, opts);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
