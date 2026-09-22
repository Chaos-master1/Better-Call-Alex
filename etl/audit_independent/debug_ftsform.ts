/** One-off: does a NEAR-tightened rung cut both match-set size and scoring
 *  cost for broad multi-term queries? */
import { openCorpus } from "../../app/lib/db.js";

const db = openCorpus();

function time(label: string, sql: string, ...params: (string | number)[]) {
  const stmt = db.prepare(sql);
  stmt.all(...params); // warm
  const t0 = performance.now();
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;
  const ms = performance.now() - t0;
  const n = rows.length === 1 && "n" in rows[0] ? String(rows[0].n) : String(rows.length);
  console.log(`${label.padEnd(46)} ${ms.toFixed(1)}ms  rows=${n}`);
  return ms;
}

const terms = ["personal", "jurisdiction", "minimum", "contacts"];
const q = (e: string) => e;
const andExpr = q(terms.map((t) => `"${t}"`).join(" AND "));

for (const n of [8, 12, 24, 48]) {
  const nearExpr = `NEAR(${terms.map((t) => `"${t}"`).join(" ")}, ${n})`;
  time(`count(${nearExpr})`, `SELECT count(*) AS n FROM opinions_fts WHERE opinions_fts MATCH ?`, nearExpr);
  time(`top-96 ${nearExpr}`, `SELECT rowid AS id FROM opinions_fts WHERE opinions_fts MATCH ? ORDER BY bm25(opinions_fts) LIMIT 96`, nearExpr);
}
console.log(`baseline:`);
time(`count(AND)`, `SELECT count(*) AS n FROM opinions_fts WHERE opinions_fts MATCH ?`, andExpr);
time(`top-96 AND`, `SELECT rowid AS id FROM opinions_fts WHERE opinions_fts MATCH ? ORDER BY bm25(opinions_fts) LIMIT 96`, andExpr);
db.close();
