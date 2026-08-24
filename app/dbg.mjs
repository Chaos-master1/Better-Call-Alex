import Database from "better-sqlite3";
const db = new Database("../data/corpus.sqlite", { readonly: true });
db.pragma("mmap_size = 2147483648");
// does Miranda match every term?
for (const t of ["miranda","warnings","warning","custodial","interrogation","counsel"]) {
  const r = db.prepare("SELECT count(*) n FROM opinions_fts WHERE opinions_fts MATCH ? AND rowid=(SELECT o.id FROM opinions o WHERE o.case_name LIKE 'Miranda v. Arizona%' LIMIT 1)").get(`"${t}"`);
  const any = db.prepare("SELECT count(*) n FROM opinions_fts f JOIN opinions o ON o.id=f.rowid WHERE opinions_fts MATCH ? AND o.case_name LIKE 'Miranda v. Arizona%'").get(`"${t}"`);
  console.log(t.padEnd(14), "miranda-opinion-docs-containing:", any.n);
}
// how many docs match full AND?
console.log("full AND docs:", db.prepare('SELECT count(*) n FROM opinions_fts WHERE opinions_fts MATCH ?').get('"miranda" "warnings" "custodial" "interrogation" "right" "to" "counsel"'.replace('"right" "to" ','')).n);
