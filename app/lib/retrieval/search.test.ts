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
import { extractPassage, matchJurisdiction, tokenize, matchExpression } from "./search.js";

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
