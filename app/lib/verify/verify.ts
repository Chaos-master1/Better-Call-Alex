/**
 * The G2 Verifier (CLAUDE.md §3). Pure code — no LLM.
 *
 * Contract (docs/verifier.md):
 *   - every full citation must resolve through citation_strings, else
 *     `unresolved_citation` and overall=fail (§5.1);
 *   - every quoted span must match the text of the case it is attributed
 *     to, else `quote_not_found` / `quote_wrong_case` (+ best-effort true
 *     source) and overall=fail (§5.2);
 *   - short/id/supra forms resolve through the draft's own antecedent
 *     (nearest preceding verified full cite, matching vol+rep; Id. = the
 *     immediately preceding one) or stay annotated `unsupported_form`;
 *   - pin pages are never verified (the corpus has no star pagination) —
 *     annotated `pin_unverified`;
 *   - treatment flags are INFERRED signals read from the authority table,
 *     never asserted facts (§5.5).
 *
 * Unverifiable content is reported, never silently dropped. Struck-through
 * rendering is G3's job; this module emits the report it renders.
 * The analysis core shared with verify_async.ts lives in core.ts.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { resolveRepo } from "../repo.js";
import {
  analyzeCitationsAndQuotes,
  bridgeErrorEntry,
  type AnalyzeOptions,
  type BridgeCitation,
  type VerificationReport,
} from "./core.js";

// The analysis core (types, quote ladder, treatment labels, verdict) is the
// single implementation shared with verify_async.ts. Re-exported here so
// existing imports from this module (render.ts, evals, tests) keep working.
export * from "./core.js";

const REPO = resolveRepo();
const BRIDGE = path.join(REPO, "verifier", "bridge.py");

export function pythonBin(): string {
  if (process.env.VERIFY_PYTHON) return process.env.VERIFY_PYTHON;
  const venv = path.join(REPO, ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return "python3";
}

function runBridge(text: string): BridgeCitation[] {
  const proc = spawnSync(pythonBin(), [BRIDGE], {
    input: JSON.stringify({ texts: [text] }),
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    throw new Error(`eyecite bridge failed (${proc.status}): ${proc.stderr?.slice(-400)}`);
  }
  let payload: { results: BridgeCitation[][]; error?: string };
  try {
    payload = JSON.parse(proc.stdout!) as { results: BridgeCitation[][]; error?: string };
  } catch {
    return [bridgeErrorEntry(`bridge non-JSON output: ${String(proc.stdout ?? "")}`)];
  }
  if (payload.error) throw new Error(`bridge protocol: ${String(payload.error)}`);
  // Error entries ride through to the core, which surfaces them as
  // `unresolved_citation` — unverifiable content is reported, never
  // silently dropped.
  return payload.results[0] ?? [];
}

export function verifyText(
  db: Database.Database,
  text: string,
  opts: AnalyzeOptions = {}
): VerificationReport {
  return analyzeCitationsAndQuotes(db, runBridge(text), text, opts);
}
