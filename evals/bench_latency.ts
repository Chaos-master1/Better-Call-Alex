/**
 * G1 latency gate: p95 over repeated canon queries must stay < 500 ms
 * (CLAUDE.md §8 G1). Two-phase pattern mandatory per docs/g0-audit.md.
 */
import { openCorpus } from "../app/lib/db.js";
import { search } from "../app/lib/retrieval/search.js";

const QUERIES = [
  "qualified immunity clearly established",
  "personal jurisdiction minimum contacts",
  "fourth amendment warrantless search vehicle",
  "negligence duty of care foreseeability",
  "confrontation clause testimonial hearsay",
  "commerce clause substantial effects",
];

const RUNS = Number(process.argv[2] ?? 3);
const P95_BUDGET_MS = 500;

function main() {
  const db = openCorpus();
  try {
    const blockedStmt = db.prepare(
      "SELECT blocked FROM opinions WHERE id = ?"
    );
    const all: number[] = [];
    const colds: number[] = [];
    let invariantFailures = 0;
    console.log("query".padEnd(46), "min", "med", "max (ms)");
    for (const q of QUERIES) {
      // one unmeasured warmup: we gate steady-state service latency;
      // first-ever-touch cost (page-cache misses on a 197 GB file) is
      // reported separately as cold.
      const t0 = performance.now();
      search(db, q);
      colds.push(performance.now() - t0);
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const s0 = performance.now();
        const hits = search(db, q);
        times.push(performance.now() - s0);
        if (hits.length === 0) console.error(`  !! empty result: ${q}`);
      }
      // §9.7 standing invariant: a de-indexed opinion must never surface.
      const hits = search(db, q);
      for (const h of hits) {
        const b = blockedStmt.get(h.opinion_id) as { blocked: number } | undefined;
        if (b?.blocked) {
          console.error(`  !! BLOCKED opinion surfaced: ${h.opinion_id} (${q})`);
          invariantFailures++;
        }
      }
      times.sort((a, b) => a - b);
      const min = times[0];
      const med = times[Math.floor(times.length / 2)];
      const max = times[times.length - 1];
      all.push(...times);
      console.log(q.padEnd(46), String(Math.round(min)), String(Math.round(med)), String(Math.round(max)));
    }
    all.sort((a, b) => a - b);
    colds.sort((a, b) => a - b);
    const p95 = all[Math.min(all.length - 1, Math.floor(all.length * 0.95))];
    console.log(
      `\nwarm p50=${Math.round(all[Math.floor(all.length / 2)])}ms  ` +
      `warm p95=${Math.round(p95)}ms  n=${all.length}  budget=${P95_BUDGET_MS}ms\n` +
      `cold first-touch: min=${Math.round(colds[0])}ms max=${Math.round(colds[colds.length - 1])}ms`
    );
    if (invariantFailures > 0) {
      console.error(`FAIL: ${invariantFailures} blocked-opinion invariant violation(s)`);
      process.exit(1);
    }
    if (p95 > P95_BUDGET_MS) {
      console.error("FAIL: warm p95 exceeds budget");
      process.exit(1);
    }
    console.log("PASS");
  } finally {
    db.close();
  }
}

main();
