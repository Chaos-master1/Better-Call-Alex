/**
 * Verify-then-revise (E2) boundary tests — corpus-free, LLM-free.
 *
 * The parser is the contract: whatever the model says, only exact-shaped
 * answers survive, and every violation throws so the pipeline keeps the
 * original draft. applyRepairs must swap/drop by render index without
 * touching anything else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRepairEntries,
  applyRepairs,
  repairStruckSentences,
  type RepairEvidence,
} from "./repair.js";
import type { RenderedDraft, TaggedSentence } from "../render.js";

const FLAGGED = [
  { index: 1, tag: "LAW", text: "Sharpe says stop. (488 U.S. 197)", detail: ["cite '488 U.S. 197' → unresolved_citation"] },
  { index: 3, tag: "LAW", text: "Hicks adds a rule. (479 U.S. 118)", detail: ["cite '479 U.S. 118' → unresolved_citation"] },
];

test("parseRepairEntries accepts exact-shaped entries, aligned to flagged order", () => {
  const raw = JSON.stringify([
    { tag: "LAW", text: "Sharpe says stop. (470 U.S. 675)", pin_cite: "470 U.S. 675" },
    null,
  ]);
  const r = parseRepairEntries(FLAGGED, raw);
  assert.equal(r.replacements.length, 2);
  assert.deepEqual(
    r.replacements.map((x) => x.index),
    [1, 3]
  );
  assert.equal(r.replacements[0].sentence?.pin_cite, "470 U.S. 675");
  assert.equal(r.replacements[1].sentence, null);
  assert.equal(r.repaired_count, 1);
  assert.equal(r.law_count, 1);
});

test("parseRepairEntries rejects a non-array answer", () => {
  assert.throws(() => parseRepairEntries(FLAGGED, JSON.stringify({ tag: "LAW" })), /expected an array/);
});

test("parseRepairEntries unwraps a single-key object wrapper (observed live)", () => {
  const raw = JSON.stringify({
    repairs: [
      { tag: "LAW", text: "Sharpe says stop. (470 U.S. 675)", pin_cite: "470 U.S. 675" },
      null,
    ],
  });
  const r = parseRepairEntries(FLAGGED, raw);
  assert.equal(r.replacements.length, 2);
  assert.equal(r.replacements[0].sentence?.pin_cite, "470 U.S. 675");
  assert.equal(r.repaired_count, 1);
  // A multi-key object is not a wrapper — still rejected fail-closed.
  assert.throws(
    () => parseRepairEntries(FLAGGED, JSON.stringify({ repairs: [], note: "x" })),
    /expected an array/
  );
});

test("parseRepairEntries rejects a length mismatch (nothing smuggled in)", () => {
  const raw = JSON.stringify([
    { tag: "INFERRED", text: "x" },
    { tag: "INFERRED", text: "y" },
    { tag: "INFERRED", text: "z" },
  ]);
  assert.throws(() => parseRepairEntries(FLAGGED, raw), /3 entries for 2/);
});

test("parseRepairEntries rejects a LAW repair without pin_cite", () => {
  const raw = JSON.stringify([{ tag: "LAW", text: "no cite here" }, null]);
  assert.throws(() => parseRepairEntries(FLAGGED, raw), /\[LAW\] without pin_cite/);
});

test("parseRepairEntries rejects unknown tags and empty text", () => {
  assert.throws(
    () => parseRepairEntries(FLAGGED, JSON.stringify([{ tag: "HOLDING", text: "x" }, null])),
    /not a valid tagged sentence/
  );
  assert.throws(
    () => parseRepairEntries(FLAGGED, JSON.stringify([{ tag: "INFERRED", text: "   " }, null])),
    /not a valid tagged sentence/
  );
});

test("parseRepairEntries trims text and pin_cite", () => {
  const raw = JSON.stringify([
    { tag: "LAW", text: "  trimmed. (470 U.S. 675)  ", pin_cite: " 470 U.S. 675 " },
    null,
  ]);
  const r = parseRepairEntries(FLAGGED, raw);
  assert.equal(r.replacements[0].sentence?.text, "trimmed. (470 U.S. 675)");
  assert.equal(r.replacements[0].sentence?.pin_cite, "470 U.S. 675");
});

test("applyRepairs swaps by index, removes drops, keeps everything else", () => {
  const confined: TaggedSentence[] = [
    { tag: "RECORD", text: "fact one" },
    { tag: "LAW", text: "Sharpe says stop. (488 U.S. 197)", pin_cite: "488 U.S. 197" },
    { tag: "INFERRED", text: "reasoning" },
    { tag: "LAW", text: "Hicks adds a rule. (479 U.S. 118)", pin_cite: "479 U.S. 118" },
  ];
  const repair = parseRepairEntries(
    FLAGGED,
    JSON.stringify([
      { tag: "LAW", text: "Sharpe says stop. (470 U.S. 675)", pin_cite: "470 U.S. 675" },
      null,
    ])
  );
  const out = applyRepairs(confined, repair);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, "fact one");
  assert.equal(out[1].pin_cite, "470 U.S. 675");
  assert.equal(out[2].text, "reasoning");
});

test("repairStruckSentences returns null on a clean draft or with no evidence", async () => {
  const draft = {
    sentences: [{ index: 0, tag: "LAW", text: "ok", verified: true, detail: [] }],
  } as unknown as RenderedDraft;
  const evidence: RepairEvidence[] = [{ case_name: "A case", passages: ["text"] }];
  assert.equal(await repairStruckSentences(draft, evidence, { claims: [] } as never), null);

  const struck = {
    sentences: [{ index: 0, tag: "LAW", text: "bad", verified: false, detail: ["x"] }],
  } as unknown as RenderedDraft;
  assert.equal(await repairStruckSentences(struck, [], { claims: [] } as never), null);
});
