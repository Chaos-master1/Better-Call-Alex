/**
 * LLM seam (CLAUDE.md §3, §5; ADR-004): the *only* place in the app that
 * talks to any model. Everything model-related lives here.
 *
 * Providers (ADR-004 — hybrid inference, user-selectable, verifier-gated
 * either way):
 *   - OllamaProvider — the original local tier, behavior byte-identical.
 *   - OpenAICompatProvider — any OpenAI-compatible endpoint (vendored API,
 *     self-hosted vLLM/LM Studio, corporate gateway) via ALEX_CLOUD_*.
 *
 * The provider choice is per-stage (auto mode): the Researcher stays local
 * because it writes queries for OUR FTS dialect; Analyst+Adversary ride
 * the frontier when configured. The verifier gates both identically — it
 * reads text, not engines (§5.1–5.2 are engine-agnostic by construction).
 *
 * VRAM rules (12 GB is the hard constraint, §3) — local tier only:
 *   - `qwen3.5:9b`  (6.6 GB) is the resident workhorse at 32k context.
 *   - `qwen3:14b`    (9.3 GB) is swapped in **once** for the batched
 *                     Analyst+Adversary pass. Two model swaps per run max.
 *   - `OLLAMA_KV_CACHE_TYPE=q8_0` is required (warn-only).
 *   - `OLLAMA_NUM_CTX` must be ≥ 32 000. The previous Python build shipped
 *     ctx=2048 against payloads containing full IRAC trees; every downstream
 *     agent was reading truncated input and nobody noticed. Hard-fail here.
 *
 * Before any first call we verify the model tag exists (`ollama list`
 * locally, `GET /models` on the cloud). The previous build lost weeks to a
 * non-existent model tag; the cloud tier gets the same scar-tissue check.
 */
import { Ollama } from "ollama";
import {
  engineConfig,
  scrubSecrets,
  type CloudConfig,
  type EngineConfig,
  type EngineMode,
} from "./env.js";

export const RESIDENT_MODEL = "qwen3.5:9b";
export const ANALYST_MODEL = "qwen3:14b";
/** 32k context: matches the cap §3 sets for our payloads. Also the floor
 *  OLLAMA_NUM_CTX may not undercut. */
export const REQUIRED_CTX = 32_000;

/** Engine identity: "local" | "cloud". */
export type EngineId = "local" | "cloud";
export type { EngineMode } from "./env.js";

let verified = false;
let cloudVerified = false;
let client: Ollama | null = null;
/** The local-tier active model (useModel swap target). */
let activeModel: string = RESIDENT_MODEL;
/** The stage→engine routing resolved for THIS process (auto mode). */
let resolvedConfig: EngineConfig | null = null;
/** The engine the next generate() call will use (run.ts pins stages). */
let activeEngine: EngineId = "local";
/** Which stage is running — auto mode routes on it. */
let activeStage: string | null = null;
/** Per-run mode override (ADR-004 UI toggle). runCase holds the
 *  single-flight slot for the whole run, so module-level engine state can
 *  never interleave between runs. */
let runModeOverride: EngineMode | null = null;
/** Last cloud→local fallback, consumed by the run orchestrator for the
 *  disclosure audit row (fail-loud, never silent). */
let lastFallbackEvent: { stage: string; error: string } | null = null;

interface LlmGenerateOptions {
  /** Override the system prompt. */
  system?: string;
  /** Sampling temperature. Default 0.0 for legal determinism (§5). */
  temperature?: number;
  /** Hard cap on response tokens. Default 2048. */
  maxTokens?: number;
  /** Stop sequences. */
  stop?: string[];
  /** When true, JSON-mode: ask the model to return a single JSON object. */
  jsonMode?: boolean;
  /** Stage name for auto routing ("intake" | "researcher" | "analyst" |
   *  "adversary" | any custom). Callers that do not set it inherit the
   *  current engine. */
  stage?: string;
  /** Per-call override of the cloud failure policy. Default comes from
   *  ALEX_CLOUD_FALLBACK (abort). The run orchestrator passes the per-run
   *  UI choice through here. */
  fallback?: "abort" | "local";
}

