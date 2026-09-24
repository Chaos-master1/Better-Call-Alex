/**
 * Async wrapper for the G2 Verifier. Two layers keep the Next.js request
 * thread responsive:
 *   1. the eyecite bridge runs in a child_process.spawn (never spawnSync,
 *      whose Python import ~0.3s would block);
 *   2. the corpus analysis runs in a worker thread (Phase C) — single
 *      synchronous SQLite statements (bm25 scans, blob reads over the
 *      239 GB corpus) cannot be interrupted, only moved off the loop.
 * All analysis itself is delegated to core.ts (shared with the sync
 * verifyText); this file owns only the async subprocess/thread invocation.
 */
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { resolveRepo } from "../repo.js";
import { CORPUS_PATH } from "../db.js";
import { pythonBin } from "./verify.js";
import {
  analyzeCitationsAndQuotesAsync,
  bridgeErrorEntry,
  type AnalyzeOptions,
  type BridgeCitation,
  type VerificationReport,
} from "./core.js";

const REPO = resolveRepo();
const BRIDGE = path.join(REPO, "verifier", "bridge.py");

function runBridgeAsync(text: string): Promise<BridgeCitation[]> {
  return new Promise<BridgeCitation[]>((resolve) => {
    const fail = (detail: string) => resolve([bridgeErrorEntry(detail)]);
    let proc;
    try {
      proc = spawn(pythonBin(), [BRIDGE]);
    } catch (e) {
      fail(`eyecite bridge spawn failed: ${String((e as Error)?.message ?? e)}`);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, 120_000);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => {
      clearTimeout(timer);
      fail(`eyecite bridge process error: ${String(e?.message ?? e)}`);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return fail("eyecite bridge timeout after 120s");
      if (code !== 0) {
        return fail(`eyecite bridge failed (${code}): ${stderr}`);
      }
      try {
        const payload = JSON.parse(stdout) as { results: BridgeCitation[][]; error?: string };
        if (payload.error) return fail(`bridge protocol: ${String(payload.error)}`);
        // Error entries ride through to the core, which surfaces them as
        // `unresolved_citation` — unverifiable content is reported, never
        // silently dropped.
        resolve(payload.results[0] ?? []);
      } catch {
        fail(`bridge non-JSON output: ${stdout}`);
      }
    });
    // EPIPE when the bridge dies before reading stdin: the proc-level
    // error/close handlers own the real rejection, so swallow the stream
    // error — an unhandled 'error' here becomes an uncaught exception that
    // can take down the server worker.
    proc.stdin.on("error", () => {});
    proc.stdin.write(JSON.stringify({ texts: [text] }));
    proc.stdin.end();
  });
}

/**
 * Worker pool (Phase C) — the server thread only passes messages; the
 * worker runs the byte-identical sync path (bridge + sync drain) inside
 * its own thread. N=1 is the right size: the analysis is serial per run
 * and single-flight runCase already serializes pipeline runs. The pool
 * owns the worker's lifecycle — a crash fails its pending requests (each
 * degrades to the caller's in-thread handle below) and the next request
 * respawns. `ALEX_VERIFY_WORKER=off` restores the pre-worker in-thread
 * drain (freeze-probe A/B measurement, debugging).
 */
const WORKER_DISABLED = process.env.ALEX_VERIFY_WORKER === "off";

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<
  number,
  { resolve: (r: VerificationReport) => void; reject: (e: Error) => void }
>();

interface WorkerReply {
  id: number;
  ok: boolean;
  report?: VerificationReport;
  error?: string;
}

function failAll(err: Error) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
  worker = null;
}

function spawnWorker(): Worker {
  // `--import tsx` resolves bare "tsx" against the process cwd — the eval
  // harness runs from the repo root, where tsx is NOT installed (it lives
  // in app/), so every worker crashed into in-thread degradation (observed
  // live, g3 cloud run 2026-09-24). Anchor resolution to app/package.json
  // and pass the absolute loader path instead.
  let importSpec = "tsx";
  try {
    const req = createRequire(path.join(REPO, "app", "package.json"));
    // tsx's exports map blocks subpaths; the main entry resolves to the
    // loader file itself (tsx 4.x), so resolving "tsx" IS the loader path.
    const main = req.resolve("tsx");
    importSpec = main.endsWith("loader.mjs") ? pathToFileURL(main).href : "tsx";
  } catch {
    // app/node_modules/tsx missing — keep the bare specifier and let the
    // existing in-thread degradation handle it as before.
  }
  const w = new Worker(path.join(REPO, "app", "lib", "verify", "verify_worker.ts"), {
    execArgv: ["--import", importSpec],
  });
  // Idle-unref'd: an unref'd worker does not keep the parent's event loop
  // alive, so test runners and CLIs exit when their own work is done (the
  // pre-fix pool kept a live ref'd thread forever and hung process exit).
  // verifyTextAsync re-refs for the duration of each in-flight request.
  w.unref();
  w.on("message", (msg: WorkerReply) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (pending.size === 0) w.unref(); // idle again — release the loop
    if (msg.ok) p.resolve(msg.report!);
    else p.reject(new Error(msg.error ?? "worker verify failed"));
  });
  w.on("error", (e: Error) => failAll(new Error(`verify worker crashed: ${e.message}`)));
  w.on("exit", (code) => {
    worker = null;
    if (code !== 0) failAll(new Error(`verify worker exited (${code})`));
  });
  return w;
}

/**
 * The caller's main database file, or null for transient handles
 * (:memory: fixtures, temp files). `database_list` is the SQLite-owned
 * answer — no handle identity heuristics.
 */
function mainDbFile(db: Database.Database): string | null {
  try {
    const rows = db.pragma("database_list") as Array<{
      seq: number;
      name: string;
      file: string;
    }>;
    const main = rows.find((r) => r.name === "main");
    return main?.file ? main.file : null;
  } catch {
    return null;
  }
}

/**
 * The worker runs against ITS OWN openCorpus() handle. That is equivalent
 * to the caller's ONLY when the caller's handle is the real corpus file
 * (production). A test's :memory: fixture has no file — analyzing the real
 * corpus instead would return wrong results against the wrong data.
 */
function canUseWorker(db: Database.Database): boolean {
  if (WORKER_DISABLED) return false;
  const file = mainDbFile(db);
  return !!file && path.resolve(file) === path.resolve(CORPUS_PATH);
}

export async function verifyTextAsync(
  db: Database.Database,
  text: string,
  opts: AnalyzeOptions = {}
): Promise<VerificationReport> {
  if (canUseWorker(db)) {
    if (!worker) worker = spawnWorker();
    const id = ++seq;
    const viaWorker = new Promise<VerificationReport>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    worker.postMessage({ id, text, skipQuoteRanges: opts.skipQuoteRanges });
    // In-flight: hold a loop ref so the process cannot exit before the
    // result lands (the worker itself is unref'd while idle).
    worker.ref();
    try {
      return await viaWorker;
    } catch (e) {
      // Worker unavailable (no corpus, spawn failure, crash): degrade to
      // the caller's own in-thread handle — the server still answers,
      // exactly like the pre-worker path. The pool reset already ran via
      // the worker's error/exit handlers.
      console.error(
        "[verify] worker degraded to in-thread:",
        String((e as Error)?.message ?? e)
      );
    }
  }
  const extracted = await runBridgeAsync(text);
  return analyzeCitationsAndQuotesAsync(db, extracted, text, opts);
}
