import Database from "better-sqlite3";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
export const CORPUS_PATH = path.join(REPO, "data", "corpus.sqlite");
export const APP_PATH = path.join(REPO, "data", "app.sqlite");

export function openCorpus(): Database.Database {
  const db = new Database(CORPUS_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = 1");
  db.pragma("mmap_size = 268435456");
  return db;
}

export interface LookupResult {
  opinion_id: number;
  cluster_id: number;
  case_name: string | null;
  case_name_short: string | null;
  date_filed: string | null;
  court_id: string | null;
  court_name: string | null;
  precedential_status: string | null;
  citation_count: number | null;
  cited_by: number;
  citations: { volume: string; reporter: string; page: string; type: string }[];
}