export interface LlmGenerateResult {
  model: string;
  /** Engine that produced this content: "local" | "cloud". */
  engine: EngineId;
  content: string;
  promptTokens: number;
  responseTokens: number;
  /** Wall-clock ms for the call. */
  ms: number;
  /** Cloud provider response id (request provenance for audit). */
  responseId?: string;
  /** True when this call fell back from cloud to local (disclosed upstream). */
  fallback?: boolean;
}

function fail(msg: string): never {
  throw new Error(`[llm] ${msg}`);
}

function getClient(): Ollama {
  if (client) return client;
  client = new Ollama({
    host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    // The default undici fetch timeout is 5 minutes; with cold model load
    // (20+ s) + JSON-mode parse + a 32k context the first call can push
    // 120 s on a slow disk. Set a generous ceiling.
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        // Caller-provided signals (e.g. an aborted request) must win; the
        // 10-minute ceiling applies only when none was given.
        signal: init?.signal ?? AbortSignal.timeout(10 * 60_000),
      }),
  });
  return client;
}

/**
 * Verify the model tag is installed in the local Ollama daemon. Hard-fail
 * with a helpful error if the tag is missing — the previous build lost
 * weeks to `gemma4:12b`, which does not exist.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = String(e?.message ?? e);
      const name = String(e?.name ?? "");
      // Abort/timeout are terminal: a deliberate cancel or the hard fetch
      // ceiling must never be retried — the retry loop can otherwise burn
      // ~30 minutes inside a maxDuration-bounded route.
      if (/abort|timeout/i.test(name) || /abort/i.test(msg)) throw e;
      const transient = /fetch failed|ECONNREFUSED|UND_ERR|timeout|socket hang up/i.test(msg);
      if (!transient || i === attempts - 1) throw e;
      const backoff = 1500 * (i + 1) + Math.random() * 500;
      console.warn(`[llm] ${label} transient (${msg.slice(0,120)}) — retry ${i + 1}/${attempts} in ${Math.round(backoff)}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw last;
}

/**
 * The context-window assert the module header promises. Ollama silently
 * truncates prompts that exceed num_ctx — the exact failure mode that
 * poisoned the previous build (ctx=2048, nobody noticed). The env check
 * cannot catch a too-big payload at runtime, so this reads the measured
 * prompt_eval_count: if the prompt plus the requested response budget does
 * not fit the window, output is corrupted and the run must stop now, not
 * minutes later with garbage.
 */
function assertNoTruncation(
  promptTokens: number,
  maxTokens: number,
  label: string
): void {
  if (promptTokens <= 0) return; // count unavailable (mock/old daemon)
  if (promptTokens + maxTokens <= REQUIRED_CTX) return;
  fail(
    `${label}: prompt filled ${promptTokens} ctx tokens; + ${maxTokens} ` +
      `response budget exceeds the ${REQUIRED_CTX} window — Ollama would ` +
      `silently truncate. Shrink the agent payload (fewer/shorter passages).`
  );
}

async function verifyModel(model: string): Promise<void> {
  const c = getClient();
  const list = await withRetry(() => c.list(), `verifyModel(${model})`);
  const names = new Set(list.models.map((m) => m.name));
  if (!names.has(model)) {
    fail(
      `Model '${model}' is not installed. Available: ` +
        [...names].join(", ") +
        `.\nRun: ollama pull ${model}`
    );
  }
}

// =====================================================================
// Cloud provider (OpenAI-compatible chat completions)
// =====================================================================

interface CloudChatChoiceMessage {
  content?: string | null;
  reasoning_content?: string | null;
}
interface CloudChatChoice {
  message?: CloudChatChoiceMessage;
  finish_reason?: string | null;
}
interface CloudChatResponse {
  id?: string;
  choices?: CloudChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/** Classify a cloud failure for the fallback policy: "transient" is worth
 *  retrying/429-honoring; anything else is terminal for the call. */
export function classifyCloudError(status: number | null, msg: string): "transient" | "terminal" {
  if (status === 429 || status === 408 || status === 502 || status === 503 || status === 504) {
    return "transient";
  }
  if (status == null && /fetch failed|ECONNREFUSED|UND_ERR|socket hang up|terminated/i.test(msg)) {
    return "transient";
  }
  return "terminal";
}

function readRetryAfter(headers: Headers): number | null {
  const ra = headers.get("retry-after");
  if (!ra) return null;
  const s = Number(ra);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 30_000);
  const d = Date.parse(ra);
  if (Number.isFinite(d)) return Math.min(Math.max(0, d - Date.now()), 30_000);
  return null;
}

