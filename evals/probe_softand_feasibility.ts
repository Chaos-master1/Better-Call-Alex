/**
 * Soft-AND feasibility probe (audit Phase B, §2 arbitration).
 *
 * A soft-AND ladder rung can only ever change outcomes for queries whose
 * strict-AND expression matches ZERO opinions (any partial match is already
 * covered by bm25 ranking + the parenthetical/PRF seeds). If natural-language
 * legal queries almost never hit zero, the rung is complexity without a
 * failure mode to fix and must be cut WITHOUT being built.
 *
 * Method: sample real judge-written parentheticals (the same distribution as
 * probe03's Type-A queries), build the exact production expression via
 * matchExpression(tokenize(q)), and count zero-hit rate. Also report the
 * same for stripped citing-context sentences.
 *
 * Run: cd app && npx tsx ../evals/probe_softand_feasibility.ts [--n 300]
 */
import { openCorpus } from "../app/lib/db.js";
import { tokenize, matchExpression } from "../app/lib/retrieval/search.js";
import type Database from "better-sqlite3";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 20260920;
const rand = mulberry32(SEED);
const randInt = (n: number) => Math.floor(rand() * n);

function main() {
  const n = Math.max(50, Math.floor(Number(process.argv[process.argv.indexOf("--n") + 1] ?? 300)) || 300);
  const db: Database.Database = openCorpus();
  const countStmt = db.prepare(
    `SELECT count(*) AS c FROM opinions_fts WHERE opinions_fts MATCH ?`
  );

  // Random-rowid sampling: PK lookups only. Materializing the full pool
  // (6.3M parentheticals) forced full scans under probe contention.
  const q1count = (db.prepare(`SELECT max(rowid) AS m FROM parentheticals`).get() as { m: number }).m;
  const q1get = db.prepare(
    `SELECT text, described_id FROM parentheticals WHERE rowid = ?`
  );

  let parenZero = 0;
  let parenN = 0;
  let guard = 0;
  while (parenN < n && guard < n * 30) {
    guard++;
    const row = q1get.get(randInt(q1count) + 1) as
      | { text: string; described_id: number | null }
      | undefined;
    if (!row?.text || row.described_id == null) continue;
    const q = row.text
      .replace(/^(Holding that|Holding|Noting that|Observing that|Explaining that|Stating that|Recognizing that|Overruling|Quoting|Citing|Following|Adopting|Applying)\s+/i, "")
      .trim();
    if (q.split(/\s+/).length < 5) continue;
    const expr = matchExpression(tokenize(q));
    if (!expr) continue;
    const c = (countStmt.get(expr) as { c: number }).c;
    if (c === 0) parenZero++;
    parenN++;
  }

  const q2count = (db.prepare(`SELECT max(rowid) AS m FROM cites`).get() as { m: number }).m;
  const q2get = db.prepare(
    `SELECT context, depth FROM cites WHERE rowid = ?`
  );
  let ctxZero = 0;
  let ctxN = 0;
  guard = 0;
  while (ctxN < n && guard < n * 60) {
    guard++;
    const row = q2get.get(randInt(q2count) + 1) as
      | { context: string | null; depth: number | null }
      | undefined;
    if (!row?.context || row.depth !== 1) continue;
    const q = row.context
      .replace(/\b\d{1,3}\s+[A-Z][A-Za-z.0-9'’]+\s+\d{1,4}\b/g, " ")
      .replace(/\bId\.|\bid\.\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (q.split(/\s+/).length < 6 || q.length < 40) continue;
    const expr = matchExpression(tokenize(q));
    if (!expr) continue;
    const c = (countStmt.get(expr) as { c: number }).c;
    if (c === 0) ctxZero++;
    ctxN++;
  }

  const pz = parenZero / Math.max(1, parenN);
  const cz = ctxZero / Math.max(1, ctxN);
  console.log(`parenthetical-style queries: ${parenZero}/${parenN} zero-hit (${(pz * 100).toFixed(1)}%)`);
  console.log(`citing-context queries:      ${ctxZero}/${ctxN} zero-hit (${(cz * 100).toFixed(1)}%)`);
  const verdict =
    pz < 0.03 && cz < 0.03
      ? "CUT — zero-hit rate negligible; soft-AND rung has no failure mode to fix"
      : "BUILD-WORTHY — meaningful zero-hit population exists for a soft-AND rescue rung";
  console.log(`verdict: ${verdict}`);
  console.log(JSON.stringify({ paren_zero_rate: pz, ctx_zero_rate: cz, n: parenN, verdict }, null, 2));
  db.close();
}

main();
