/**
 * Cloud provider tests — mock fetch, no network, no key.
 *
 * Covers the failure-policy contract (ADR-004 §2.1):
 *   - happy path parses content/usage/id, engine="cloud";
 *   - response_format 4xx → retried once WITHOUT JSON mode;
 *   - finish_reason "length" → the SAME hard truncation error as local;
 *   - 429 honors Retry-After then succeeds;
 *   - terminal 401 → immediate fail-loud error, no retry storm;
 *   - reasoning_content is stripped (never concatenated into content);
 *   - routing: explicit cloud pin + auto-route engine selection;
 *   - no key + cloud requested = fail-loud (the fail-open trap, closed).
 */
import { test, beforeEach } from "node:test";
// (seam tests for setCloudPayloadTransform live at the bottom of this file)
import assert from "node:assert/strict";
import {
  __resetEngineStateForTests,
  engineForStage,
  generate,
  resetEngineToLocal,
  setCloudPayloadTransform,
  setRunMode,
  useEngine,
} from "./llm.js";
import { classifyCloudError } from "./llm.js";

type FetchCall = { url: string; init: RequestInit };

// Install a mock global fetch and capture calls.
let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response = () =>
  new Response("{}", { status: 200 });

function mockFetch(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    calls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as typeof fetch;
  void real;
}

function chatResponse(
  content: string,
  extra: Record<string, unknown> = {}
): Response {
  return new Response(
    JSON.stringify({
      id: "resp-test-1",
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 101, completion_tokens: 55 },
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function modelsResponse(names: string[]): Response {
  return new Response(JSON.stringify({ data: names.map((n) => ({ id: n })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  responder = () => new Response("{}", { status: 200 });
  __resetEngineStateForTests();
  setRunMode("cloud");
  process.env.ALEX_CLOUD_API_KEY = "sk-test-key-000000";
  process.env.ALEX_CLOUD_MODEL = "test-model-1";
  process.env.ALEX_CLOUD_BASE_URL = "https://mock.invalid/v1";
  process.env.ALEX_CLOUD_TIMEOUT_MS = "2000";
  mockFetch();
});

test("cloud happy path: content, usage, engine, response id", async () => {
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1", "other"]);
    return chatResponse('{"ok":true}');
  };
  const out = await generate("hello", { jsonMode: true, stage: "analyst" });
  assert.equal(out.engine, "cloud");
  assert.equal(out.content, '{"ok":true}');
  assert.equal(out.promptTokens, 101);
  assert.equal(out.responseTokens, 55);
  assert.equal(out.responseId, "resp-test-1");
  const chatCall = calls.find((c) => c.url.endsWith("/chat/completions"))!;
  assert.ok(chatCall, "chat/completions called");
  const body = JSON.parse(String(chatCall.init.body));
  assert.equal(body.model, "test-model-1");
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: "json_object" });
  // Authorization header carries the key; it must not leak into errors/logs.
  assert.equal(
    (chatCall.init.headers as Record<string, string>).authorization,
    "Bearer sk-test-key-000000"
  );
});

test("model absent from a (possibly stale) /models list is advisory — chat proceeds", async () => {
  // Live Gemini behavior: the list omitted the model its own 404 message
  // recommended, so list-absence must NOT block a configured model.
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["other-model"]);
    return chatResponse("{}");
  };
  const out = await generate("hello", { stage: "analyst" });
  assert.equal(out.engine, "cloud");
  assert.equal(calls.filter((c) => c.url.endsWith("/chat/completions")).length, 1);
});

test("normalizeCloudModelId strips gateway prefixes", async () => {
  const { normalizeCloudModelId } = await import("./llm.js");
  assert.equal(normalizeCloudModelId("models/gemini-3.6-flash"), "gemini-3.6-flash");
  assert.equal(normalizeCloudModelId("gemini-3.6-flash"), "gemini-3.6-flash");
});

test("model truly absent fails loud at the chat call (404 carries the provider message)", async () => {
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["some-model"]);
    return new Response(
      JSON.stringify({ error: { code: 404, message: "model nope-flash is no longer available" } }),
      { status: 404 }
    );
  };
  await assert.rejects(generate("hello", { stage: "analyst" }), /404/);
});

