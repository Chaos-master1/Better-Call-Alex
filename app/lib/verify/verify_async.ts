/**
 * Async wrapper for the G2 Verifier — uses child_process.spawn instead of
 * spawnSync so the Next.js request thread is not blocked while Python/eyecite
 * imports (~0.3s). All analysis is delegated to core.ts (shared with the
 * sync verifyText); this file owns only the async subprocess invocation.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type Database from "better-sqlite3";
import { resolveRepo } from "../repo.js";
import { pythonBin } from "./verify.js";
import {
  analyzeCitationsAndQuotes,
  type AnalyzeOptions,
  type BridgeCitation,
  type VerificationReport,
} from "./core.js";

const REPO = resolveRepo();
const BRIDGE = path.join(REPO, "verifier", "bridge.py");

function runBridgeAsync(text: string): Promise<BridgeCitation[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin(), [BRIDGE]);
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
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("eyecite bridge timeout after 120s"));
      if (code !== 0) {
        return reject(new Error(`eyecite bridge failed (${code}): ${stderr.slice(-400)}`));
      }
      try {
        const payload = JSON.parse(stdout) as { results: BridgeCitation[][]; error?: string };
        if (payload.error) return reject(new Error(`bridge protocol: ${payload.error}`));
        // Error entries ride through to the core, which surfaces them as
        // `unresolved_citation` — unverifiable content is reported, never
        // silently dropped.
        resolve(payload.results[0] ?? []);
      } catch (e) {
        reject(e);
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

export async function verifyTextAsync(
  db: Database.Database,
  text: string,
  opts: AnalyzeOptions = {}
): Promise<VerificationReport> {
  const extracted = await runBridgeAsync(text);
  return analyzeCitationsAndQuotes(db, extracted, text, opts);
}
