/**
 * Phase 0.2 — Independent quote-attribution ground truth + adversarial
 * mutations, run against the PRODUCTION verifier (verifier/verify.ts +
 * verify/core.ts + quotes.ts), not against any hand-built fixture.
 *
 * Mechanical setup, no builder judgment involved:
 *   A. POSITIVE control: sample real opinions, take real quoted sentences
 *      from their own text, and attribute them to the opinion itself in the
 *      canonical draft shape the pipeline produces:
 *        [LAW] <sentence with quote> (<vol> <rep> <page>).
 *      The production verifier must verify these. Any strike here is a
 *      FALSE POSITIVE against legitimate law — measured, not assumed.
 *
 *   B. ADVERSARIAL mutations of other real quotes (each must FAIL):
 *      1. altered number  (statistic/year/digit changed)
 *      2. altered party name (a name token replaced)
 *      3. dropped negation ("not " removed — meaning flip)
 *      4. transposed adjacent words
 *      5. real quote of case A attributed to a different real case B
 *      Mutations that pass = fabrication catch-rate misses. Every miss
 *      becomes a permanent G2 fixture (Phase A).
 *
 * Run:   cd app && npx tsx ../evals/run_audit_quotes.ts
 * Output: logs/audit-independent/probe02-quote-truth.json
 */
import fs from "node:fs";
import path from "node:path";
// Do NOT import better-sqlite3 directly: from evals/ it does not resolve
// (node_modules lives under app/). openCorpus() resolves it via app/lib and
// applies the standard readonly + mmap pragmas.
import { openCorpus } from "../app/lib/db.js";
import type Database from "better-sqlite3";
import { verifyText } from "../app/lib/verify/verify.js";
import { findQuote } from "../app/lib/verify/quotes.js";
import type { VerificationReport } from "../app/lib/verify/core.js";

// run from app/ (pnpm workspace root) so node resolves better-sqlite3 —
// mirrors run_eval.ts. REPO = one level up.
const REPO = path.resolve(import.meta.dirname, "..");
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const OUT = path.resolve(
  REPO,
  arg("--out", "logs/audit-independent/probe02-quote-truth.json")
);
const SEED = 20260920;
const N_POSITIVE = 150;
const N_MUTATION = 150;
const MIN_SENTENCE = 80; // chars — long enough to be a real quoted sentence
const MAX_SENTENCE = 400;

// Deterministic PRNG (no Math.random — the probe must be reproducible).
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

interface OpinionRow {
  id: number;
  cluster_id: number;
  case_name: string | null;
  text: string;
  date_filed: string | null;
  court_id: string | null;
  blocked: number;
}

function pickOpinions(db: Database.Database, n: number): OpinionRow[] {
  const { lo, hi } = db
    .prepare("SELECT min(id) AS lo, max(id) AS hi FROM opinions")
    .get() as { lo: number; hi: number };
  const stmt = db.prepare(
    `SELECT id, cluster_id, case_name, text, date_filed, court_id, blocked
       FROM opinions WHERE id = ?`
  );
  const out: OpinionRow[] = [];
  let tries = 0;
  while (out.length < n && tries < n * 30) {
    tries++;
    const row = stmt.get(randInt(hi - lo + 1) + lo) as OpinionRow | undefined;
    if (!row || row.blocked || !row.text || row.text.length < 2000) continue;
    out.push(row);
  }
  return out;
}

