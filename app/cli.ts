import { pathToFileURL } from "node:url";
import { openCorpus, resolveCluster, type LookupResult } from "./lib/db.js";
import { search } from "./lib/retrieval/search.js";

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
  } else {
    console.error(
      'usage: alex lookup "410 U.S. 113"  |  alex search "qualified immunity clearly established" [--jurisdiction cal] [--limit 10]'
    );
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