/**
 * One OpenAI-compatible /chat/completions call with the failure policy:
 * 3× exponential backoff + jitter; 429 honors Retry-After; per-call
 * timeout; `finish_reason:"length"` is the SAME hard truncation error the
 * local tier raises (never parse a truncated response as success);
 * `reasoning_content` (deep-research-style fields) is stripped; a 4xx that
 * names `response_format` is retried once without JSON mode (gateway
 * variance) — JSON tolerance downstream is unchanged (parseJson strips
 * fences). All errors are secret-scrubbed before leaving this function.
 */
async function cloudChat(
  cloud: CloudConfig,
  prompt: string,
  opts: LlmGenerateOptions,
  useJsonMode: boolean
): Promise<LlmGenerateResult> {
  const maxTokens = opts.maxTokens ?? 2048;
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = {
    model: cloud.model,
    messages,
    temperature: opts.temperature ?? 0.0,
    max_completion_tokens: maxTokens,
    // Measured 2026-09-24: Gemini's OpenAI-compat endpoint STALLS on
    // non-streaming chat/completions POSTs (≥120 s for a 5-token reply
    // while GET /models answers in 0.3 s) but streams the same request
    // in seconds. stream:true is the working protocol; the SSE answer is
    // accumulated into the same result shape. Gateways that answer JSON
    // despite stream:true (and llm.test.ts mocks) take the non-SSE parse.
    stream: true,
  };
  if (useJsonMode) body.response_format = { type: "json_object" };
  if (opts.stop && opts.stop.length > 0) body.stop = opts.stop;

  const secrets = [cloud.apiKey];
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(`${cloud.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cloud.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cloud.timeoutMs),
      });
    } catch (e: any) {
      const msg = scrubSecrets(String(e?.message ?? e), secrets);
      if (/abort|timeout/i.test(String(e?.name ?? ""))) {
        fail(`cloud generate: ${msg} (after ${cloud.timeoutMs}ms ceiling)`);
      }
      lastErr = new Error(`cloud generate: ${msg}`);
      if (classifyCloudError(null, msg) === "transient" && attempt < 2) {
        const backoff = 1500 * (attempt + 1) + Math.random() * 500;
        console.warn(
          `[llm] cloud transient (${msg.slice(0, 120)}) — retry ${attempt + 1}/3 in ${Math.round(backoff)}ms`
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw lastErr;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const msg = scrubSecrets(`${res.status} ${res.statusText}: ${raw.slice(0, 400)}`, secrets);
      // Gateway rejects response_format: retry once without JSON mode.
      if (useJsonMode && res.status === 400 && /response_format/i.test(raw)) {
        console.warn("[llm] cloud rejected response_format — retrying without JSON mode");
        return cloudChat(cloud, prompt, opts, false);
      }
      if (classifyCloudError(res.status, msg) === "transient" && attempt < 2) {
        const ra = readRetryAfter(res.headers);
        // Demand-shaped failures (429/503) rarely carry Retry-After; the
        // live endpoint's "high demand" 503s need seconds, not the 1.5–4.5s
        // network-blip ladder. Proportionate patience, still bounded.
        const demandShape = res.status === 429 || res.status === 503;
        const backoff =
          ra ??
          (demandShape
            ? [6_000, 15_000, 30_000][attempt] + Math.random() * 2_000
            : 1500 * (attempt + 1) + Math.random() * 500);
        console.warn(
          `[llm] cloud ${res.status} — retry ${attempt + 1}/3 in ${Math.round(backoff)}ms`
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      fail(`cloud generate failed: ${msg}`);
    }

    // Dual-protocol parse: the content-type decides. `text/event-stream`
    // accumulates OpenAI-style SSE deltas (the measured-working Gemini
    // path); anything else is a classic JSON envelope (gateways that
    // ignore stream:true, and the mocked unit tests).
    let payload: CloudChatResponse;
    const ctype = res.headers.get("content-type") ?? "";
    if (/text\/event-stream/i.test(ctype)) {
      let acc: CloudChatResponse;
      try {
        acc = await readSseChat(res);
      } catch (e: any) {
        // Mid-stream transport failure is transient like any network blip.
        if ((e as any)?.sseTransient && attempt < 2) {
          const backoff = 1500 * (attempt + 1) + Math.random() * 500;
          console.warn(`[llm] cloud SSE stream failed — retry ${attempt + 1}/3 in ${Math.round(backoff)}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw e;
      }
      if (acc.error) {
        const emsg = typeof acc.error === "string" ? acc.error : acc.error.message ?? "unknown";
        fail(`cloud generate failed: ${scrubSecrets(emsg, secrets).slice(0, 300)}`);
      }
      payload = acc;
    } else {
      try {
        payload = (await res.json()) as CloudChatResponse;
      } catch (e: any) {
        fail(`cloud generate: non-JSON response: ${scrubSecrets(String(e?.message ?? e), secrets).slice(0, 200)}`);
      }
    }
    if (payload.error) {
      const emsg =
        typeof payload.error === "string" ? payload.error : payload.error.message ?? "unknown";
      fail(`cloud generate failed: ${scrubSecrets(emsg, secrets).slice(0, 300)}`);
    }
    const choice = payload.choices?.[0];
    // finish_reason "length" = the cloud silently truncated. Map to the
    // same hard error the local tier raises — a truncated IRAC is garbage.
    if (choice?.finish_reason === "length") {
      fail(
        `cloud generate truncated (finish_reason=length) at maxTokens=${maxTokens}. ` +
          `Shrink the agent payload (fewer/shorter passages).`
      );
    }
    const raw = choice?.message?.content ?? "";
    const reasoning = choice?.message?.reasoning_content;
    if (reasoning) {
      // Provenance, not content: reasoning fields are never concatenated
      // into the draft — they are the vendor's scratch, not verified text.
      console.log(`[llm] cloud returned reasoning_content (${String(reasoning).length} chars) — stripped`);
    }
    return {
      model: cloud.model,
      engine: "cloud",
      content: raw,
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      responseTokens: payload.usage?.completion_tokens ?? 0,
      ms: performance.now() - t0,
      responseId: payload.id,
    };
  }
  // Unreachable (loop returns or throws every iteration).
  fail("cloud generate: exhausted retries");
}

