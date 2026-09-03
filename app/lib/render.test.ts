/**
 * Render-gate regression tests — corpus-free.
 *
 * Each test names the finding it pins:
 *  - the §5.3 tag gate rejects unknown tags, not just missing ones
 *  - RECORD sentences must be grounded in the intake facts; a sentence the
 *    model tagged RECORD that shares nothing with the intake is re-tagged
 *    INFERRED (never verified as fact, never silently dropped)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  confineRecordSentences,
  verifyTaggedSentences,
  type TaggedSentence,
} from "./render.js";

const FACTS =
  "family owns beachfront lots purchased for investment. " +
  "state coastal regulation bars permanent habitable structures. " +
  "appraisals show no economically viable use remains.";

// ——— tag whitelist ———

test("unknown tag is rejected, not emitted as [FOO]", () => {
  const db = new Database(":memory:");
  try {
    assert.throws(
      () =>
        verifyTaggedSentences(db, [
          { tag: "FOO", text: "something" } as unknown as TaggedSentence,
        ]),
      /tag/
    );
  } finally {
    db.close();
  }
});

test("missing tag is still rejected", () => {
  const db = new Database(":memory:");
  try {
    assert.throws(
      () =>
        verifyTaggedSentences(db, [
          { text: "something" } as unknown as TaggedSentence,
        ]),
      /bad tag/
    );
  } finally {
    db.close();
  }
});

// ——— RECORD confinement ———

test("RECORD grounded in the intake keeps its tag", () => {
  const { sentences, retagged } = confineRecordSentences(
    [
      {
        tag: "RECORD",
        text: "The family owns beachfront lots bought for investment.",
      },
    ],
    FACTS
  );
  assert.equal(retagged, 0);
  assert.equal(sentences[0].tag, "RECORD");
});

test("LAW content laundered as RECORD is re-tagged INFERRED", () => {
  const { sentences, retagged } = confineRecordSentences(
    [
      {
        tag: "RECORD",
        text: "Probable cause is a complete defense to a false arrest claim under section 1983.",
      },
    ],
    FACTS
  );
  assert.equal(retagged, 1);
  assert.equal(sentences[0].tag, "INFERRED");
});

test("non-RECORD sentences pass through untouched", () => {
  const input: TaggedSentence[] = [
    { tag: "LAW", text: "Anything at all.", pin_cite: "410 U.S. 113" },
    { tag: "INFERRED", text: "Whatever follows." },
  ];
  const { sentences, retagged } = confineRecordSentences(input, FACTS);
  assert.equal(retagged, 0);
  assert.deepEqual(
    sentences.map((s) => s.tag),
    ["LAW", "INFERRED"]
  );
});

test("too-short RECORD cannot be judged and is kept", () => {
  const { sentences, retagged } = confineRecordSentences(
    [{ tag: "RECORD", text: "He objected." }],
    FACTS
  );
  assert.equal(retagged, 0);
  assert.equal(sentences[0].tag, "RECORD");
});
