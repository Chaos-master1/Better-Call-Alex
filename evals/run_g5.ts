/**
 * G5 verification runner: motion end to end (CLAUDE.md §8 G5).
 *
 * Loads the latest drafted run for a case from data/app.sqlite, runs the
 * SAME resolve gate the export route enforces (every appendix citation and
 * every sentence pin cite must resolve in data/corpus.sqlite — fail closed),
 * builds the .docx bytes, and writes them to logs/g5-motion.docx.
 *
 * Usage: tsx ../evals/run_g5.ts [--case 32] [--out logs/g5-motion.docx]
 * Exit non-zero (and no file) when any citation fails to resolve — that is
 * the gate working, not the harness failing.
 */
import { openCorpus, resolveCluster } from "../app/lib/db.js";
import { parseCitation } from "../app/lib/citation.js";
import {
  parseStatuteCites,
  resolveStatute,
  statuteTableExists,
} from "../app/lib/statute.js";
import { openApp } from "../app/lib/app_db.js";
import type { DraftDoc } from "../app/lib/draft.js";
import { buildMotionDocx } from "../app/lib/export_docx.js";
import { writeFileSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";

function resolves(corpus: Database.Database, cite: string): boolean {
  const base = cite.split(",")[0].trim();
  const parsed = parseCitation(base);
  if (parsed && resolveCluster(corpus, parsed.volume, parsed.reporter, parsed.page)) {
    return true;
  }
  if (statuteTableExists(corpus)) {
    for (const s of parseStatuteCites(cite)) {
      if (resolveStatute(corpus, s.source, s.title, s.section)) return true;
    }
  }
  return false;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const caseId = Number(arg("--case", "32"));
const outPath = arg("--out", "logs/g5-motion.docx");

async function main(): Promise<void> {
  if (!Number.isInteger(caseId) || caseId <= 0) {
    console.error("bad --case");
    process.exit(2);
  }

  const app = openApp();
  const row = app
    .prepare(
      `SELECT c.title,
              (SELECT r.draft_json FROM runs r WHERE r.case_id = c.id
                ORDER BY r.id DESC LIMIT 1) AS draft_json
         FROM cases c WHERE c.id = ?`
    )
    .get(caseId) as { title: string; draft_json: string | null } | undefined;
  app.close();
  if (!row?.draft_json) {
    console.error(`no drafted run for case ${caseId}`);
    process.exit(2);
  }
  const drafted = JSON.parse(row.draft_json) as DraftDoc;

  const corpus = openCorpus();
  try {
    const candidates = new Set<string>();
    for (const a of drafted.authority_appendix ?? []) {
      if (a.citation) candidates.add(a.citation);
    }
    for (const s of drafted.sentences ?? []) {
      if (s.pin_cite) candidates.add(s.pin_cite);
    }
    const checked = [...candidates].map((c) => ({ cite: c, ok: resolves(corpus, c) }));
    const bad = checked.filter((c) => !c.ok);
    console.log(JSON.stringify({
      case_id: caseId,
      title: row.title,
      citations_checked: checked.length,
      unresolvable: bad.map((b) => b.cite),
    }));
    if (bad.length > 0) {
      console.error(`G5 GATE: ${bad.length} citation(s) do not resolve — export refused`);
      process.exit(1);
    }
  } finally {
    corpus.close();
  }

  const buf = await buildMotionDocx(drafted);
  // Evidence guard: logs/g5-motion.docx is committed gate evidence. Refuse
  // to overwrite it implicitly — pass --out <other-path> or --force.
  if (existsSync(outPath) && !process.argv.includes("--force")) {
    console.error(
      `refusing to overwrite existing ${outPath} — pass --out <other-path> or --force`
    );
    process.exit(1);
  }
  writeFileSync(outPath, buf);
  console.log(`wrote ${outPath} (${buf.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