/**
 * Read an OpenAI-style SSE chat stream into the non-streaming envelope
 * shape (content joined from deltas; finish_reason/usage/id carried when
 * the provider sends them). A transport failure MID-STREAM surfaces as a
 * retryable transient error, not silent truncation — a half-received
 * draft must never parse as success.
 */
async function readSseChat(res: Response): Promise<CloudChatResponse> {
  const reader = res.body?.getReader();
  if (!reader) fail("cloud generate: streaming response has no body");
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let finish: string | null = null;
  let id: string | undefined;
  let usage: CloudChatResponse["usage"];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let evt: any;
        try {
          evt = JSON.parse(data);
        } catch {
          continue; // keep-alive comment or split frame — ignore
        }
        if (evt.error) {
          const em = typeof evt.error === "string" ? evt.error : evt.error.message ?? "unknown";
          fail(`stream error: ${em}`);
        }
        if (typeof evt.id === "string") id = evt.id;
        if (evt.usage) usage = evt.usage;
        const ch = evt.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const delta = ch.delta?.content;
        if (typeof delta === "string") content += delta;
      }
    }
  } catch (e: any) {
    // Mid-stream transport failure: retryable, never a silent truncation.
    const err = new Error(`SSE stream failed: ${String(e?.message ?? e)}`);
    (err as any).sseTransient = true;
    throw err;
  }
  return {
    id,
    choices: [{ message: { content }, finish_reason: finish }],
    usage,
  };
}

/** Strip a gateway's model-id prefix (Gemini lists "models/gemini-…") so
 *  comparisons run on the bare name the chat endpoint accepts. */
