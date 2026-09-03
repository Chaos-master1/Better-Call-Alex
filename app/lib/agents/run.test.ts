/**
 * runCase lifecycle tests — corpus-free (:memory: app DB, pre-aborted
 * signal so no model or corpus is ever touched).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runCase } from "./run.js";

function memoryApp(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE cases (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL, facts TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')))`
  );
  db.exec(
    `CREATE TABLE runs (id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL,
      started_at TEXT DEFAULT (datetime('now')), finished_at TEXT,
      status TEXT DEFAULT 'running',
      intake_json TEXT, research_json TEXT, analyst_json TEXT,
      adversary_json TEXT, draft_json TEXT, ms INTEGER)`
  );
  db.exec(
    `CREATE TABLE audit_log (id INTEGER PRIMARY KEY,
      ts TEXT DEFAULT (datetime('now')), kind TEXT NOT NULL,
      payload TEXT NOT NULL, case_id INTEGER)`
  );
  db.exec(
    `CREATE TABLE messages (id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, model TEXT,
      prompt_tokens INTEGER, response_tokens INTEGER,
      created_at TEXT DEFAULT (datetime('now')))`
  );
  db.exec(`INSERT INTO cases (id, slug, title, facts) VALUES (1, 't', 't', 't')`);
  return db;
}

test("pre-aborted run finalizes as cancelled, never touches the pipeline", async () => {
  const db = memoryApp();
  try {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(runCase(db, 1, "facts", { signal: ac.signal }), /cancelled/);
    const row = db
      .prepare(`SELECT status FROM runs WHERE case_id = 1 ORDER BY id DESC LIMIT 1`)
      .get() as { status: string };
    assert.equal(row.status, "cancelled");
    const err = db
      .prepare(`SELECT payload FROM audit_log WHERE kind = 'agent.error'`)
      .get() as { payload: string };
    assert.match(err.payload, /cancelled/);
  } finally {
    db.close();
  }
});
