import { openCorpus, resolveCluster } from "../../app/lib/db.js";
import { verifyText } from "../../app/lib/verify/verify.js";

async function main() {
const db = openCorpus();
try {
  const probe = db
    .prepare(
      `SELECT o.id AS id, o.cluster_id AS cluster_id, o.text AS text
         FROM opinions o
        WHERE o.blocked = 0
          AND o.id IN (SELECT rowid FROM opinions_fts
                       WHERE opinions_fts MATCH '"no person shall be deprived"')
          AND o.text LIKE '%no person shall be deprived%'
          AND NOT EXISTS (
                SELECT 1 FROM opinions sib
                 WHERE sib.cluster_id = o.cluster_id
                   AND sib.blocked = 0
                   AND sib.text LIKE '%person shall be deprived of life%'
                   AND sib.text NOT LIKE '%no person shall be deprived of life%'
              )
        LIMIT 1`
    )
    .get() as { id: number; cluster_id: number; text: string } | undefined;
  if (!probe) {
    console.log("no probe row");
    process.exit(1);
  }
  console.log("probe opinion", probe.id, "cluster", probe.cluster_id);
  const cites = db
    .prepare(`SELECT volume, reporter, page FROM citation_strings WHERE cluster_id = ?`)
    .all(probe.cluster_id) as Array<{ volume: string; reporter: string; page: string }>;
  let chosen: { volume: string; reporter: string; page: string } | undefined;
  for (const c of cites) {
    const res = resolveCluster(db, c.volume, c.reporter, c.page);
    if (res && res.cluster_id === probe.cluster_id && (res.all_cluster_ids?.length ?? 1) === 1) {
      chosen = c;
      console.log("chosen cite", c, "resolves to", res.cluster_id, "opinion", res.opinion_id);
      break;
    }
  }
  if (!chosen) {
    console.log("no self-resolving unambiguous cite");
    process.exit(1);
  }
  const m = probe.text.match(/[Nn]o\s+(person shall be deprived of life)/);
  console.log("match:", !!m);
  const draft = `[LAW] The court said "${m![1]}" (${chosen.volume} ${chosen.reporter} ${chosen.page}).`;
  const r = verifyText(db, draft);
  console.log(JSON.stringify({ overall: r.overall, citations: r.citations, quotes: r.quotes, summary: r.summary }, null, 2));
} finally {
  db.close();
}
}
main();
