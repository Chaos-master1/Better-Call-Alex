/**
 * Phase 0.3 — Mechanically-generated retrieval ground truth.
 *
 * The golden set is hand-built by the same project it grades. This probe
 * needs no human judgment at all:
 *
 *   Type A — parenthetical pairs: the corpus's own parentheticals table is
 *   (describing judge-written text → described case). The describing text
 *   IS a relevance-annotated query and the described case IS the required
 *   answer. Sample N, query, measure p@10 against the described case.
 *
 *   Type B — citing-context pairs: a citing sentence (cites.context around
 *   char_pos) with the citation string stripped is a fact-pattern query;
 *   the cited case is the answer.
 *
 * If retrieval scores notably worse here than on the hand-built golden set
 * (0.2883), the hand-built set was flattering us — that finding re-scopes
 * the retrieval work. This file is the permanent harness: rerunnable at any
 * N, seeded, deterministic.
 *
 * Run:   cd app && npx tsx ../evals/run_audit_retrieval.ts [--n 200]
 * Output: logs/audit-independent/probe03-retrieval-truth.json
 */
import fs from "node:fs";
import path from "node:path";
import { openCorpus } from "../app/lib/db.js";
import { search, type SearchHit } from "../app/lib/retrieval/search.js";
import type Database from "better-sqlite3";

const REPO = path.resolve(import.meta.dirname, "..");
const OUT = path.join(REPO, "logs", "audit-independent", "probe03-retrieval-truth.json");
const SEED = 20260920;
const N_PAREN = 150;
const N_CITECTX = 50;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const randInt = (n: number) => Math.floor(rand() * n);

