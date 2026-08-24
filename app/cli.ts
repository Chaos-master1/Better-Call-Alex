import { pathToFileURL } from "node:url";
import { openCorpus, type LookupResult } from "./lib/db.js";
import { search } from "./lib/retrieval/search.js";

const REPORTER_ALIASES: Record<string, string> = {
  "u.s.": "U.S.",
  us: "U.S.",
  "f.2d": "F.2d",
  "f.3d": "F.3d",
  "f.4th": "F.4th",
  "s.ct.": "S. Ct.",
};

export function parseCitation(
  input: string
): { volume: string; reporter: string; page: string } | null {
  const m = input
    .trim()
    .match(/^(\d{1,4})\s+([A-Za-z][A-Za-z0-9 .']*?\.?)\s+(\d{1,6})$/);
  if (!m) return null;
  const reporterKey = m[2].trim().toLowerCase();
  return {
    volume: String(Number(m[1])),
    reporter: REPORTER_ALIASES[reporterKey] ?? m[2].trim(),
    page: String(Number(m[3])),
  };
}

export function lookup(db: ReturnType<typeof openCorpus>, input: string): LookupResult | null {
  const cite = parseCitation(input);
  if (!cite) return null;

  const rows = db
    .prepare(
      `SELECT DISTINCT cs.cluster_id, cs.volume, cs.reporter, cs.page, cs.type,
              o.id AS opinion_id, o.case_name, o.case_name_short, o.date_filed,
              o.court_id, o.precedential_status, o.citation_count
       FROM citation_strings cs
       LEFT JOIN opinions o ON o.cluster_id = cs.cluster_id
       WHERE cs.volume = ? AND cs.reporter = ? AND cs.page = ?
         AND o.id IS NOT NULL
       ORDER BY CASE WHEN o.type LIKE '%lead%' THEN 0
                     WHEN o.type LIKE '%combined%' THEN 1 ELSE 2 END, o.id`
    )
    .all(cite.volume, cite.reporter, cite.page) as Array<
    LookupResult & { volume: string; reporter: string; page: string; type: string }
  >;

  if (rows.length === 0) return null;
  const first = rows[0];
  const clusterId = first.cluster_id;

  let citedBy = 0;
  if (clusterId != null) {
    citedBy =
      (
        db
          .prepare(
            `SELECT count(DISTINCT ci.citing_id) AS n FROM cites ci
             JOIN opinions po ON po.id = ci.cited_id
             WHERE po.cluster_id = ?`
          )
          .get(clusterId) as { n: number } | undefined
      )?.n ?? 0;
  }

  let courtName: string | null = null;
  if (first.court_id) {
    courtName =
      (
        db.prepare(`SELECT name FROM courts WHERE id = ?`).get(first.court_id) as
          | { name: string }
          | undefined
      )?.name ?? null;
  }

  return {
    opinion_id: first.opinion_id ?? -1,
    cluster_id: first.cluster_id,
    case_name: first.case_name,
    case_name_short: first.case_name_short,
    date_filed: first.date_filed,
    court_id: first.court_id,
    court_name: courtName,
    precedential_status: first.precedential_status,
    citation_count: first.citation_count,
    cited_by: citedBy,
    citations: rows.map((r) => ({
      volume: r.volume,
      reporter: r.reporter,
      page: r.page,
      type: r.type,
    })),
  };
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