test("response_format 400 → retried once WITHOUT JSON mode", async () => {
  let chatCalls = 0;
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1"]);
    chatCalls++;
    if (chatCalls === 1) {
      return new Response(
        JSON.stringify({ error: { message: "response_format is not supported" } }),
        { status: 400 }
      );
    }
    return chatResponse('{"ok":true}');
  };
  const out = await generate("hello", { jsonMode: true, stage: "analyst" });
  assert.equal(out.engine, "cloud");
  assert.equal(out.content, '{"ok":true}');
  assert.equal(chatCalls, 2);
  const bodies = calls
    .filter((c) => c.url.endsWith("/chat/completions"))
    .map((c) => JSON.parse(String(c.init.body)));
  assert.ok(bodies[0].response_format, "first attempt requested JSON mode");
  assert.ok(!bodies[1].response_format, "retry dropped response_format");
});

test('finish_reason "length" → hard truncation error, content never returned', async () => {
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1"]);
    return new Response(
      JSON.stringify({
        id: "t",
        choices: [{ message: { content: "truncated" }, finish_reason: "length" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  await assert.rejects(generate("hello", { stage: "analyst" }), /finish_reason=length/);
});

test("429 honors Retry-After then succeeds (single retry)", async () => {
  let chatCalls = 0;
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1"]);
    chatCalls++;
    if (chatCalls === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0.05" },
      });
    }
    return chatResponse("{}");
  };
  const out = await generate("hello", { stage: "analyst" });
  assert.equal(out.engine, "cloud");
  assert.equal(chatCalls, 2);
});

test("terminal 401 fails immediately — no retry storm", async () => {
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1"]);
    return new Response("unauthorized", { status: 401 });
  };
  await assert.rejects(generate("hello", { stage: "analyst" }), /401/);
  assert.equal(calls.filter((c) => c.url.endsWith("/chat/completions")).length, 1);
});

test("reasoning_content is stripped from content (provenance only)", async () => {
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1"]);
    return new Response(
      JSON.stringify({
        id: "r",
        choices: [
          {
            message: { content: '{"ok":1}', reasoning_content: "long private scratchpad" },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const out = await generate("hello", { stage: "analyst" });
  assert.equal(out.content, '{"ok":1}');
});

test("auto mode routes analyst→cloud, researcher→local (default route)", async () => {
  setRunMode("auto");
  delete process.env.ALEX_AUTO_ROUTE;
  assert.equal(engineForStage("analyst"), "cloud");
  assert.equal(engineForStage("adversary"), "cloud");
  assert.equal(engineForStage("researcher"), "local");
  assert.equal(engineForStage("intake"), "local");
});

test("cloud mode with NO key: useEngine fails loud, engineForStage degrades local", async () => {
  delete process.env.ALEX_CLOUD_API_KEY;
  setRunMode("cloud");
  // engineForStage degrades harmlessly (routing math), but useEngine — the
  // thing that would actually spend money — fails loudly.
  assert.equal(engineForStage("analyst"), "local");
  await assert.rejects(useEngine("cloud", "analyst"), /no ALEX_CLOUD_API_KEY/);
});

test("cloud error messages are scrubbed of the key", async () => {
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1"]);
    return new Response(
      `rejected auth Bearer sk-test-key-000000 at gateway`,
      { status: 500 }
    );
  };
  await assert.rejects(
    generate("hello", { stage: "analyst" }),
    (e: Error) => !e.message.includes("sk-test-key-000000")
  );
});

// ---- cloud payload transform seam (ADR-004 §2.4) -----------------------

test("payload transform applies to cloud-bound prompts only", async () => {
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1"]);
    return chatResponse('{"ok":true}');
  };
  setCloudPayloadTransform((_stage, p) => p.replaceAll("SECRET", "[REDACTED]"));
  try {
    // Cloud stage: the wire body carries the transform.
    await generate("facts with SECRET inside", { stage: "analyst" });
    const chatCall = calls.find((c) => c.url.endsWith("/chat/completions"))!;
    const body = JSON.parse(String(chatCall.init.body));
    assert.ok(!String(body.messages[0].content).includes("SECRET"));
    assert.ok(String(body.messages[0].content).includes("[REDACTED]"));
  } finally {
    setCloudPayloadTransform(null);
    __resetEngineStateForTests();
  }
});

test("with no transform registered, cloud prompts ride through untouched", async () => {
  responder = (url) => {
    if (url.endsWith("/models")) return modelsResponse(["test-model-1"]);
    return chatResponse('{"ok":true}');
  };
  await generate("facts with SECRET inside", { stage: "analyst" });
  const chatCall = calls.find((c) => c.url.endsWith("/chat/completions"))!;
  const body = JSON.parse(String(chatCall.init.body));
  assert.ok(String(body.messages[0].content).includes("SECRET"));
});
