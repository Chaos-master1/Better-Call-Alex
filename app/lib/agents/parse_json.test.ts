/**
 * parseJson robustness — the single JSON boundary for agent output.
 * Covered: happy path, prose fences, Gemini's raw-control-chars-in-strings
 * quirk (live g3-03, 2026-09-24), and the loud failure when a payload is
 * genuinely unrecoverable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJson } from "./index.js";

test("parseJson: plain object parses strictly", () => {
  assert.deepEqual(parseJson('{"a":1}', "t"), { a: 1 });
});

test("parseJson: prose fences stripped", () => {
  assert.deepEqual(parseJson('```json\n{"a":[1,2]}\n```', "t"), { a: [1, 2] });
});

test("parseJson: raw newline inside a string value is repaired (Gemini quirk)", () => {
  // This is the live g3-03 failure shape: legal prose wrapped across
  // literal lines inside a JSON string value.
  const raw = '{\n  "irac": {\n    "issue": "Whether the court\nwarned the parties plainly.",\n    "rule": 1\n  }\n}';
  const out = parseJson<{ irac: { issue: string; rule: number } }>(raw, "t");
  assert.equal(out.irac.issue, "Whether the court\nwarned the parties plainly.");
  assert.equal(out.irac.rule, 1);
});

test("parseJson: tabs and carriage returns inside strings repaired too", () => {
  const out = parseJson<{ s: string }>('{"s":"a\tb\rc"}', "t");
  assert.equal(out.s, "a\tb\rc");
});

test("parseJson: structural newlines between tokens survive untouched", () => {
  const out = parseJson('{\n "a": 1,\n "b": [2,\n3]\n}', "t");
  assert.deepEqual(out, { a: 1, b: [2, 3] });
});

test("parseJson: escaped sequences in strings are not double-escaped", () => {
  const out = parseJson<{ s: string }>('{"s":"line1\\nline2 \\"quoted\\""}', "t");
  assert.equal(out.s, "line1\nline2 \"quoted\"");
});

test("parseJson: genuinely broken JSON still fails loud", () => {
  assert.throws(() => parseJson("{not json at all", "analyst"), /non-JSON/);
});