export function normalizeCloudModelId(id: string): string {
  return String(id ?? "").replace(/^models\//, "");
}

/**
 * Startup cloud verification: the key must authenticate and the endpoint
 * must answer (`GET /models`) — the cloud twin of the `ollama list` check.
 *
 * The model check is ADVISORY, not a hard fail: the live Gemini endpoint
 * proved its /models list stale (it omitted the very model its own 404
 * remediation message recommended), so a list-absent model may still work.
 * A typo'd model name fails loud at the first chat call instead, with the
 * provider's own error — which is the authoritative existence check.
 */
async function verifyCloud(cloud: CloudConfig): Promise<void> {
  if (cloudVerified) return;
  const secrets = [cloud.apiKey];
  let res: Response;
  try {
    res = await fetch(`${cloud.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cloud.apiKey}` },
      signal: AbortSignal.timeout(Math.min(cloud.timeoutMs, 30_000)),
    });
  } catch (e: any) {
    const msg = scrubSecrets(String(e?.message ?? e), secrets).slice(0, 200);
    throw new Error(`[llm] cloud endpoint unreachable at ${cloud.baseUrl}: ${msg}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("[llm] cloud authentication failed (401/403) — check ALEX_CLOUD_API_KEY");
  }
  if (!res.ok) {
    throw new Error(
      `[llm] cloud /models failed: ${res.status} ${res.statusText} — ` +
        scrubSecrets(await res.text().catch(() => ""), secrets).slice(0, 200)
    );
  }
  let payload: { data?: Array<{ id?: string }> };
  try {
    payload = (await res.json()) as { data?: Array<{ id?: string }> };
  } catch {
    throw new Error("[llm] cloud /models returned non-JSON — endpoint is not OpenAI-compatible");
  }
  const names = new Set(
    (payload.data ?? []).map((m) => normalizeCloudModelId(String(m.id ?? "")))
  );
  if (names.size > 0 && !names.has(normalizeCloudModelId(cloud.model))) {
    console.warn(
      `[llm] WARNING: cloud model '${cloud.model}' is not in ${cloud.baseUrl}/models ` +
        `(lists can be stale — e.g. Gemini's omits models its chat endpoint serves). ` +
        `Proceeding; the first chat call fails loud if it is really absent. ` +
        `Listed: ${[...names].slice(0, 12).join(", ")}…`
    );
  }
  cloudVerified = true;
}

// =====================================================================
// Engine routing
// =====================================================================

function cfg(): EngineConfig {
  if (!resolvedConfig) resolvedConfig = engineConfig();
  if (runModeOverride && resolvedConfig.mode !== runModeOverride) {
    return { ...resolvedConfig, mode: runModeOverride };
  }
  return resolvedConfig;
}

/** Per-run engine mode override (ADR-004): the server route passes the
 *  per-run UI toggle; the CLI passes null (env mode, default local). */
export function setRunMode(mode: EngineMode | null): void {
  runModeOverride = mode;
}

/** Drop the cloud engine pin between stages/runs: the next useEngine()
 *  re-pins from scratch. The LOCAL active model is untouched (the swap
 *  accounting belongs to useModel). */
export function resetEngineToLocal(): void {
  activeEngine = "local";
  activeStage = null;
}

/** Engine for a stage under the current mode. Cloud is only routable when
 *  a key is configured; otherwise the stage stays local (fail-closed in
 *  the harmless direction, but useEngine throws for explicit cloud). */
export function engineForStage(stage: string): EngineId {
  const c = cfg();
  if (c.mode === "cloud") return c.cloud ? "cloud" : "local";
  if (c.mode === "auto") {
    const route = c.autoRoute[stage] ?? "local";
    return route === "cloud" && c.cloud ? "cloud" : "local";
  }
  return "local";
}

/**
 * Pin the engine for the next stage. run.ts calls this at each stage
 * boundary (the same place it calls useModel). In auto mode the stage name
 * selects the engine; explicit local/cloud pin it directly. Returns the
 * engine actually pinned (callers record it in audit rows).
 */
export async function useEngine(
  engine: EngineId | "auto",
  stage?: string
): Promise<EngineId> {
  const c = cfg();
  let target: EngineId;
  if (engine === "auto") {
    target = engineForStage(stage ?? activeStage ?? "");
    activeStage = stage ?? activeStage;
  } else {
    target = engine;
    activeStage = stage ?? null;
  }
  if (target === "cloud") {
    if (!c.cloud) {
      fail(
        "cloud engine requested but no ALEX_CLOUD_API_KEY is configured. " +
          "Add the key to .env (never commit it) or run with the local engine."
      );
    }
    await verifyCloud(c.cloud);
  } else {
    await verifyEnvironment();
  }
  activeEngine = target;
  return target;
}

