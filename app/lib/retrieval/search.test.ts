/**
 * Jurisdiction resolution tests — corpus-free (:memory: courts table).
 *
 * matchJurisdiction() maps intake forum text to a court set for retrieval
 * filtering (ADR-002). Exact id/code match first, court-name fallback
 * second, null (→ unfiltered search) when nothing matches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { extractPassage, matchJurisdiction, search, tokenize, matchExpression } from "./search.js";

function memoryCourts(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE courts (id TEXT PRIMARY KEY, name TEXT,
      jurisdiction TEXT, citation_string TEXT, parent_id TEXT)`
  );
  db.exec(
    `INSERT INTO courts (id, name, jurisdiction, citation_string, parent_id) VALUES
      ('cal', 'California Supreme Court', 'S', 'Cal.', NULL),
      ('calctapp', 'California Court of Appeal', 'SA', 'Cal. Ct. App.', 'cal'),
      ('ca9', 'Court of Appeals for the Ninth Circuit', 'F', '9th Cir.', NULL),
      ('scotus', 'Supreme Court of the United States', 'F', 'U.S.', NULL)`
  );
  return db;
}

test("exact court id resolves (the CLI path)", () => {
  const db = memoryCourts();
  try {
    const set = matchJurisdiction(db, "cal");
    assert.ok(set && set.has("cal"));
  } finally {
    db.close();
  }
});

test("free-text forum resolves via court-name fallback + subtree", () => {
  const db = memoryCourts();
  try {
    const set = matchJurisdiction(db, "California");
    assert.ok(set && set.has("cal"));
    assert.ok(set && set.has("calctapp"));
    assert.ok(set && !set.has("ca9"));
  } finally {
    db.close();
  }
});

test("unresolvable forum returns null (caller falls back to unfiltered)", () => {
  const db = memoryCourts();
  try {
    assert.equal(matchJurisdiction(db, "Nonexistent Place of Law"), null);
  } finally {
    db.close();
  }
});

test("LIKE wildcards in forum text cannot broaden the match", () => {
  const db = memoryCourts();
  try {
    assert.equal(matchJurisdiction(db, "%"), null);
  } finally {
    db.close();
  }
});

test("passage offsets are exact for the returned text", () => {
  const hay =
    "   leading space then the qualified immunity doctrine appears here with context after.   ";
  const p = extractPassage(hay, ["qualified immunity"]);
  const collapsed = hay.replace(/\s+/g, " ");
  assert.equal(collapsed.slice(p.start, p.end), p.text);
  assert.ok(p.text.includes("qualified immunity"));
});

test("MATCH expressions from hostile input execute without throwing", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize='porter unicode61')`);
    db.exec(`INSERT INTO t (x) VALUES ('the clock struck noon'), ('or not to be')`);
    const hostile = [
      "o'clock",
      "to be or not to be",
      '"quoted phrase"',
      "a*b (c) § 1983",
      "100% guaranteed—unicode’s test",
      "",
      "a",
    ];
    for (const q of hostile) {
      const expr = matchExpression(tokenize(q));
      if (expr === null) continue;
      // Must not throw (FTS syntax breakout) — results may be empty.
      db.prepare(`SELECT count(*) FROM t WHERE t MATCH ?`).get(expr);
    }
  } finally {
    db.close();
  }
});

// ——— citation-graph PRF (audit Phase B, eval-arbitrated) ———

function prfCorpus(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE opinions (id INTEGER PRIMARY KEY, cluster_id INTEGER,
      case_name TEXT, case_name_short TEXT, date_filed TEXT, court_id TEXT,
      type TEXT, blocked INTEGER DEFAULT 0, ocr INTEGER DEFAULT 0,
      precedential_status TEXT, citation_count INTEGER, text TEXT)`
  );
  db.exec(`CREATE TABLE authority (opinion_id INTEGER, pagerank REAL, recent_cites_2y INTEGER, treatment_flags INTEGER)`);
  db.exec(`CREATE TABLE cites (citing_id INTEGER, cited_id INTEGER, depth INTEGER, char_pos INTEGER, context TEXT)`);
  db.exec(`CREATE TABLE parentheticals (rowid INTEGER PRIMARY KEY, described_id INTEGER, describing_id INTEGER, text TEXT, score REAL)`);
  db.exec(`CREATE VIRTUAL TABLE opinions_fts USING fts5(text)`);
  db.exec(`CREATE VIRTUAL TABLE parentheticals_fts USING fts5(text)`);
  // Organic hits share the query vocabulary; the PRF citer shares none —
  // it can only be reached through the citation graph.
  const ops: Array<[number, number, string, string]> = [
    [1, 100, "Alpha v. Beta", "the commerce clause and substantial effects doctrine require interstate commerce analysis"],
    [2, 200, "Gamma v. Delta", "commerce clause substantial effects test applies to interstate commerce regulation"],
    [3, 300, "Family v. Estate", "we hold the testamentary trust valid and the codicil void ab initio"],
    [4, 400, "Citer v. Nobody", "the test adopted here tracks our earlier statutory framework and its rationale"],
  ];
  for (const [id, cl, name, text] of ops) {
    db.prepare(
      `INSERT INTO opinions (id, cluster_id, case_name, court_id, precedential_status, text)
       VALUES (?, ?, ?, 'scotus', 'Published', ?)`
    ).run(id, cl, name, text);
    db.prepare(`INSERT INTO opinions_fts (rowid, text) VALUES (?, ?)`).run(id, text);
  }
  // The citer (op 4) directly cites BOTH organic hits at depth 1.
  db.prepare(`INSERT INTO cites (citing_id, cited_id, depth) VALUES (4, 1, 1), (4, 2, 1)`).run();
  return db;
}

test("PRF surfaces a co-citing opinion with no shared vocabulary (flag-gated)", () => {
  const db = prfCorpus();
  try {
    const q = "commerce clause substantial effects";
    const plain = search(db, q, { limit: 3 });
    assert.ok(plain.some((h) => h.opinion_id === 4) === false,
      "without prf, the no-vocabulary citer must not surface");

    const prf = search(db, q, { limit: 3, prf: true });
    const hit4 = prf.find((h) => h.opinion_id === 4);
    assert.ok(hit4, "with prf, the co-citer surfaces");
    assert.equal(hit4.via_prf, true);
    assert.equal(hit4.scores.parenthetical_hits, 0);
    // Organic hits must stay ahead of the PRF seed (never displaced).
    assert.ok(prf.findIndex((h) => h.opinion_id === 1) < prf.findIndex((h) => h.opinion_id === 4));
  } finally {
    db.close();
  }
});
