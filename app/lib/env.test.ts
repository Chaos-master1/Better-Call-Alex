/**
 * env.ts tests — .env parsing, engine config, key fingerprint, secret
 * scrubbing. No network, no DB.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  keyFingerprint,
  parseAutoRoute,
  parseEngineMode,
  scrubSecrets,
} from "./env.js";

beforeEach(() => {
  for (const k of [
    "ALEX_ENGINE",
    "ALEX_CLOUD_API_KEY",
    "ALEX_CLOUD_MODEL",
    "ALEX_CLOUD_BASE_URL",
    "ALEX_CLOUD_TIMEOUT_MS",
    "ALEX_CLOUD_FALLBACK",
    "ALEX_AUTO_ROUTE",
  ]) {
    delete process.env[k];
  }
});

test("parseEngineMode accepts only known modes", () => {
  assert.equal(parseEngineMode("cloud"), "cloud");
  assert.equal(parseEngineMode("AUTO"), "auto");
  assert.equal(parseEngineMode("local"), "local");
  assert.equal(parseEngineMode(undefined), "local");
  assert.equal(parseEngineMode("bogus"), "local");
});

test("parseAutoRoute defaults: analyst+adversary cloud, researcher local", () => {
  const route = parseAutoRoute(undefined);
  assert.equal(route.intake, "local");
  assert.equal(route.researcher, "local");
  assert.equal(route.analyst, "cloud");
  assert.equal(route.adversary, "cloud");
});

test("parseAutoRoute honors overrides, ignores garbage", () => {
  const route = parseAutoRoute("analyst:local, researcher : CLOUD , bogus:x, :::");
  assert.equal(route.analyst, "local");
  assert.equal(route.researcher, "cloud");
  // untouched stages keep defaults
  assert.equal(route.intake, "local");
  assert.equal(route.adversary, "cloud");
});

test("keyFingerprint is stable, short, and key-dependent", () => {
  const a = keyFingerprint("sk-test-abcdef123456");
  const b = keyFingerprint("sk-test-abcdef123456");
  const c = keyFingerprint("sk-other-key-000");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("scrubSecrets redacts the key and bearer shapes", () => {
  const key = "sk-super-secret-0099";
  const out = scrubSecrets(
    `request failed: authorization: Bearer ${key} for api_key=${key} (x)`,
    [key]
  );
  assert.ok(!out.includes(key), "key must not survive scrubbing");
  assert.ok(out.includes("[redacted]"));
});

test("scrubSecrets redacts unknown bearer tokens too", () => {
  const out = scrubSecrets("GET /v1/models authorization: Bearer sk-unknown-token-123 failed", []);
  assert.ok(!out.includes("sk-unknown-token-123"));
  assert.ok(out.includes("Bearer [redacted]"));
});

test("scrubSecrets leaves short values alone (avoid mangling text)", () => {
  const out = scrubSecrets("timeout at 408", ["408"]);
  assert.equal(out, "timeout at 408");
});