/** Fallback policy resolution: explicit `fallback` option wins (per-run
 *  UI toggle), else env (default abort — honest failure, never silent
 *  degradation). */
function fallbackPolicy(explicit?: "abort" | "local"): "abort" | "local" {
  if (explicit) return explicit;
  return cfg().cloud?.fallback ?? "abort";
}

/**
 * Generate one response. Deterministic by default (temperature 0.0).
 * Local tier: model selection is set by `useModel()`; the engine by
 * `useEngine()`. Cloud tier: routed by stage in auto mode.
 */
export async function generate(
  prompt: string,
  opts: LlmGenerateOptions = {}
): Promise<LlmGenerateResult> {
  const c = cfg();
  const stage = opts.stage ?? activeStage ?? "";
  // Explicit per-call stage override re-routes (auto mode) without a
  // pin: the run orchestrator pins once per stage; agents may pass stage
  // explicitly for sub-calls that belong to a different route.
  let engine: EngineId;
  if (opts.stage && opts.stage !== activeStage) {
    engine = engineForStage(stage);
  } else {
    engine = activeEngine;
  }
  if (engine === "cloud") {
    if (!c.cloud) {
      fail("cloud engine selected but no ALEX_CLOUD_API_KEY is configured (check .env)");
    }
    await verifyCloud(c.cloud);
    const wirePrompt = cloudTransform ? cloudTransform(stage, prompt) : prompt;
    try {
      return await cloudChat(c.cloud, wirePrompt, opts, !!opts.jsonMode);
    } catch (e: any) {
      const msg = scrubSecrets(String(e?.message ?? e), [c.cloud.apiKey]).slice(0, 300);
      if (fallbackPolicy(opts.fallback) === "local") {
        console.warn(`[llm] cloud stage failed — falling back to LOCAL (disclosed): ${msg}`);
        lastFallbackEvent = { stage: stage || "unpinned", error: msg };
        const out = await generateLocal(prompt, opts);
        return { ...out, fallback: true };
      }
      throw e;
    }
  }
  return generateLocal(prompt, opts);
}

/** Local-tier generate (the original implementation, byte-identical). */
async function generateLocal(
  prompt: string,
  opts: LlmGenerateOptions
): Promise<LlmGenerateResult> {
  await verifyEnvironment();
  const c = getClient();
  const temperature = opts.temperature ?? 0.0;
  const options: Record<string, unknown> = {
    temperature,
    num_ctx: REQUIRED_CTX,
    num_predict: opts.maxTokens ?? 2048,
  };
  if (opts.stop && opts.stop.length > 0) options.stop = opts.stop;
  const t0 = performance.now();
  const res = await withRetry(
    () =>
      c.generate({
        model: activeModel,
        prompt,
        system: opts.system,
        stream: false,
        think: false,
        options: options as any,
        format: opts.jsonMode ? "json" : undefined,
      }),
    `generate(${activeModel})`
  );
  const ms = performance.now() - t0;
  assertNoTruncation(res.prompt_eval_count ?? 0, opts.maxTokens ?? 2048, `generate(${activeModel})`);
  return {
    model: activeModel,
    engine: "local",
    content: res.response ?? "",
    promptTokens: res.prompt_eval_count ?? 0,
    responseTokens: res.eval_count ?? 0,
    ms,
  };
}

/**
 * Switch the active LOCAL model. Used by the analyst+adversary pass which
 * batched-loads `qwen3:14b`. Each `useModel` call is a swap; the rest of
 * the run must batch around it. In cloud mode this is a no-op (the run
 * keeps its shape; the engine governs which model matters).
 */
export async function useModel(model: string): Promise<void> {
  if (activeEngine === "cloud") return;
  await verifyEnvironment();
  if (model === activeModel) return;
  await verifyModel(model);
  activeModel = model;
}

/** The ONE owner of the engine-qualified model identity recorded in audit
 *  rows, history rows, and run summaries: "local:qwen3:14b" / "cloud:gpt-5".
 *  The cloud model name is resolved here — callers never assemble it. */