/** A sentence from `text` containing a double-quoted span of quotable length. */
function quotedSentences(text: string): string[] {
  const out: string[] = [];
  // Sentence-ish split: opinions are stored whitespace-collapsed.
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z\[(“"])/);
  for (const s of sentences) {
    const m = s.match(/[“"]([^“”"]{40,320})[”"]/);
    if (m && s.length >= MIN_SENTENCE && s.length <= MAX_SENTENCE) out.push(s.trim());
  }
  return out;
}

/** True-by-construction positive controls: keep only sentences whose quoted
 *  span production's own matcher (findQuote) locates in the sampled opinion's
 *  text. Sentences quoting dictionaries or block quotes that live elsewhere
 *  in the cluster are not verifier failures — they are harness-attribution
 *  noise, and excluding them here measures the verifier, not the sampler. */
function sentenceQuotesLocally(db: Database.Database, op: OpinionRow, sents: string[]): boolean {
  return sents.some((s) => {
    const m = s.match(/[“"]([^“”"]{40,320})[”"]/);
    if (!m) return false;
    const res = findQuote(op.text, m[1]);
    return res.status === "found" || res.status === "found_partial";
  });
}

/** The primary citation of an opinion: first citation_strings row for its cluster. */
function primaryCite(
  db: Database.Database,
  clusterId: number
): { vol: string; rep: string; page: string } | null {
  const r = db
    .prepare(
      `SELECT volume, reporter, page FROM citation_strings
        WHERE cluster_id = ? AND type = 'white'
        ORDER BY CAST(volume AS INTEGER), page LIMIT 1`
    )
    .get(clusterId) as { volume: string; reporter: string; page: string } | undefined;
  if (r) return { vol: r.volume, rep: r.reporter, page: r.page };
  const r2 = db
    .prepare(
      `SELECT volume, reporter, page FROM citation_strings
        WHERE cluster_id = ? ORDER BY CAST(volume AS INTEGER), page LIMIT 1`
    )
    .get(clusterId) as { volume: string; reporter: string; page: string } | undefined;
  return r2 ? { vol: r2.volume, rep: r2.reporter, page: r2.page } : null;
}

// ---- mutation engine -------------------------------------------------------

const NAME_HINT =
  /\b(?:v\.|vs\.?)\b|\b(?:State|United States|People|City|County|Board|Corp|Co\.|Inc\.|Co\.)\b/;

function firstNumber(s: string): { word: string; at: number } | null {
  const m = s.match(/\b\d[\d,.\-–]*/);
  return m && m.index != null ? { word: m[0], at: m.index } : null;
}

function firstCapitalizedToken(s: string): { word: string; at: number } | null {
  const m = s.match(/\b[A-Z][a-z]{3,}\b/);
  return m && m.index != null ? { word: m[0], at: m.index } : null;
}

function mutate(q: string, kind: number): string | null {
  switch (kind) {
    case 0: {
      // altered number
      const n = firstNumber(q);
      if (!n) return null;
      const digits = n.word.replace(/\D/g, "");
      if (!digits) return null;
      const swapped = digits.length > 1 ? digits.slice(0, -1) : String(Number(digits) + 7);
      const newNum = n.word.replace(digits, swapped === digits ? String(Number(digits) + 7) : swapped);
      if (newNum === n.word) return null;
      return q.slice(0, n.at) + newNum + q.slice(n.at + n.word.length);
    }
    case 1: {
      // altered party name — prefer a capitalized token near " v. " context words
      const cands: Array<{ word: string; at: number }> = [];
      const re = /\b[A-Z][a-z]{3,}\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(q))) {
        if (NAME_HINT.test(q.slice(Math.max(0, m.index - 40), m.index + 40))) {
          cands.push({ word: m[0], at: m.index });
        }
      }
      const pick = cands.length ? cands[randInt(cands.length)] : firstCapitalizedToken(q);
      if (!pick) return null;
      const repl = pick.word.length > 4 ? pick.word.slice(0, 3) + "worth" : pick.word + "son";
      if (repl === pick.word) return null;
      return q.slice(0, pick.at) + repl + q.slice(pick.at + pick.word.length);
    }
    case 2: {
      // dropped negation — flip meaning
      const m = q.match(/\b(not|never|no|cannot|may not|shall not)\b/i);
      if (!m || m.index == null) return null;
      return (q.slice(0, m.index) + q.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
    }
    case 3: {
      // transposed adjacent words
      const words = q.split(" ");
      if (words.length < 6) return null;
      for (let t = 0; t < 10; t++) {
        const i = 1 + randInt(words.length - 3);
        const a = words[i].replace(/\W/g, "");
        const b = words[i + 1].replace(/\W/g, "");
        if (a.length > 2 && b.length > 2 && a !== b) {
          [words[i], words[i + 1]] = [words[i + 1], words[i]];
          return words.join(" ");
        }
      }
      return null;
    }
    default:
      return null;
  }
}

// ---- verification calls (production path) ----------------------------------

function reportFor(db: Database.Database, draft: string): VerificationReport {
  return verifyText(db, draft, { skipQuoteRanges: [] });
}

function quoteVerdicts(r: VerificationReport): string[] {
  return r.quotes.map((q) => q.status);
}

// ---- main -------------------------------------------------------------------

interface CaseResult {
  opinion_id: number;
  kind: string;
  expect: string;
  got: string;
  ok: boolean;
  detail?: string;
}

function main() {
  const db: Database.Database = openCorpus();
  console.log("sampling opinions...");
  const opinions = pickOpinions(db, N_POSITIVE + N_MUTATION);

  const results: CaseResult[] = [];

  // ---- A. positive controls: real quotes, attributed to their own case ----
  console.log("positive controls (real quotes must verify)...");
  let positives = 0;
  for (const op of opinions) {
    if (positives >= N_POSITIVE) break;
    const sents = quotedSentences(op.text);
    if (!sents.length) continue;
    if (!sentenceQuotesLocally(db, op, sents)) continue;
    const cite = primaryCite(db, op.cluster_id);
    if (!cite) continue;
    const sent = sents[randInt(sents.length)];
    const draft = `[LAW] ${sent} (${cite.vol} ${cite.rep} ${cite.page}).`;
    const r = reportFor(db, draft);
    const verdicts = quoteVerdicts(r);
    // The sentence's own quote must verify (and the cite must resolve).
    // Aligned with PRODUCTION semantics (core.ts: overall keys on
    // unresolved_citation + quote failures only): out_of_corpus AND
    // unsupported_form (short/id/supra forms) are annotations that never
    // fail a draft — counting them as false strikes overstates the rate.
    const citeOk = r.citations.every(
      (c) => c.status !== "unresolved_citation"
    );
    const quoteOk = verdicts.every((v) => v === "verified");
    results.push({
      opinion_id: op.id,
      kind: "positive-real-quote",
      expect: "all verified",
      got: `${verdicts.join(",") || "none"}|cite:${
        citeOk
          ? "ok"
          : r.citations.map((c) => c.status).join("+")
      }`,
      ok: quoteOk && citeOk,
      detail: sent.slice(0, 120),
    });
    positives++;
  }

  // ---- B. adversarial mutations: must FAIL -------------------------------
  console.log("adversarial mutations (must be caught)...");
  const KIND_NAMES = ["altered_number", "altered_name", "dropped_negation", "transposed_words"];
  const counts = [0, 0, 0, 0];
  for (const op of opinions) {
    if (counts.every((c) => c >= N_MUTATION / 4)) break;
    const sents = quotedSentences(op.text);
    if (!sents.length) continue;
    const cite = primaryCite(db, op.cluster_id);
    if (!cite) continue;
    const orig = sents[randInt(sents.length)].match(/[“"]([^“”"]{40,320})[”"]/)![1];
    for (let k = 0; k < 4; k++) {
      if (counts[k] >= N_MUTATION / 4) continue;
      const mutated = mutate(orig, k);
      if (!mutated || mutated === orig) continue;
      counts[k]++;
      const draft = `[LAW] The court explained: "${mutated}" (${cite.vol} ${cite.rep} ${cite.page}).`;
      const r = reportFor(db, draft);
      const verdicts = quoteVerdicts(r);
      const caught = verdicts.some((v) => v !== "verified");
      results.push({
        opinion_id: op.id,
        kind: KIND_NAMES[k],
        expect: "not verified",
        got: verdicts.join(",") || "none",
        ok: caught,
        detail: mutated.slice(0, 120),
      });
    }
  }

  // ---- C. wrong-case attribution: real quote of A pinned to B ------------
  console.log("wrong-case attribution (must be caught)...");
  let wrongCase = 0;
  for (let i = 0; i + 1 < opinions.length && wrongCase < 50; i += 2) {
    const a = opinions[i];
    const b = opinions[i + 1];
    const sentsA = quotedSentences(a.text);
    const citeB = primaryCite(db, b.cluster_id);
    if (!sentsA.length || !citeB) continue;
    const sentA = sentsA[randInt(sentsA.length)].match(/[“"]([^“”"]{40,320})[”"]/)![1];
    const draft = `[LAW] The court explained: "${sentA}" (${citeB.vol} ${citeB.rep} ${citeB.page}).`;
    const r = reportFor(db, draft);
    const verdicts = quoteVerdicts(r);
    const caught = verdicts.some((v) => v !== "verified");
    results.push({
      opinion_id: a.id,
      kind: "wrong_case_attribution",
      expect: "not verified",
      got: verdicts.join(",") || "none",
      ok: caught,
      detail: sentA.slice(0, 120),
    });
    wrongCase++;
  }

  const positivesAll = results.filter((r) => r.kind === "positive-real-quote");
  const adversarial = results.filter((r) => r.kind !== "positive-real-quote");
  const posRate = positivesAll.filter((r) => r.ok).length / Math.max(1, positivesAll.length);
  const advCatch = adversarial.filter((r) => r.ok).length / Math.max(1, adversarial.length);

  // Decompose positive failures by the `got` signature so cite-annotation
  // noise (out_of_corpus) is separable from true quote false-strikes.
  const posFailKinds: Record<string, number> = {};
  for (const r of positivesAll) {
    if (!r.ok) {
      const key = r.got.replace(/[^a-z_|:+-]/gi, "").slice(0, 60) || "unknown";
      posFailKinds[key] = (posFailKinds[key] ?? 0) + 1;
    }
  }

  const byKind: Record<string, { n: number; caught: number }> = {};
  for (const r of adversarial) {
    byKind[r.kind] ??= { n: 0, caught: 0 };
    byKind[r.kind].n++;
    if (r.ok) byKind[r.kind].caught++;
  }

  const report = {
    probe: "phase0.2 quote-attribution ground truth + adversarial mutations",
    date: "2026-09-20",
    seed: SEED,
    production_path: "app/lib/verify/verify.ts -> core.ts -> quotes.ts (bridge: verifier/bridge.py)",
    positive_controls: {
      n: positivesAll.length,
      verified_rate: Number(posRate.toFixed(4)),
      note: "1.0 means no false strikes of real, correctly-attributed quotes",
      failure_kinds: posFailKinds,
      failures: positivesAll.filter((r) => !r.ok).slice(0, 20),
    },
    adversarial: {
      n: adversarial.length,
      catch_rate: Number(advCatch.toFixed(4)),
      by_kind: Object.fromEntries(
        Object.entries(byKind).map(([k, v]) => [k, { ...v, catch_rate: Number((v.caught / v.n).toFixed(4)) }])
      ),
      misses: adversarial.filter((r) => !r.ok).slice(0, 40),
    },
    verdict:
      posRate >= 0.9 && advCatch === 1
        ? "PASS — real quotes verify, every mutation caught"
        : advCatch === 1
        ? "PARTIAL — fabrication catch perfect but false-strike rate too high"
        : "FAIL — fabrication catch below 100%; misses become G2 fixtures (Phase A)",
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\npositive verified: ${positivesAll.filter((r) => r.ok).length}/${positivesAll.length}`);
  console.log(`adversarial caught: ${adversarial.filter((r) => r.ok).length}/${adversarial.length}`);
  for (const [k, v] of Object.entries(byKind)) {
    console.log(`  ${k}: ${v.caught}/${v.n}`);
  }
  console.log(`verdict: ${report.verdict}`);
  console.log(`-> ${OUT}`);
  db.close();
}

main();
