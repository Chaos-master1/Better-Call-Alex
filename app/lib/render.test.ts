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

// Tiny corpus for the pin-strike gate: one Roe-shaped opinion with star
// anchors *113 and *114, resolvable at 410 U.S. 113 (mirrors core.test.ts).
function pinCorpus(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE opinions (id INTEGER PRIMARY KEY, cluster_id INTEGER,
      case_name TEXT, case_name_short TEXT, date_filed TEXT, court_id TEXT,
      type TEXT, blocked INTEGER DEFAULT 0,
      precedential_status TEXT, citation_count INTEGER, text TEXT)`
  );
  db.exec(
    `CREATE TABLE citation_strings (cluster_id INTEGER, volume TEXT,
      reporter TEXT, page TEXT, type TEXT)`
  );
  db.exec(`CREATE VIRTUAL TABLE opinions_fts USING fts5(text)`);
  db.exec(
    `INSERT INTO opinions (id, cluster_id, case_name, type, blocked, text)
     VALUES (1, 100, 'Roe v. Wade', 'lead', 0,
       '*113 the quick brown fox jumps over the lazy dog and then *114 some more words here')`
  );
  db.exec(
    `INSERT INTO opinions_fts (rowid, text) VALUES (1, 'the quick brown fox jumps over the lazy dog and then some more words here')`
  );
  db.exec(`INSERT INTO citation_strings VALUES (100, '410', 'U.S.', '113', 'full')`);
  db.exec(
    `CREATE TABLE cites (citing_id INTEGER, cited_id INTEGER, depth INTEGER, blocked INTEGER)`
  );
  db.exec(
    `CREATE TABLE authority (opinion_id INTEGER PRIMARY KEY, pagerank REAL, recent_cites_2y INTEGER, treatment_flags INTEGER)`
  );
  return db;
}

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

// ——— pin_out_of_range strike (Phase B rung 3 surfacing) ———

test("a pin outside the cited opinion's star-page span fails the sentence", () => {
  const db = pinCorpus();
  try {
    const { sentences } = verifyTaggedSentences(db, [
      {
        tag: "LAW",
        text: "The doctrine protects some more words here.",
        pin_cite: "410 U.S. 113, 999", // 999 is outside the *113–*114 span
      },
    ]);
    assert.equal(sentences[0].verified, false);
    assert.ok(
      sentences[0].detail.some((d) => d.includes("OUTSIDE")),
      `expected OUTSIDE detail, got: ${JSON.stringify(sentences[0].detail)}`
    );
  } finally {
    db.close();
  }
});

test("a pin inside the span keeps the sentence verified", () => {
  const db = pinCorpus();
  try {
    const { sentences } = verifyTaggedSentences(db, [
      {
        tag: "LAW",
        text: "The doctrine protects some more words here.",
        pin_cite: "410 U.S. 113, 114", // inside the span
      },
    ]);
    assert.equal(sentences[0].verified, true);
    assert.ok(!sentences[0].detail.some((d) => d.includes("OUTSIDE")));
  } finally {
    db.close();
  }
});

test("verified inline cite backfills a dropped pin_cite field (provenance, not guess)", () => {
  // g3 live run 2026-09-23 (tarasoff): the model verified an inline cite
  // but omitted the structured field — the harness rightly flagged it.
  // Render must copy the CHECKED extraction into the field.
  const db = pinCorpus();
  try {
    const { sentences } = verifyTaggedSentences(db, [
      {
        tag: "LAW",
        text: "The doctrine protects some more words here. (410 U.S. 113)",
        // no pin_cite field — the model dropped it
      },
    ]);
    assert.equal(sentences[0].verified, true);
    assert.equal(sentences[0].pin_cite, "410 U.S. 113");
  } finally {
    db.close();
  }
});

test("an unresolved inline cite never backfills the pin field", () => {
  // A fabricated cite stays honest: no field, sentence struck.
  const db = pinCorpus();
  try {
    const { sentences } = verifyTaggedSentences(db, [
      {
        tag: "LAW",
        text: "Completely invented authority. (999 U.S. 999)",
      },
    ]);
    assert.equal(sentences[0].verified, false);
    assert.equal(sentences[0].pin_cite, undefined);
  } finally {
    db.close();
  }
});

test("a verified LAW sentence with no checked quote discloses the paraphrase caveat", () => {
  // Phase E paraphrase honesty: the gate checks cite resolution and quotes,
  // not whether the proposition matches the source. A LAW sentence that
  // passed on citations alone must say exactly that.
  const db = pinCorpus();
  try {
    const { sentences } = verifyTaggedSentences(db, [
      {
        tag: "LAW",
        text: "The doctrine protects some more words here. (410 U.S. 113)",
      },
    ]);
    assert.equal(sentences[0].verified, true);
    assert.ok(
      sentences[0].detail.some((d) => d.includes("paraphrase")),
      `expected paraphrase caveat, got: ${JSON.stringify(sentences[0].detail)}`
    );
  } finally {
    db.close();
  }
});

test("a quote-checked LAW sentence carries no paraphrase caveat", () => {
  // The caveat must appear ONLY where nothing beyond the cite was checked.
  const db = pinCorpus();
  try {
    const { sentences } = verifyTaggedSentences(db, [
      {
        tag: "LAW",
        text: 'The doctrine says "some more words here" (410 U.S. 113).',
      },
    ]);
    assert.equal(sentences[0].verified, true);
    assert.ok(!sentences[0].detail.some((d) => d.includes("paraphrase")));
  } finally {
    db.close();
  }
});

test("too-short RECORD cannot be judged and is kept", () => {
  const { sentences, retagged } = confineRecordSentences(
    [{ tag: "RECORD", text: "He objected." }],
    FACTS
  );
  assert.equal(retagged, 0);
  assert.equal(sentences[0].tag, "RECORD");
});
