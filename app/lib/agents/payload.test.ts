/**
 * Cloud payload guard (ADR-004 §2.4) — redaction, caps, disclosure. Pure
 * tests: no network, no DB, no key.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPayloadGuard,
  CLOUD_PROMPT_TOKEN_BUDGET,
} from "./payload.js";

beforeEach(() => {});

test("redaction replaces names with stable [PARTY n] placeholders", () => {
  const g = createPayloadGuard(["Jane Rivera", "Acme Corp"]);
  const out = g.transform(
    "analyst",
    'Facts: Jane Rivera sued Acme Corp. Jane Rivera says Acme Corp breached.'
  );
  assert.ok(!out.includes("Jane Rivera"), "name must not survive");
  assert.ok(!out.includes("Acme Corp"), "name must not survive");
  assert.ok(out.includes("[PARTY 1]"), "first-seen name gets PARTY 1");
  assert.ok(out.includes("[PARTY 2]"), "second-seen name gets PARTY 2");
  const d = g.disclosures();
  assert.equal(d.redactedPartyCount, 2);
});

test("assignment order is occurrence order, stable across transforms", () => {
  const g = createPayloadGuard(["Bob", "Alice"]);
  // Alice appears FIRST in the payload — she must own the lower number.
  g.transform("intake", "Alice met Bob. Bob disagreed.");
  assert.deepEqual(g.namesInAssignmentOrder(), ["Alice", "Bob"]);
});

test("case-insensitive match, placeholder reused for the same name", () => {
  const g = createPayloadGuard(["acme corp"]);
  const out = g.transform("analyst", "ACME CORP and Acme Corp and acme corp");
  // The redaction instruction (appended after capping) mentions [PARTY 1]
  // once; the payload body must carry exactly the three replaced spans.
  const body = out.split("[REDACTION]")[0];
  assert.equal((body.match(/\[PARTY 1\]/g) ?? []).length, 3);
});

test("short and blank names are ignored", () => {
  const g = createPayloadGuard(["AB", "", "   ", "Ok Name"]);
  const out = g.transform("analyst", "AB met Ok Name");
  assert.ok(out.includes("AB"), "sub-3-char strings are never redacted");
  assert.ok(out.includes("[PARTY 1]"));
  assert.equal(g.disclosures().redactedPartyCount, 1);
});

test("regex metacharacters in names are literal", () => {
  const g = createPayloadGuard(["O'Brien & Sons (Ltd.)"]);
  const out = g.transform("analyst", "Filed by O'Brien & Sons (Ltd.) yesterday");
  assert.ok(!out.includes("O'Brien & Sons (Ltd.)"));
  assert.ok(out.includes("[PARTY 1]"));
});

test("oversized prompt: low-ranked passages dropped, cap respected", () => {
  // Budget expressed in chars (~4 chars/token); build a prompt 3x over.
  const budgetChars = CLOUD_PROMPT_TOKEN_BUDGET * 4;
  const passage = `"a very long retrieval passage about the holding of some case"`;
  const filler = "x".repeat(200);
  const entries: string[] = [];
  for (let i = 0; i < Math.ceil((budgetChars * 3) / (filler.length + passage.length)); i++) {
    entries.push(`{"case_name":"case ${i}","passages":[${passage},${passage}]}`);
  }
  const prompt = `{"intake":{},"retrieval":[${entries.join(",")}]}`;
  const g = createPayloadGuard([], CLOUD_PROMPT_TOKEN_BUDGET);
  const out = g.transform("analyst", prompt);
  assert.ok(out.length <= budgetChars, "capped prompt must fit the budget");
  assert.ok(g.disclosures().droppedPassages > 0, "drops must be disclosed");
  assert.ok(out.includes('"passages":'), "structure preserved");
});

test("within-budget prompt passes through unchanged (no caps, no drops)", () => {
  const g = createPayloadGuard([], CLOUD_PROMPT_TOKEN_BUDGET);
  const prompt = '{"intake":{"claims":["a"],"retrieval":[{"case_name":"x","passages":["p"]}]}';
  const out = g.transform("analyst", prompt);
  assert.equal(out, prompt);
  const d = g.disclosures();
  assert.equal(d.cappedStages.length, 0);
  assert.equal(d.droppedPassages, 0);
});
