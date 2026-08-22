import { openCorpus, type LookupResult } from "./lib/db.js";

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
      `SELECT cs.cluster_id, cs.volume, cs.reporter, cs.page, cs.type,
              o.id AS opinion_id, o.case_name, o.case_name_short, o.date_filed,
              o.court_id, o.precedential_status, o.citation_count
       FROM citation_strings cs
       LEFT JOIN opinions o ON o.cluster_id = cs.cluster_id
       WHERE cs.volume = ? AND cs.reporter = ? AND cs.page = ?`
    )
    .all(cite.volume, cite.reporter, cite.page) as Array<
    LookupResult & { volume: string; reporter: string; page: string; type: string }
  >;

  if (rows.length === 0) return null;
  const first = rows[0];
  const opinionId = first.opinion_id;

  let citedBy = 0;
  if (opinionId != null) {
    citedBy =
      (
        db
          .prepare(`SELECT count(DISTINCT citing_id) AS n FROM cites WHERE cited_id = ?`)
          .get(opinionId) as { n: number } | undefined
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
    opinion_id: opinionId ?? -1,
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
  } else {
    console.error("usage: alex lookup \"410 U.S. 113\"   (search arrives in G1)");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
