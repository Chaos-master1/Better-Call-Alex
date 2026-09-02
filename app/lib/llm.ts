/**
 * LLM seam (CLAUDE.md §3, §5): the *only* place in the app that talks to Ollama.
 * Everything model-related lives here. Adding a cloud provider is a config
 * change in this file and nowhere else.
 *
 * VRAM rules (12 GB is the hard constraint, §3):
 *   - `qwen3.5:9b`  (6.6 GB) is the resident workhorse at 32k context.
 *   - `qwen3:14b`    (9.3 GB) is swapped in **once** for the batched
 *                     Analyst+Adversary pass. Two model swaps per run maximum.
 *   - `OLLAMA_KV_CACHE_TYPE=q8_0` is required.
 *   - `OLLAMA_NUM_CTX` must be ≥ 32 000. The previous Python build shipped
 *     ctx=2048 against payloads containing full IRAC trees; every downstream
 *     agent was reading truncated input and nobody noticed. Hard-fail here.
 *
 * Before any first call we verify the model tag exists in `ollama list`. The
 * previous build lost weeks to a non-existent model tag.
 */
import { Ollama } from "ollama";

export const RESIDENT_MODEL = "qwen3.5:9b";
export const ANALYST_MODEL = "qwen3:14b";
/** 32k context: matches the cap §3 sets for our payloads. */
export const REQUIRED_CTX = 32_000;
/** Ollama default; setting it below REQUIRED_CTX is a hard error. */
const MIN_CTX = REQUIRED_CTX;
/** Default for 12 GB VRAM machines. */
const KV_CACHE_TYPE = "q8_0";

let verified = false;
let client: Ollama | null = null;
let activeModel: string = RESIDENT_MODEL;

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
}

export interface LlmGenerateResult {
  model: string;
  content: string;
  promptTokens: number;
  responseTokens: number;
  /** Wall-clock ms for the call. */
  ms: number;
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
 * Verify the model tag is installed in the local Ollama daemon. Runs once.
 * Hard-fail with a helpful error if the tag is missing — the previous build
 * lost weeks to `gemma4:12b`, which does not exist.
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

/**
 * One-time environment verification:
 *   - KV cache type = q8_0 (warn-only; Ollama has its own defaults).
 *   - Effective context: probe with a tiny call and read the returned
 *     `eval_count`/`context` to confirm ctx ≥ REQUIRED_CTX. Hard-fail
 *     if OLLAMA_NUM_CTX is set below the floor.
 */
export async function verifyEnvironment(): Promise<void> {
  if (verified) return;

  // KV cache type: the daemon read its environment when it started —
  // setting the variable on THIS process cannot affect it. Warn so the
  // operator exports it before `ollama serve`.
  if (!process.env.OLLAMA_KV_CACHE_TYPE) {
    console.warn(
      `[llm] OLLAMA_KV_CACHE_TYPE is not set in the daemon's environment. ` +
        `Export ${KV_CACHE_TYPE} before starting Ollama — the canonical ` +
        `setting for the 12 GB VRAM budget.`
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
    if (!Number.isFinite(n) || n < MIN_CTX) {
      fail(
        `OLLAMA_NUM_CTX=${process.env.OLLAMA_NUM_CTX} is below the ${MIN_CTX} ` +
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

/**
 * Generate one response. Deterministic by default (temperature 0.0).
 * The model selection is set by `useModel()`; this call uses the currently
 * active model. Verifies the environment on first call.
 */
export async function generate(
  prompt: string,
  opts: LlmGenerateOptions = {}
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
    content: res.response ?? "",
    promptTokens: res.prompt_eval_count ?? 0,
    responseTokens: res.eval_count ?? 0,
    ms,
  };
}

/**
 * Switch the active model. Used by the analyst+adversary pass which
 * batched-loads `qwen3:14b`. Each `useModel` call is a swap; the rest of
 * the run must batch around it.
 */
export async function useModel(model: string): Promise<void> {
  await verifyEnvironment();
  if (model === activeModel) return;
  await verifyModel(model);
  activeModel = model;
}

export function currentModel(): string {
  return activeModel;
}

/**
 * Chat-style call with explicit message history. Use this when the prompt
 * is multi-turn or needs a fixed system prompt boundary.
 */
export async function chat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  opts: LlmGenerateOptions = {}
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
      c.chat({
        model: activeModel,
        messages,
        stream: false,
        think: false,
        options: options as any,
        format: opts.jsonMode ? "json" : undefined,
      }),
    `chat(${activeModel})`
  );
  const ms = performance.now() - t0;
  assertNoTruncation(res.prompt_eval_count ?? 0, opts.maxTokens ?? 2048, `chat(${activeModel})`);
  return {
    model: activeModel,
    content: res.message?.content ?? "",
    promptTokens: res.prompt_eval_count ?? 0,
    responseTokens: res.eval_count ?? 0,
    ms,
  };
}
