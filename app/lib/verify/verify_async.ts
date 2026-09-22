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

export async function verifyTextAsync(
  db: Database.Database,
  text: string,
  opts: AnalyzeOptions = {}
): Promise<VerificationReport> {
  const extracted = await runBridgeAsync(text);
  return analyzeCitationsAndQuotesAsync(db, extracted, text, opts);
}
