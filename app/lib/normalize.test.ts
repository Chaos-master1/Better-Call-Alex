/**
 * normalize.ts tests — markdown artifact stripping must NEVER alter the
 * words of a draft (the verifier's no-fuzzing guarantee stays intact).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelText,
  normalizeProse,
  normalizeTaggedSentences,
} from "./normalize.js";

test("strips bold/italic/code markers", () => {
  assert.equal(normalizeModelText("**bold** and *em* and `code`"), "bold and em and code");
  assert.equal(normalizeModelText("__under__ too"), "under too");
});

test("strips list and heading debris", () => {
  assert.equal(normalizeModelText("## Heading\n- item one\n* item two\n1. item three"), "Heading\nitem one\nitem two\nitem three");
});

test("does not touch quoted-span words (one-word alterations still detectable)", () => {
  const before = 'The Court held "no person shall be deprived" (410 U.S. 113).';
  const after = normalizeModelText(before);
  assert.equal(before, after);
});

test("multiplication and snake_case survive", () => {
  assert.equal(normalizeModelText("3 * 4 and snake_case_id"), "3 * 4 and snake_case_id");
});

test("markdown-wrapped quote verifies identically after normalization", () => {
  const wrapped = 'The rule is **"No person shall be"** in the text.';
  const clean = normalizeModelText(wrapped);
  assert.equal(clean, 'The rule is "No person shall be" in the text.');
});

test("normalizeTaggedSentences normalizes text and pin cites, keeps tags", () => {
  const out = normalizeTaggedSentences([
    { tag: "LAW" as const, text: "**Held:** warrant required", pin_cite: " **410 U.S. 113** " },
    { tag: "RECORD" as const, text: "plain" },
  ]);
  assert.equal(out[0].text, "Held: warrant required");
  assert.equal(out[0].pin_cite, "410 U.S. 113");
  assert.equal(out[0].tag, "LAW");
  assert.equal(out[1].text, "plain");
  assert.equal(out[1].pin_cite, undefined);
});

test("normalizeProse collapses list artifacts in IRAC-style prose", () => {
  assert.equal(
    normalizeProse("- The issue is whether\n- the duty existed"),
    "The issue is whether\nthe duty existed"
  );
});
