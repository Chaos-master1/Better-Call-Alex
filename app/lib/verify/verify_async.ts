/**
 * Async wrapper for the G2 Verifier — uses child_process.spawn instead of
 * spawnSync so the Next.js request thread is not blocked while Python/eyecite
 * imports (~0.3s). The sync `verifyText` in verify.ts remains the canonical
 * implementation for CLI and evals.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { resolveRepo } from "../repo.js";
import { findQuote } from "./quotes.js";
import {
  TREATMENT_LABELS,
  extractQuotedSpans,
  probeFragment,
  type CitationCheck,
  type QuoteCheck,
  type VerificationReport,
} from "./verify.js";
import { resolveCluster, type LookupResult } from "../db.js";

const REPO = resolveRepo();
const BRIDGE = path.join(REPO, "verifier", "bridge.py");

function pythonBin(): string {
  if (process.env.VERIFY_PYTHON) return process.env.VERIFY_PYTHON;
  const venv = path.join(REPO, ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return "python3";
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

function runBridgeAsync(text: string): Promise<BridgeCitation[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin(), [BRIDGE]);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, 120_000);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("eyecite bridge timeout after 120s"));
      if (code !== 0) {
        return reject(new Error(`eyecite bridge failed (${code}): ${stderr.slice(-400)}`));
      }
      try {
        const payload = JSON.parse(stdout) as {
          results: Array<BridgeCitation[] | Array<{ error: string }>>;
          error?: string;
        };
        if (payload.error) return reject(new Error(`bridge protocol: ${payload.error}`));
        const first = payload.results[0] ?? [];
        resolve(first.filter((c): c is BridgeCitation => !("error" in c)));
      } catch (e) {
        reject(e);
      }
    });
    proc.stdin.write(JSON.stringify({ texts: [text] }));
    proc.stdin.end();
  });
}

function treatmentLabels(flags: number | null | undefined): string[] {
  if (!flags) return [];
  return TREATMENT_LABELS.filter((t) => flags & t.bit).map((t) => t.label);
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
  const wholeTokens = tokenize(quote);
  const exprs: string[] = [];
  if (wholeTokens.length >= 3) {
    const distinct = [...wholeTokens].sort((a, b) => b.length - a.length).slice(0, Math.min(6, wholeTokens.length));
    exprs.push(distinct.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND "));
  }
  exprs.push(tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND "));
  if (tokens.length > 5) {
    const long = [...tokens].sort((a, b) => b.length - a.length).slice(0, 5);
    exprs.push(long.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND "));
  }
  const seen = new Set<number>();
  let best: { src: NonNullable<QuoteCheck["true_source"]>; scotus: boolean; pr: number } | null = null;
  const MAX_CANDIDATES = 90;
  let checked = 0;
  for (const expr of exprs) {
    const ranked = db
      .prepare(`SELECT rowid AS id FROM opinions_fts WHERE opinions_fts MATCH ? ORDER BY bm25(opinions_fts) LIMIT 60`)
      .all(expr) as Array<{ id: number }>;
    for (const { id } of ranked) {
      if (seen.has(id)) continue;
      seen.add(id);
      const meta = db.prepare("SELECT id, cluster_id, case_name, court_id FROM opinions WHERE id = ?").get(id) as
        | { id: number; cluster_id: number; case_name: string; court_id: string }
        | undefined;
      if (!meta || meta.cluster_id === excludeCluster) continue;
      const row = db.prepare("SELECT text FROM opinions WHERE id = ?").get(id) as { text: string } | undefined;
      if (!row) continue;
      checked++;
      const m = findQuote(row.text, quote);
      if (!m.found) continue;
      const prRow = db.prepare("SELECT pagerank FROM authority WHERE opinion_id = ?").get(meta.id) as { pagerank: number | null } | undefined;
      const cand = {
        src: { case_name: meta.case_name ?? "(unnamed)", cluster_id: meta.cluster_id, opinion_id: meta.id },
        scotus: meta.court_id === "scotus",
        pr: prRow?.pagerank ?? 0,
      };
      if (!best || (cand.scotus && !best.scotus) || (cand.scotus === best.scotus && cand.pr > best.pr)) {
        best = cand;
      }
      if (best.scotus) break;
    }
    if (best || checked >= MAX_CANDIDATES) break;
  }
  return best?.src;
}

export async function verifyTextAsync(db: Database.Database, text: string): Promise<VerificationReport> {
  const extracted = await runBridgeAsync(text);
  const citations: CitationCheck[] = [];
  for (const c of extracted) {
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
    const res: LookupResult | null = resolveCluster(db, c.volume ?? "", c.reporter ?? "", (c.page ?? "").replace(/[^\d]/g, "") || c.page || "");
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
    const auth = db.prepare(`SELECT max(a.treatment_flags) AS flags FROM authority a JOIN opinions o ON o.id = a.opinion_id WHERE o.cluster_id = ?`).get(res.cluster_id) as { flags: number | null } | undefined;
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
  const spans = extractQuotedSpans(text);
  const quotes: QuoteCheck[] = [];
  for (const span of spans) {
    let target: CitationCheck | undefined;
    let idx = -1;
    for (let i = citations.length - 1; i >= 0; i--) {
      const c = citations[i];
      if (c.form === "full" && c.status === "verified" && c.cite_end <= span.start) {
        target = c;
        idx = i;
        break;
      }
    }
    if (!target) {
      for (let i = 0; i < citations.length; i++) {
        const c = citations[i];
        if (c.form === "full" && c.status === "verified" && c.cite_start >= span.end && c.cite_start - span.end <= 300) {
          target = c;
          idx = i;
          break;
        }
      }
    }
    if (!target || target.opinion_id == null) {
      quotes.push({ quote: span.quote, start: span.start, end: span.end, status: "unattributed" });
      continue;
    }
    const row = db.prepare("SELECT text FROM opinions WHERE id = ?").get(target.opinion_id) as { text: string } | undefined;
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
  const summary: Record<string, number> = {};
  for (const c of citations) summary[`citation:${c.status}`] = (summary[`citation:${c.status}`] ?? 0) + 1;
  for (const q of quotes) summary[`quote:${q.status}`] = (summary[`quote:${q.status}`] ?? 0) + 1;
  const anyUnresolved = citations.some((c) => c.status === "unresolved_citation");
  const anyQuoteFail = quotes.some((q) => q.status === "quote_not_found" || q.status === "quote_wrong_case" || q.status === "unattributed");
  return { overall: anyUnresolved || anyQuoteFail ? "fail" : "pass", citations, quotes, summary };
}
