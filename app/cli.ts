import { pathToFileURL } from "node:url";
import { openCorpus, resolveCluster, type LookupResult } from "./lib/db.js";
import { search } from "./lib/retrieval/search.js";
import { openApp } from "./lib/app_db.js";
import { runCase } from "./lib/agents/run.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const STRIKE = "\x1b[9m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";

function renderSentence(s: {
  tag: string;
  text: string;
  pin_cite?: string;
  verified: boolean;
  inferred: boolean;
}): string {
  const tagStr = `${CYAN}[${s.tag}]${RESET}`;
  const citeStr = s.pin_cite ? `${DIM} (${s.pin_cite})${RESET}` : "";
  let text = s.text;
  let prefix = "";
  if (!s.verified) {
    prefix = `${RED}✗${RESET} `;
    text = `${STRIKE}${text}${RESET}`;
  } else if (s.inferred) {
    prefix = `${YELLOW}≈${RESET} `;
    text = `${DIM}${text}${RESET}`;
  } else {
    prefix = `${GREEN}✓${RESET} `;
  }
  return `${prefix}${tagStr} ${text}${citeStr}`;
}

export function parseCitation(
  input: string
): { volume: string; reporter: string; page: string } | null {
  const m = input
    .trim()
    .match(/^(\d{1,4})\s+([A-Za-z][A-Za-z0-9 .']*?\.?)\s+(\d{1,6})$/);
  if (!m) return null;
  return {
    volume: String(Number(m[1])),
    reporter: m[2].trim(),
    page: String(Number(m[3])),
  };
}

export function lookup(db: ReturnType<typeof openCorpus>, input: string): LookupResult | null {
  const cite = parseCitation(input);
  if (!cite) return null;
  return resolveCluster(db, cite.volume, cite.reporter, cite.page);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "lookup") {
    const query = args.join(" ");
    const db = openCorpus();
    try {
      const result = lookup(db, query);
      if (!result) {
        console.log(`NO AUTHORITY FOUND IN CORPUS for "${query}"`);
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
    } finally {
      db.close();
    }
  } else if (cmd === "search") {
    const flags: Record<string, string> = {};
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--jurisdiction" || args[i] === "-j") {
        flags.jurisdiction = args[++i] ?? "";
      } else if (args[i] === "--limit") {
        flags.limit = args[++i] ?? "";
      } else {
        positional.push(args[i]);
      }
    }
    const query = positional.join(" ");
    const db = openCorpus();
    try {
      const t0 = performance.now();
      const hits = search(db, query, {
        jurisdiction: flags.jurisdiction || undefined,
        limit: flags.limit ? Number(flags.limit) : undefined,
      });
      const ms = Math.round(performance.now() - t0);
      if (hits.length === 0) {
        console.log(`NO AUTHORITY FOUND IN CORPUS for "${query}"`);
        console.error(`(${ms} ms)`);
        process.exit(1);
      }
      console.log(JSON.stringify({ query, elapsed_ms: ms, hits }, null, 2));
    } finally {
      db.close();
    }
  } else if (cmd === "run") {
    const facts = args.join(" ").trim();
    if (!facts) {
      console.error('usage: alex run "<free-text fact pattern>"');
      process.exit(2);
    }
    const app = openApp();
    const caseId = Number(
      app
        .prepare(
          `INSERT INTO cases (slug, title, facts) VALUES (?, ?, ?)`
        )
        .run(
          `cli-${Date.now()}`,
          "CLI run",
          facts
        ).lastInsertRowid
    );
    try {
      const out = await runCase(app, caseId, facts);
      console.log(
        `\n${BOLD}=== INTAKE ===${RESET}\n` +
          JSON.stringify(out.intake, null, 2)
      );
      console.log(
        `\n${BOLD}=== ANALYST IRAC ===${RESET}\n` +
          JSON.stringify(out.analyst.irac, null, 2)
      );
      console.log(
        `\n${BOLD}=== ADVERSARY ===${RESET}\n` +
          out.adversary.counter_argument
      );
      console.log(
        `\n${BOLD}=== DRAFT (${out.draft.overall.toUpperCase()}) ===${RESET}\n` +
          `${DIM}DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE${RESET}\n`
      );
      for (const s of out.draft.sentences) {
        console.log("  " + renderSentence(s));
      }
      const failed = out.draft.sentences.filter((s) => !s.verified).length;
      console.log(
        `\n${DIM}verified ${out.draft.sentences.length - failed}/${out.draft.sentences.length}  total ${(out.ms / 1000).toFixed(1)}s${RESET}`
      );
    } finally {
      app.close();
    }
  } else {
    console.error(
      'usage:\n' +
        '  alex lookup "410 U.S. 113"\n' +
        '  alex search "qualified immunity clearly established" [--jurisdiction cal] [--limit 10]\n' +
        '  alex run "<free-text fact pattern>"'
    );
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
