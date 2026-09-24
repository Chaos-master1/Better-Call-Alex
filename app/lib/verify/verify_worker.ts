/**
 * G2 verifier worker entry (Phase C) — runs the ENTIRE analysis inside a
 * worker thread so no synchronous SQLite statement (bm25 scans, blob reads
 * over the 239 GB corpus) can stall the server's event loop. The worker
 * reuses the byte-identical sync path (bridge + core); inside a dedicated
 * thread, blocking is free.
 *
 * Protocol: { id, text, skipQuoteRanges? } →
 *           { id, ok: true, report } | { id, ok: false, error }.
 * The corpus handle is opened once (readonly, query_only — the ETL swaps
 * whole files, never mutates in place) and reused for its 64 MB page cache.
 */
import { parentPort } from "node:worker_threads";
import type Database from "better-sqlite3";
import { openCorpus } from "../db.js";
import { verifyText } from "./verify.js";

interface WorkerRequest {
  id: number;
  text: string;
  skipQuoteRanges?: Array<[number, number]>;
}

const port = parentPort;
if (!port) throw new Error("verify_worker.ts must run as a worker thread");

let corpus: Database.Database | null = null;
let corpusError: string | null = null;
try {
  corpus = openCorpus();
} catch (e) {
  // No corpus in this environment: every request fails with a clear
  // error and the caller degrades to its own in-thread handle.
  corpusError = `worker corpus unavailable: ${String((e as Error)?.message ?? e)}`;
}

port.on("message", (req: WorkerRequest) => {
  if (corpusError) {
    port.postMessage({ id: req.id, ok: false, error: corpusError });
    return;
  }
  try {
    const report = verifyText(corpus!, req.text, {
      skipQuoteRanges: req.skipQuoteRanges,
    });
    port.postMessage({ id: req.id, ok: true, report });
  } catch (e) {
    port.postMessage({
      id: req.id,
      ok: false,
      error: String((e as Error)?.message ?? e),
    });
  }
});
