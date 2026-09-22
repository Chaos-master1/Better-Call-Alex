/**
 * Environment + secrets (Phase A, ADR-004).
 *
 * Loads the repo `.env` (gitignored — see .gitignore) for the CLI and eval
 * runners; `next dev` also loads it natively, and native wins (a value
 * already present in process.env is NEVER overwritten — the operator's
 * shell export is authoritative).
 *
 * Secrets discipline (the phase's hard rules):
 *   - The API key lives ONLY in the process environment, read at call time.
 *   - Audit rows carry a key FINGERPRINT (first 8 chars of a SHA-256), never
 *     the key.
 *   - Nothing in this module ever logs or returns the key itself; the only
 *     consumer is the OpenAI-compatible provider in llm.ts (Authorization
 *     header, never logged).
 *
 * Never import the key into module scope of anything that renders to the
 * client: every consumer of this file is server-side (lib/, app/api).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveRepo } from "./repo.js";

let loaded = false;

/** Minimal .env reader: `KEY=value` lines, `#` comments, export prefix,
 *  single/double quotes stripped. No interpolation. ~40 lines instead of a
 *  dependency (§2: no dependency without a failing eval case). */
function parseDotEnv(contents: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = body.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out.push([key, val]);
  }
  return out;
}

/**
 * Load `<repo>/.env` once. Existing process.env entries always win, so a
 * `next dev` shell (which loads .env itself) and an operator export are
 * never clobbered. Idempotent; safe to call from every entry point.
 */
export function loadRepoEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    const envPath = path.join(resolveRepo(), ".env");
    const pairs = parseDotEnv(readFileSync(envPath, "utf-8"));
    for (const [k, v] of pairs) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // No .env file is the normal local-only configuration. Nothing to do.
  }
}

export type EngineMode = "local" | "cloud" | "auto";

export interface CloudConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fallback: "abort" | "local";
}

export interface EngineConfig {
  mode: EngineMode;
  /** Per-stage routing for auto mode (stage name → engine). */
  autoRoute: Record<string, "local" | "cloud">;
  cloud: CloudConfig | null;
}

export function parseEngineMode(v: string | undefined): EngineMode {
  const t = String(v ?? "").trim().toLowerCase();
  if (t === "cloud" || t === "auto") return t;
  return "local";
}

export function parseAutoRoute(
  v: string | undefined
): Record<string, "local" | "cloud"> {
  // Default route is deliberate (ADR-004): reasoning-heavy stages go to
  // the frontier; the Researcher stays local because it writes queries for
  // OUR FTS dialect (phrase dictionary, AND semantics) — a frontier model's
  // natural-language queries can retrieve WORSE (docs/ADR-004). Changes to
  // this route require A/B evidence (evals/run_g3_ab.ts), not intuition.
  const route: Record<string, "local" | "cloud"> = {
    intake: "local",
    researcher: "local",
    analyst: "cloud",
    adversary: "cloud",
  };
  for (const part of String(v ?? "").split(",")) {
    const [stage, engine] = part.split(":").map((s) => s.trim().toLowerCase());
    if (!stage || !engine) continue;
    if (engine !== "local" && engine !== "cloud") continue;
    route[stage] = engine;
  }
  return route;
}

/** Read the cloud config. Returns null when no key is configured — the
 *  normal local-only setup. `ALEX_CLOUD_BASE_URL` supports any
 *  OpenAI-compatible gateway (self-hosted vLLM, LM Studio, corporate
 *  proxy) — the provider never hard-codes a vendor. */
export function cloudConfig(): CloudConfig | null {
  loadRepoEnv();
  const apiKey = process.env.ALEX_CLOUD_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (
    process.env.ALEX_CLOUD_BASE_URL?.trim() || "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = process.env.ALEX_CLOUD_MODEL?.trim() || "gpt-5";
  const timeoutMs = Number(process.env.ALEX_CLOUD_TIMEOUT_MS) || 120_000;
  const fallbackRaw = process.env.ALEX_CLOUD_FALLBACK?.trim().toLowerCase();
  const fallback: "abort" | "local" = fallbackRaw === "local" ? "local" : "abort";
  return { baseUrl, apiKey, model, timeoutMs, fallback };
}

/** Resolve the full engine configuration once per process. */
export function engineConfig(): EngineConfig {
  loadRepoEnv();
  const mode = parseEngineMode(process.env.ALEX_ENGINE);
  return {
    mode,
    autoRoute: parseAutoRoute(process.env.ALEX_AUTO_ROUTE),
    cloud: cloudConfig(),
  };
}

/** First 16 hex chars of the SHA-256 of the key. Audit-safe: proves two
 *  runs used the same credential without storing the credential. */
export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/** Scrub anything that looks like a credential out of provider error text
 *  before it reaches a log or an audit row. Provider SDKs occasionally
 *  echo request headers in network errors — that is a real leak vector,
 *  so every provider error passes through here. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  // Bearer tokens in any shape, even unknown ones.
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
  out = out.replace(/(api[-_]?key["']?\s*[:=]\s*)\S+/gi, "$1[redacted]");
  return out;
}
