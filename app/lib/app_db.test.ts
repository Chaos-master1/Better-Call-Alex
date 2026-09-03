/**
 * app_db migration + trigger tests — tmp files only, never data/app.sqlite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, openAppAt } from "./app_db.js";

function tmpDb(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "alex-appdb-")), "app.sqlite");
}

test("fresh open creates schema with append-only audit_log", () => {
  const db = openAppAt(tmpDb());
  try {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const t of ["cases", "documents", "messages", "runs", "audit_log"]) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
    const id = Number(
      db.prepare(`INSERT INTO audit_log (kind, payload) VALUES (?, ?)`).run("t", "{}").lastInsertRowid
    );
    assert.throws(() => db.exec(`UPDATE audit_log SET kind='x' WHERE id=${id}`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM audit_log WHERE id=${id}`), /append-only/);
  } finally {
    db.close();
  }
});

test("pre-migration DB gains case_id and ms columns, data preserved", () => {
  const p = tmpDb();
  const old = new Database(p);
  try {
    // A genuinely old DB: core columns present (they predate migrations),
    // only audit_log.case_id and runs.ms missing (the two migrate() adds).
    old.exec(
      `CREATE TABLE cases (id INTEGER PRIMARY KEY, slug TEXT UNIQUE, title TEXT, facts TEXT,` +
        ` created_at TEXT, updated_at TEXT);` +
        `CREATE TABLE runs (id INTEGER PRIMARY KEY, case_id INTEGER, status TEXT DEFAULT 'running', draft_json TEXT);` +
        `CREATE TABLE audit_log (id INTEGER PRIMARY KEY, ts TEXT, kind TEXT, payload TEXT);` +
        `CREATE TABLE documents (id INTEGER PRIMARY KEY, case_id INTEGER, kind TEXT, title TEXT, body TEXT);` +
        `CREATE TABLE messages (id INTEGER PRIMARY KEY, case_id INTEGER, role TEXT, content TEXT,` +
        ` created_at TEXT);` +
        `INSERT INTO cases (id, slug, title, facts) VALUES (1, 's', 't', 'f');` +
        `INSERT INTO runs (id, case_id, status) VALUES (1, 1, 'succeeded');`
    );
  } finally {
    old.close();
  }
  const db = openAppAt(p);
  try {
    const runCols = db.pragma("table_info(runs)") as Array<{ name: string }>;
    assert.ok(runCols.some((c) => c.name === "ms"), "ms migrated");
    const auditCols = db.pragma("table_info(audit_log)") as Array<{ name: string }>;
    assert.ok(auditCols.some((c) => c.name === "case_id"), "case_id migrated");
    const row = db.prepare(`SELECT status FROM runs WHERE id = 1`).get() as { status: string };
    assert.equal(row.status, "succeeded");
  } finally {
    db.close();
  }
  // Second open: idempotent, no duplicate-column error.
  const db2 = openAppAt(p);
  db2.close();
});

test("stale running rows recover to failed on open", () => {
  const p = tmpDb();
  const db = openAppAt(p);
  const caseId = Number(
    db.prepare(`INSERT INTO cases (slug, title, facts) VALUES (?, ?, ?)`).run("s", "t", "f").lastInsertRowid
  );
  db.prepare(`INSERT INTO runs (case_id, status, started_at) VALUES (?, 'running', datetime('now', '-2 hours'))`).run(caseId);
  db.close();
  const db2 = openAppAt(p);
  try {
    const row = db2.prepare(`SELECT status FROM runs WHERE case_id = ?`).get(caseId) as { status: string };
    assert.equal(row.status, "failed");
  } finally {
    db2.close();
  }
});

test("audit() is the append path and scopes to a case", () => {
  const db = openAppAt(tmpDb());
  try {
    audit(db, "probe.kind", { n: 1 }, 7);
    const row = db.prepare(`SELECT kind, payload, case_id FROM audit_log`).get() as {
      kind: string;
      payload: string;
      case_id: number;
    };
    assert.equal(row.kind, "probe.kind");
    assert.equal(row.case_id, 7);
    assert.equal(JSON.parse(row.payload).n, 1);
  } finally {
    db.close();
  }
});