/** strip citation strings and normalize into a query-like sentence */
function contextToQuery(context: string): string {
  return context
    .replace(/\b\d{1,3}\s+[A-Z][A-Za-z.0-9'’]+\s+\d{1,4}\b/g, " ")
    .replace(/\bId\.|\bid\.\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface AnswerInfo {
  case_name: string | null;
  case_name_short: string | null;
}

function answerFor(db: Database.Database, opinionId: number): AnswerInfo | null {
  const r = db
    .prepare(
      `SELECT cluster_id FROM opinions WHERE id = ?`
    )
    .get(opinionId) as { cluster_id: number | null } | undefined;
  if (!r?.cluster_id) return null;
  // The cluster's lead opinion carries the canonical case name.
  const c = db
    .prepare(
      `SELECT case_name, case_name_short FROM opinions
        WHERE cluster_id = ?
        ORDER BY CASE WHEN type LIKE '%lead%' THEN 0 ELSE 1 END, id LIMIT 1`
    )
    .get(r.cluster_id) as AnswerInfo | undefined;
  return c ?? null;
}

function nameMatches(hit: SearchHit | undefined, ans: AnswerInfo): boolean {
  if (!hit?.case_name) return false;
  const expect = (ans.case_name_short || ans.case_name || "").toLowerCase().trim();
  if (expect.length < 6) return false; // too generic to grade
  return hit.case_name.toLowerCase().includes(expect);
}

interface QueryCase {
  kind: "parenthetical" | "citing_context";
  q: string;
  source_opinion_id: number;
  answer: AnswerInfo;
  p: number; // precision of top-10 for this case (1 if answer in top-10)
  n_hits?: number; // raw hit count at strict AND (soft-AND feasibility signal)
  p_prf?: number; // same, with citation-graph PRF enabled (A/B mode)
  p_density?: number; // same, with passage-density re-rank (A/B mode)
}

function main() {
  const args = process.argv.slice(2);
  const nIdx = args.indexOf("--n");
  const nParen = nIdx >= 0 ? Math.floor(Number(args[nIdx + 1]) * 0.75) : N_PAREN;
  const nCite = nIdx >= 0 ? Math.floor(Number(args[nIdx + 1]) * 0.25) : N_CITECTX;

  const db: Database.Database = openCorpus();
  console.log("sampling parenthetical pairs...");
  const parenRows = db
    .prepare(
      `SELECT p.rowid AS rid, p.describing_id, p.described_id, p.text
         FROM parentheticals p
        WHERE p.described_id IS NOT NULL AND length(p.text) BETWEEN 40 AND 300
        ORDER BY p.rowid`
    )
    .all() as Array<{ rid: number; describing_id: number; described_id: number; text: string }>;
  console.log(`parenthetical pool: ${parenRows.length}`);

  const cases: QueryCase[] = [];
  const seenAnswer = new Set<string>();
  let guard = 0;
  while (cases.length < nParen && guard < nParen * 30) {
    guard++;
    const row = parenRows[randInt(parenRows.length)];
    const ans = answerFor(db, row.described_id);
    if (!ans || !ans.case_name) continue;
    const key = ans.case_name_short || ans.case_name;
    if ((ans.case_name_short || ans.case_name)!.length < 6) continue;
    // diversity: at most 2 queries per answer case
    if ([...seenAnswer].filter((k) => k === key).length >= 2) continue;
    const q = row.text.replace(/^(Holding that|Holding|Noting that|Observing that|Explaining that|Stating that|Recognizing that|Overruling|Quoting|Citing|Following|Adopting|Applying)\s+/i, "").trim();
    if (q.split(/\s+/).length < 5) continue;
    seenAnswer.add(key);
    cases.push({
      kind: "parenthetical",
      q,
      source_opinion_id: row.describing_id,
      answer: ans,
      p: 0,
    });
  }
  console.log(`parenthetical queries: ${cases.length}`);

  console.log("sampling citing-context pairs...");
  const ctxRows = db
    .prepare(
      `SELECT ci.citing_id, ci.cited_id, ci.context
         FROM cites ci
        WHERE ci.context IS NOT NULL AND length(ci.context) BETWEEN 80 AND 320
          AND ci.depth = 1
        LIMIT 400000`
    )
    .all() as Array<{ citing_id: number; cited_id: number; context: string }>;
  console.log(`context pool: ${ctxRows.length}`);
  guard = 0;
  let nCtx = 0;
  while (nCtx < nCite && guard < nCite * 60) {
    guard++;
    const row = ctxRows[randInt(ctxRows.length)];
    const ans = answerFor(db, row.cited_id);
    if (!ans || !(ans.case_name_short || ans.case_name)) continue;
    if ((ans.case_name_short || ans.case_name)!.length < 6) continue;
    const q = contextToQuery(row.context);
    if (q.split(/\s+/).length < 6 || q.length < 40) continue;
    cases.push({
      kind: "citing_context",
      q,
      source_opinion_id: row.citing_id,
      answer: ans,
      p: 0,
    });
    nCtx++;
  }
  console.log(`total queries: ${cases.length}\n`);

  let done = 0;
  const ab = args.includes("--prf");
  const abDensity = args.includes("--density");
  let zeroHit = 0;
  for (const c of cases) {
    const hits = search(db, c.q, { limit: 10 });
    if (hits.length === 0) zeroHit++;
    c.n_hits = hits.length;
    const inTop = hits.slice(0, 10).some((h) => nameMatches(h, c.answer));
    c.p = inTop ? 1 : 0;
    if (ab) {
      const h2 = search(db, c.q, { limit: 10, prf: true });
      c.p_prf = h2.slice(0, 10).some((h) => nameMatches(h, c.answer)) ? 1 : 0;
    }
    if (abDensity) {
      const h3 = search(db, c.q, { limit: 10, densityRerank: true });
      c.p_density = h3.slice(0, 10).some((h) => nameMatches(h, c.answer)) ? 1 : 0;
    }
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${cases.length}`);
  }
  console.log(`zero-hit queries (strict AND): ${zeroHit}/${cases.length}`);

  const byKind: Record<string, { n: number; p_sum: number }> = {};
  for (const c of cases) {
    byKind[c.kind] ??= { n: 0, p_sum: 0 };
    byKind[c.kind].n++;
    byKind[c.kind].p_sum += c.p;
  }
  const overall = cases.reduce((s, c) => s + c.p, 0) / Math.max(1, cases.length);

  // A/B verdict: PRF is kept only if it wins overall AND gains exceed losses
  // per-query (a single query regressions are visible, not averaged away).
  let abReport: Record<string, unknown> | null = null;
  if (ab) {
    const prfOverall = cases.reduce((s, c) => s + (c.p_prf ?? 0), 0) / Math.max(1, cases.length);
    const gained = cases.filter((c) => c.p === 0 && c.p_prf === 1).length;
    const lost = cases.filter((c) => c.p === 1 && c.p_prf === 0).length;
    const lostDetail = cases
      .filter((c) => c.p === 1 && c.p_prf === 0)
      .slice(0, 10)
      .map((c) => ({ kind: c.kind, q: c.q.slice(0, 120), answer: c.answer.case_name }));
    abReport = {
      mode: "A/B citation-graph PRF (opts.prf)",
      plain_p10: Number(overall.toFixed(4)),
      prf_p10: Number(prfOverall.toFixed(4)),
      queries_gained: gained,
      queries_lost: lost,
      lost_detail: lostDetail,
      verdict:
        prfOverall > overall && gained > lost
          ? "KEEP — PRF improves overall p@10 with more gains than losses"
          : prfOverall > overall
          ? "MARGINAL — improves overall but losses offset gains; inspect lost_detail"
          : "CUT — PRF does not improve mechanical p@10 (§2 rule)",
    };
    console.log(`\nA/B: plain p@10=${abReport.plain_p10} prf p@10=${abReport.prf_p10} gained=${gained} lost=${lost}`);
    console.log(`A/B verdict: ${abReport.verdict}`);
  }

  // Density A/B: same arbitration rule, same honesty.
  let densityReport: Record<string, unknown> | null = null;
  if (abDensity) {
    const dOverall = cases.reduce((s, c) => s + (c.p_density ?? 0), 0) / Math.max(1, cases.length);
    const dGained = cases.filter((c) => c.p === 0 && c.p_density === 1).length;
    const dLost = cases.filter((c) => c.p === 1 && c.p_density === 0).length;
    const dLostDetail = cases
      .filter((c) => c.p === 1 && c.p_density === 0)
      .slice(0, 10)
      .map((c) => ({ kind: c.kind, q: c.q.slice(0, 120), answer: c.answer.case_name }));
    densityReport = {
      mode: "A/B passage-density re-rank (opts.densityRerank)",
      plain_p10: Number(overall.toFixed(4)),
      density_p10: Number(dOverall.toFixed(4)),
      queries_gained: dGained,
      queries_lost: dLost,
      lost_detail: dLostDetail,
      verdict:
        dOverall > overall && dGained > dLost
          ? "KEEP — density re-rank improves overall p@10 with more gains than losses"
          : dOverall > overall
          ? "MARGINAL — improves overall but losses offset gains; inspect lost_detail"
          : "CUT — density re-rank does not improve mechanical p@10 (§2 rule)",
    };
    console.log(`A/B density: plain p@10=${densityReport.plain_p10} density p@10=${densityReport.density_p10} gained=${dGained} lost=${dLost}`);
    console.log(`density verdict: ${densityReport.verdict}`);
  }

  const failures = cases
    .filter((c) => c.p === 0)
    .slice(0, 30)
    .map((c) => ({ kind: c.kind, q: c.q.slice(0, 140), answer: c.answer.case_name }));

  const report = {
    probe: "phase0.3 mechanical retrieval ground truth (parenthetical + citing-context pairs)",
    date: "2026-09-20",
    seed: SEED,
    n_queries: cases.length,
    precision_at_10_overall: Number(overall.toFixed(4)),
    by_kind: Object.fromEntries(
      Object.entries(byKind).map(([k, v]) => [k, Number((v.p_sum / v.n).toFixed(4))])
    ),
    golden_reference: { precision_at_10: 0.2883, source: "evals/golden/golden.json (hand-built)" },
    ab_prf: abReport,
    ab_density: densityReport,
    sample_failures: failures,
    verdict:
      overall >= 0.25
        ? "REASONABLE — mechanical p@10 in the same band as the hand-built set"
        : "WEAK — mechanical p@10 far below the hand-built set; the hand-built set was flattering us",
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nmechanical p@10 overall: ${report.precision_at_10_overall}`);
  for (const [k, v] of Object.entries(report.by_kind)) console.log(`  ${k}: ${v}`);
  console.log(`verdict: ${report.verdict}`);
  console.log(`-> ${OUT}`);
  db.close();
}

main();
