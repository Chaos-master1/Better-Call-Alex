/**
 * CLI contract tests — usage errors only (corpus-free; no DB touched).
 * Live lookup/search/run behavior is covered by G0/G1/G3 harnesses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(APP, "node_modules", ".bin", "tsx");
const CLI = path.join(APP, "cli.ts");

function cli(...args: string[]) {
  return spawnSync(TSX, [CLI, ...args], { encoding: "utf8", timeout: 120_000 });
}

test("no command prints usage with exit 2", () => {
  const r = cli();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("run with empty facts prints usage with exit 2", () => {
  const r = cli("run", "   ");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("run with overlong facts is refused before any DB or model work", () => {
  const r = cli("run", "x".repeat(16_001));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /exceeds the 16000-character limit/);
});
