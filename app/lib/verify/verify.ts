/**
 * The G2 Verifier (CLAUDE.md §3). Pure code — no LLM.
 *
 * Contract (docs/verifier.md):
 *   - every full citation must resolve through citation_strings, else
 *     `unresolved_citation` and overall=fail (§5.1);
 *   - every quoted span must match the text of the case it is attributed
 *     to, else `quote_not_found` / `quote_wrong_case` (+ best-effort true
 *     source) and overall=fail (§5.2);
 *   - short/id/supra forms are annotated `unsupported_form`, not rejected
 *     (v1 limitation);
 *   - pin pages are never verified (the corpus has no star pagination) —
 *     annotated `pin_unverified`;
 *   - treatment flags are INFERRED signals read from the authority table,
 *     never asserted facts (§5.5).
 *
 * Unverifiable content is reported, never silently dropped. Struck-through
 * rendering is G3's job; this module emits the report it renders.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  resolveCluster,
  type LookupResult,
} from "../db.js";
import { findQuote } from "./quotes.js";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const BRIDGE = path.join(REPO, "verifier", "bridge.py");

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
  status: "verified" | "unresolved_citation" | "unsupported_form";
  pin_unverified: boolean;
  opinion_id?: number;
  cluster_id?: number;
  case_name?: string | null;
  inferred_treatment?: string[];
}

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
    opinion_id: number;
  };
}

export interface VerificationReport {
  overall: "pass" | "fail";
  citations: CitationCheck[];
  quotes: QuoteCheck[];
  summary: Record<string, number>;
}

interface BridgeCitation {
  text: string;
  corrected: string;
  volume: string | null;
  reporter: string | null;
  page: string | null;
  type: string;
  pin_cite: string | null;
  start: number;
  end: number;
  error?: string;
}

function pythonBin(): string {
  if (process.env.VERIFY_PYTHON) return process.env.VERIFY_PYTHON;
  const venv = path.join(REPO, ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return "python3";
}

function runBridge(text: string): BridgeCitation[] {
  const proc = spawnSync(pythonBin(), [BRIDGE], {
    input: JSON.stringify({ texts: [text] }),
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    throw new Error(`eyecite bridge failed (${proc.status}): ${proc.stderr?.slice(-400)}`);
  }
  const payload = JSON.parse(proc.stdout!) as {
    results: Array<BridgeCitation[] | Array<{ error: string }>>;
    error?: string;
  };
  if (payload.error) throw new Error(`bridge protocol: ${payload.error}`);
  const first = payload.results[0] ?? [];
  return first.filter((c): c is BridgeCitation => !("error" in c));
}

/**
 * Straight + curly double-quoted spans of quotable length. Newlines are
 * allowed inside spans (block quotes); the lazy bound keeps a stray
 * opening delimiter from swallowing more than one paragraph-ish chunk.
 */
export function extractQuotedSpans(
  text: string
): Array<{ quote: string; start: number; end: number }> {
  const out: Array<{ quote: string; start: number; end: number }> = [];
  const re = /["\u201c]([^"\u201c\u201d]{8,2000}?)["\u201d]/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      quote: m[1],
      start: m.index + 1, // past the opening delimiter
      end: m.index + m[0].length - 1, // before the closing delimiter
    });
  }
  return out;
}

function treatmentLabels(flags: number | null | undefined): string[] {
  if (!flags) return [];
  return TREATMENT_LABELS.filter((t) => flags & t.bit).map((t) => t.label);
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

function findTrueSource(
  db: Database.Database,
  quote: string,
  excludeCluster: number | null
): QuoteCheck["true_source"] {
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
    exprs.push(distinct.map((t) => `"${t.replace(/"/g, "")}"`).join(" "));
  }
  exprs.push(tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" "));
  if (tokens.length > 5) {
    // relaxation: the five most distinctive (longest) fragment terms only
    const long = [...tokens].sort((a, b) => b.length - a.length).slice(0, 5);
    exprs.push(long.map((t) => `"${t.replace(/"/g, "")}"`).join(" "));
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
    // broad net before giving up on identification.
    const ranked = db
      .prepare(
        `SELECT rowid AS id FROM opinions_fts WHERE opinions_fts MATCH ?
         ORDER BY bm25(opinions_fts) LIMIT 60`
      )
      .all(expr) as Array<{ id: number }>;
    for (const { id } of ranked) {
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = db
        .prepare("SELECT id, cluster_id, case_name, court_id FROM opinions WHERE id = ?")
        .get(id) as
        | { id: number; cluster_id: number; case_name: string; court_id: string }
        | undefined;
      if (!meta || meta.cluster_id === excludeCluster) continue;
      const row = db.prepare("SELECT text FROM opinions WHERE id = ?").get(id) as
        | { text: string }
        | undefined;
      if (!row) continue;
      checked++;
      const m = findQuote(row.text, quote);
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

export function verifyText(db: Database.Database, text: string): VerificationReport {
  const extracted = runBridge(text);

  // ---- citations ---------------------------------------------------------
  const citations: CitationCheck[] = [];
  for (const c of extracted) {
    // Spans ride ON the check object: bridge error entries are filtered
    // upstream, so parallel-array indexing here would silently desync.
    if (c.type !== "full") {
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
    const res: LookupResult | null = resolveCluster(
      db,
      c.volume ?? "",
      c.reporter ?? "",
      (c.page ?? "").replace(/[^\d]/g, "") || c.page || ""
    );
    if (!res) {
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
      opinion_id: res.opinion_id,
      cluster_id: res.cluster_id,
      case_name: res.case_name,
      inferred_treatment: treatmentLabels(auth?.flags),
    });
  }

  // ---- quotes -------------------------------------------------------------
  const spans = extractQuotedSpans(text);
  const quotes: QuoteCheck[] = [];
  for (const span of spans) {
    // attribution: nearest preceding full+verified citation, else nearest
    // following one within 300 chars (leading-quote style).
    let target: CitationCheck | undefined;
    let idx = -1;
    for (let i = citations.length - 1; i >= 0; i--) {
      const c = citations[i];
      if (
        c.form === "full" &&
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
          c.form === "full" &&
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

    if (!target || target.opinion_id == null) {
      quotes.push({
        quote: span.quote,
        start: span.start,
        end: span.end,
        status: "unattributed",
      });
      continue;
    }

    const row = db
      .prepare("SELECT text FROM opinions WHERE id = ?")
      .get(target.opinion_id) as { text: string } | undefined;
    const opinionText = row?.text ?? "";
    const m = findQuote(opinionText, span.quote);
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
    const source = findTrueSource(db, span.quote, target.cluster_id ?? null);
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