export function engineQualifiedModel(engine: EngineId, localModel: string): string {
  return engine === "cloud" ? `cloud:${cfg().cloud?.model ?? "?"}` : `local:${localModel}`;
}

/** Engine-qualified identity of the CURRENTLY pinned stage (eval summaries). */
export function currentModel(): string {
  return engineQualifiedModel(activeEngine, activeModel);
}

/** Consume the pending fallback disclosure (run.ts audits it per stage). */
export function consumeFallbackEvent(): { stage: string; error: string } | null {
  const e = lastFallbackEvent;
  lastFallbackEvent = null;
  return e;
}

// ---- stage payload transforms (ADR-004 §2.4) ----------------------------
// Cloud payloads carry client facts. Two protections are registered per
// run and applied INSIDE the llm seam — exactly where the routed engine is
// known — so an agent cannot forget them and local mode is untouched by
// construction.

let cloudTransform: ((stage: string, prompt: string) => string) | null = null;

/** Register the cloud-payload transform for this run (redaction, caps).
 *  Registered by runCase before stage 1; cleared in its finally. */
export function setCloudPayloadTransform(
  fn: ((stage: string, prompt: string) => string) | null
): void {
  cloudTransform = fn;
}

/** Fallback-visibility hook: agents render prompts uniformly (no engine
 *  awareness), but the UI must disclose which engine produced each stage.
 *  The run orchestrator consumes this per stage and records it. */
export function stageRoutedEngine(stage: string): EngineId {
  return engineForStage(stage);
}

/** @internal test hook — resets cached config/verification/engine state. */
export function __resetEngineStateForTests(): void {
  resolvedConfig = null;
  cloudVerified = false;
  verified = false;
  activeEngine = "local";
  activeStage = null;
  runModeOverride = null;
  lastFallbackEvent = null;
  cloudTransform = null;
}

/** True when a cloud key is configured (UI can offer the toggle). */
export function cloudAvailable(): boolean {
  return cfg().cloud != null;
}

/**
 * One-time LOCAL environment verification:
 *   - KV cache type = q8_0 (warn-only; Ollama has its own defaults).
 *   - Effective context floor (OLLAMA_NUM_CTX ≥ 32000; hard-fail lower).
 *   - Resident + analyst models actually installed.
 */
export async function verifyEnvironment(): Promise<void> {
  if (verified) return;

  // KV cache type: the daemon read its environment when it started —
  // setting the variable on THIS process cannot affect it. Warn so the
  // operator exports it before `ollama serve`.
  if (!process.env.OLLAMA_KV_CACHE_TYPE) {
    console.warn(
      `[llm] OLLAMA_KV_CACHE_TYPE is not set in the daemon's environment. ` +
        `Export q8_0 before starting Ollama — the canonical setting for ` +
        `the 12 GB VRAM budget.`
    );
  } else if (
    process.env.OLLAMA_KV_CACHE_TYPE !== "q8_0" &&
    process.env.OLLAMA_KV_CACHE_TYPE !== "q8"
  ) {
    // The previous benchmark fixed this to q8_0; warn loudly but don't fail
    // — operators may have a reason. Make it impossible to miss.
    console.warn(
      `[llm] WARNING: OLLAMA_KV_CACHE_TYPE=${process.env.OLLAMA_KV_CACHE_TYPE}; ` +
        `expected q8_0. This is the canonical setting for the 12 GB VRAM budget.`
    );
  }

  // Context floor: fail fast if the operator set the killer value.
  if (process.env.OLLAMA_NUM_CTX != null) {
    const n = Number(process.env.OLLAMA_NUM_CTX);
    if (!Number.isFinite(n) || n < REQUIRED_CTX) {
      fail(
        `OLLAMA_NUM_CTX=${process.env.OLLAMA_NUM_CTX} is below the ${REQUIRED_CTX} ` +
          `floor. The previous build shipped 2048 against full IRAC trees; ` +
          `every downstream agent read truncated input. Unset the env var ` +
          `and let the resident model use its 32k default.`
      );
    }
  }

  // Verify the resident model is actually installed, plus the analyst
  // model so a late swap does not fail 60s into a pipeline (P1-6).
  await verifyModel(RESIDENT_MODEL);
  await verifyModel(ANALYST_MODEL);

  verified = true;
}


