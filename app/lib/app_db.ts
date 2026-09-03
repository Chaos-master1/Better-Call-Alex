/**
 * App database schema (CLAUDE.md §3, §5.6). Read-write: cases, documents,
 * messages, runs, audit_log. The corpus is accessed via openCorpus()
 * (dedicated read-only handle), not by ATTACHing into this connection.
 *
 * audit_log is append-only, enforced by triggers that reject UPDATE and
 * DELETE — not by convention (§5.6).
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
CREATE TRIGGER IF NOT EXISTS cases_touch_updated
AFTER UPDATE ON cases WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE cases SET updated_at = datetime('now') WHERE id = NEW.id;
END;

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
  payload TEXT NOT NULL,
  case_id INTEGER
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
 * Open the app database. The corpus is NOT attached here: search/verify use
 * a dedicated read-only handle from openCorpus() (better-sqlite3, query_only).
 * Attaching the corpus via PRAGMA query_only is connection-global in SQLite
 * (it would make the app DB read-only too) and the file: URI with spaces in
 * this repo's path is not reliably handled by ATTACH. No app code actually
 * joins through the attached alias, so we keep the handle clean.
 * If the app DB file does not exist, the schema is created.
 */
export function openApp(): Database.Database {
  // ALEX_APP_DB overrides the path for route-level tests (tmp DBs) and
  // safe local experimentation. Production never sets it.
  return openAppAt(process.env.ALEX_APP_DB ?? APP_PATH);
}

/**
 * Open the app database at an explicit path. Production uses APP_PATH via
 * openApp(); tests point at tmp files so no test ever touches the real
 * data/app.sqlite. Same schema, migrations, and stale-run recovery.
 */
export function openAppAt(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  // Writers contend (server runs + CLI + evals share this file): wait
  // instead of failing fast with SQLITE_BUSY surfacing as a 500.
  db.pragma(`busy_timeout = 5000`);
  // The schema uses IF NOT EXISTS for every table, index, and trigger,
  // so this is idempotent on a populated DB.
  db.exec(SCHEMA);
  db.pragma(`journal_mode = WAL`);
  db.pragma(`foreign_keys = ON`);
  migrate(db);
  // Best-effort: a crashed run's stale row must not block reads, but a
  // recovery UPDATE that itself fails (locked/remote FS) must not take
  // down the open — the row simply ages out on the next healthy open.
  try {
    recoverStaleRuns(db);
  } catch (e) {
    console.error("[app_db] recoverStaleRuns skipped:", String(e).slice(0, 160));
  }
  return db;
}

/** Column additions that CREATE TABLE IF NOT EXISTS cannot deliver on an
 *  existing database (SQLite has no ADD COLUMN IF NOT EXISTS). Every
 *  statement here is a compile-time constant — nothing user-derived is
 *  ever concatenated into SQL. */
function migrate(db: Database.Database): void {
  const auditCols = db.pragma("table_info(audit_log)") as Array<{ name: string }>;
  if (!auditCols.some((c) => c.name === "case_id")) {
    addColumn(db, "audit_log", "case_id INTEGER");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_log(case_id)");
  const runCols = db.pragma("table_info(runs)") as Array<{ name: string }>;
  if (!runCols.some((c) => c.name === "ms")) {
    addColumn(db, "runs", "ms INTEGER");
  }
}

/** ADD COLUMN has no IF NOT EXISTS: concurrent first-opens can both pass
 *  the pragma check and race to ALTER. The loser gets "duplicate column
 *  name" — a won race, not an error. Anything else rethrows. */
function addColumn(db: Database.Database, table: string, def: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}

/** A crashed process leaves runs stuck at 'running' forever — finalizeRun
 *  never fires. The pipeline is bounded well under an hour even with cold
 *  model loads, so anything still 'running' after an hour is dead. */
function recoverStaleRuns(db: Database.Database): void {
  db.prepare(
    "UPDATE runs SET status = 'failed', finished_at = datetime('now')" +
      " WHERE status = 'running'" +
      " AND datetime(started_at, '+1 hour') < datetime('now')"
  ).run();
}

/** Append a row to audit_log. The only legal way to write to it.
 *  `caseId` scopes the row to a case so the UI shows per-case steps
 *  (audit_log has always been append-only; the column is additive). */
export function audit(
  db: Database.Database,
  kind: string,
  payload: unknown,
  caseId?: number
): void {
  db.prepare(
    "INSERT INTO audit_log (kind, payload, case_id) VALUES (?, ?, ?)"
  ).run(kind, JSON.stringify(payload) ?? null, caseId ?? null);
}

export type AppDb = Database.Database;
