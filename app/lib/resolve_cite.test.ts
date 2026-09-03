/**
 * Export-gate candidate tests — corpus-free (pure extraction/collection).
 * resolvesCitation() itself is exercised by the live G5 runs (route +
 * evals/run_g5.ts against data/corpus.sqlite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectExportCandidates,
  extractCaseCites,
} from "./resolve_cite.js";
import type { DraftDoc } from "./draft.js";

test("extracts full-form case cites from free text", () => {
  assert.deepEqual(extractCaseCites("As held in 410 U.S. 113, the rule stands."), [
    "410 U.S. 113",
  ]);
});

test("reporter without a period is not a cite (acreage/dollar guard)", () => {
  assert.deepEqual(extractCaseCites("500 lots covering 20 acres were sold."), []);
  assert.deepEqual(extractCaseCites("purchased for $500,000 as an investment."), []);
});

test("bare section symbols are not case cites (statute path owns them)", () => {
  assert.deepEqual(extractCaseCites("liability under 42 U.S.C. § 1983 attaches."), []);
});

test("candidates cover appendix + pins + IRAC/counter inline cites", () => {
  const drafted = {
    authority_appendix: [{ citation: "410 U.S. 113" }],
    sentences: [{ pin_cite: "505 U.S. 1003, 1019" }],
    irac: { issue: "Whether 535 U.S. 302 controls.", rule: "r", application: "a", conclusion: "c" },
    adversary: { counter_argument: "No authority helps.", treatment_caveats: [] },
  } as unknown as DraftDoc;
  const got = collectExportCandidates(drafted);
  assert.ok(got.includes("410 U.S. 113"));
  assert.ok(got.includes("505 U.S. 1003, 1019"));
  assert.ok(got.includes("535 U.S. 302"));
});
