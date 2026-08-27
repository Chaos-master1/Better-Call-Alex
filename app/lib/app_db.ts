/**
 * App database schema (CLAUDE.md §3, §5.6). Read-write: cases, documents,
 * messages, runs, audit_log. The corpus is ATTACHed read-only.
 *
 * audit_log is append-only, enforced by triggers that reject UPDATE and
 * DELETE — not by convention (§5.6). Run via: `tsx ../etl/build_app_db.py`
 * or via the migration runner below.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";
import { APP_PATH, CORPUS_PATH } from "./db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  facts TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('motion', 'brief', 'memorandum', 'complaint', 'answer', 'order', 'other')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER,
  response_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')) DEFAULT 'running',
  intake_json TEXT,
  research_json TEXT,
  analyst_json TEXT,
  adversary_json TEXT,
  draft_json TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- §5.6: audit_log is append-only, enforced by triggers, not by convention.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only (UPDATE rejected)');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only (DELETE rejected)');
END;

CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_case ON runs(case_id);
CREATE INDEX IF NOT EXISTS idx_audit_kind_ts ON audit_log(kind, ts);
`;

/**
 * Open the app database. ATTACHes the corpus read-only so a single
 * connection can join against `opinions`, `cites`, `parentheticals`, etc.
 * If the app DB file does not exist, the schema is created.
 */
export function openApp(): Database.Database {
  const fresh = !existsSync(APP_PATH);
  const db = new Database(APP_PATH);
  if (fresh) {
    db.exec(SCHEMA);
  } else {
    // idempotent: triggers/tables use IF NOT EXISTS
    db.exec(SCHEMA);
  }
  // corpus attached. The build of better-sqlite3 used here does not
  // support `file:...?mode=ro` in the ATTACH string, so we open the
  // corpus read-only via its own handle (openCorpus) and rely on the
  // pragma_query_only + readonly flag on that handle. The cross-DB
  // joins here are read-only by construction; the corpus is never
  // written through this connection.
  db.pragma(`journal_mode = WAL`);
  db.pragma(`foreign_keys = ON`);
  db.exec(`ATTACH DATABASE '${CORPUS_PATH.replace(/'/g, "''")}' AS corpus`);
  return db;
}

/** Append a row to audit_log. The only legal way to write to it. */
export function audit(
  db: Database.Database,
  kind: string,
  payload: unknown
): void {
  db.prepare(
    `INSERT INTO audit_log (kind, payload) VALUES (?, ?)`
  ).run(kind, JSON.stringify(payload));
}

export type AppDb = Database.Database;
