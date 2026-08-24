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
    const all: number[] = [];
    const colds: number[] = [];
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
