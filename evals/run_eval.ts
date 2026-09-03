/**
 * G1 golden-set runner (CLAUDE.md §8): precision@10 against hand-built truth.
 *
 *   pnpm eval                     # compare against stored baseline
 *   pnpm eval -- --write-baseline # first run / intentional change: record new baseline
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { openCorpus } from "../app/lib/db.js";
import { search } from "../app/lib/retrieval/search.js";
import { lookup } from "../app/cli.js";

interface GoldenCase {
  id: string;
  type: "search" | "lookup";
  q: string;
  jurisdiction?: string;
  expect?: string[];
  expect_nonempty?: boolean;
}

const REPO = path.resolve(import.meta.dirname, "..");
const GOLDEN = path.join(REPO, "evals", "golden", "golden.json");
const BASELINE = path.join(REPO, "evals", "baseline", "precision_at_10.json");

function matches(hitName: string | null, expect: string[]): boolean {
  if (!hitName) return false;
  const n = hitName.toLowerCase();
  return expect.some((e) => n.includes(e.toLowerCase()));
}

function main() {
  const writeBaseline = process.argv.includes("--write-baseline");
  const spec: { cases: GoldenCase[] } = JSON.parse(
    readFileSync(GOLDEN, "utf-8")
  );
  const db = openCorpus();
  try {
    const results = spec.cases.map((c) => {
      let precision: number;
      let detail = "";
      if (c.type === "lookup") {
        const hit = lookup(db, c.q);
        const ok = matches(hit?.case_name ?? null, c.expect ?? []);
        precision = ok ? 1 : 0;
        detail = ok
          ? `${hit?.case_name}`
          : `got ${hit?.case_name ?? "NO AUTHORITY"}`;
      } else {
        const hits = search(db, c.q, { jurisdiction: c.jurisdiction });
        if (c.expect_nonempty) {
          precision = hits.length > 0 ? 1 : 0;
        } else {
          const top = hits.slice(0, 10);
          const rel = top.filter((h) => matches(h.case_name, c.expect ?? []));
          precision = top.length ? rel.length / top.length : 0;
        }
        detail = hits
          .slice(0, 3)
          .map((h) => h.case_name)
          .join(" | ");
      }
      return { id: c.id, q: c.q, precision, detail };
    });

    const mean =
      results.reduce((s, r) => s + r.precision, 0) / (results.length || 1);

    console.log("query results:");
    for (const r of results) {
      console.log(
        `  ${r.id.padEnd(9)} p=${r.precision.toFixed(2)}  ${r.q.slice(0, 48)}\n` +
          `            ${r.detail}`
      );
    }
    console.log(`\nmean precision@10: ${mean.toFixed(4)} (${results.length} cases)`);

    // A missing baseline must fail, not silently record: a clean checkout's
    // first `pnpm eval` would otherwise inscribe whatever the code currently
    // does as truth and the gate would prove nothing. Record explicitly with
    // --write-baseline only.
    if (!existsSync(BASELINE)) {
      if (!writeBaseline) {
        console.error(
          `no baseline at ${path.relative(REPO, BASELINE)} — refusing to record implicitly. ` +
            `Run once with --write-baseline to inscribe it deliberately, then re-run to gate.`
        );
        process.exit(1);
      }
    }
    if (writeBaseline) {
      mkdirSync(path.dirname(BASELINE), { recursive: true });
      writeFileSync(
        BASELINE,
        JSON.stringify(
          {
            recorded: new Date().toISOString().slice(0, 10),
            mean_precision_at_10: mean,
            per_case: results,
          },
          null,
          2
        )
      );
      console.log(`baseline recorded -> ${path.relative(REPO, BASELINE)}`);
      return;
    }

    const base = JSON.parse(readFileSync(BASELINE, "utf-8"));
    const delta = mean - base.mean_precision_at_10;
    console.log(
      `baseline: ${base.mean_precision_at_10.toFixed(4)} (${base.recorded}) — delta ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`
    );
    if (delta < -0.02) {
      console.error("REGRESSION beyond tolerance (-0.02). Gate fails.");
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
