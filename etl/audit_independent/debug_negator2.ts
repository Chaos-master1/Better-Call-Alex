import { openCorpus } from "../../app/lib/db.js";

function main() {
  const db = openCorpus();
  try {
    const row = db
      .prepare(`SELECT text FROM opinions WHERE id = 18483`)
      .get() as { text: string } | undefined;
    if (!row) return console.log("missing");
    const t = row.text;
    const at = 39979;
    console.log("context before:", JSON.stringify(t.slice(at - 80, at)));
    console.log("match span:", JSON.stringify(t.slice(at, at + 32)));
    // all occurrences of the bare phrase and their preceding 12 chars
    let i = 0;
    for (;;) {
      const k = t.indexOf("person shall be deprived of life", i);
      if (k === -1) break;
      console.log(`occ@${k}: ...${JSON.stringify(t.slice(Math.max(0, k - 14), k))}>`);
      i = k + 1;
    }
  } finally {
    db.close();
  }
}
main();
