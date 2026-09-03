/**
 * Verifier core regression tests — corpus-free (:memory: DB).
 *
 * Each test here names the finding it pins:
 *  - pin-page ranges ("456 U.S. 798, 800" style "113-114") must resolve
 *  - a quote straddling a [RECORD] boundary must be CHECKED, not skipped
 *  - a quote fully inside [RECORD] stays exempt (the §5.3 rule itself)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  analyzeCitationsAndQuotes,
  type BridgeCitation,
} from "./core.js";
import { verifyText } from "./verify.js";
import { verifyTextAsync } from "./verify_async.js";

function memoryCorpus(): Database.Database {
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
  db.exec(
    `CREATE TABLE cites (citing_id INTEGER, cited_id INTEGER, depth INTEGER,
      char_pos INTEGER, context TEXT)`
  );
  db.exec(`CREATE VIRTUAL TABLE opinions_fts USING fts5(text)`);
  db.exec(
    `CREATE TABLE authority (opinion_id INTEGER, treatment_flags INTEGER, pagerank REAL)`
  );
  // No statutes table: the pre-G4 path (eyecite-only) applies.
  db.exec(
    `INSERT INTO opinions (id, cluster_id, case_name, type, blocked, text)
     VALUES (1, 100, 'Roe v. Wade', 'lead', 0,
       'the quick brown fox jumps over the lazy dog and then some more words here')`
  );
  db.exec(`INSERT INTO opinions_fts (rowid, text) VALUES (1, 'the quick brown fox jumps over the lazy dog and then some more words here')`);
  db.exec(`INSERT INTO citation_strings VALUES (100, '410', 'U.S.', '113', 'full')`);
  return db;
}

function fullCite(page: string, start = 0, end = 11): BridgeCitation {
  return {
    text: `410 U.S. ${page}`,
    corrected: `410 U.S. ${page}`,
    volume: "410",
    reporter: "U.S.",
    page,
    type: "full",
    pin_cite: null,
    start,
    end,
  };
}

// ——— pin-page ranges ———

test("pin-page range resolves to its base page (456 U.S. 798, 800 pattern)", () => {
  const db = memoryCorpus();
  try {
    const report = analyzeCitationsAndQuotes(db, [fullCite("113-114")], "410 U.S. 113-114");
    assert.equal(report.citations[0].status, "verified");
  } finally {
    db.close();
  }
});

// ——— RECORD boundary ———

test("quote straddling a RECORD boundary is CHECKED, not skipped", () => {
  const db = memoryCorpus();
  try {
    const text = `[LAW] ruling notes "alpha beta gamma delta" applies here. [RECORD] client confirms.`;
    const spanStart = text.indexOf('"alpha');
    const spanEnd = text.indexOf('delta"') + 'delta"'.length;
    // Skip range starts INSIDE the quoted span (the straddle case).
    const report = analyzeCitationsAndQuotes(db, [], text, {
      skipQuoteRanges: [[spanStart + 5, spanEnd + 20]],
    });
    assert.equal(report.quotes.length, 1);
  } finally {
    db.close();
  }
});

test("quote fully inside RECORD stays exempt (§5.3 rule itself)", () => {
  const db = memoryCorpus();
  try {
    const text = `[LAW] ruling notes it applies here. [RECORD] client said "alpha beta gamma delta" exactly.`;
    const spanStart = text.indexOf('"alpha');
    const spanEnd = text.indexOf('delta"') + 'delta"'.length;
    const report = analyzeCitationsAndQuotes(db, [], text, {
      skipQuoteRanges: [[spanStart - 10, spanEnd + 10]],
    });
    assert.equal(report.quotes.length, 0);
  } finally {
    db.close();
  }
});

// ——— bridge transport parity: fail the draft, never the pipeline ———
/** Fake "python": ignores argv, runs the given shell body. Restores env. */
async function withFakePython(body: string, fn: () => void | Promise<unknown>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "alex-bridge-"));
  const fake = path.join(dir, "fake-python");
  writeFileSync(fake, `#!/bin/sh\n${body}\n`);
  chmodSync(fake, 0o755);
  const prev = process.env.VERIFY_PYTHON;
  process.env.VERIFY_PYTHON = fake;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.VERIFY_PYTHON;
    else process.env.VERIFY_PYTHON = prev;
  }
}

test("sync bridge garbage output fails the draft, not the pipeline", () => {
  return withFakePython(`echo 'not json'`, () => {
    const db = new Database(":memory:");
    try {
      const report = verifyText(db, "plain text, no quotes, no cites.");
      assert.equal(report.overall, "fail");
      assert.equal(report.citations[0].status, "unresolved_citation");
    } finally {
      db.close();
    }
  });
});

test("async bridge failing exit fails the draft, not the pipeline", () => {
  return withFakePython(`echo boom >&2; exit 3`, async () => {
    const db = new Database(":memory:");
    try {
      const report = await verifyTextAsync(db, "plain text, no quotes, no cites.");
      assert.equal(report.overall, "fail");
      assert.equal(report.citations[0].status, "unresolved_citation");
    } finally {
      db.close();
    }
  });
});

// ——— §9.7: de-indexed opinions never surface ———

test("true-source probe never names a de-indexed (blocked) opinion", () => {
  const db = memoryCorpus();
  try {
    db.exec(
      `INSERT INTO opinions (id, cluster_id, case_name, blocked, text)
       VALUES (2, 200, 'Blocked Opinion', 1, 'the xylophone zebra quantum doctrine controls here')`
    );
    db.exec(
      `INSERT INTO opinions_fts (rowid, text) VALUES (2, 'the xylophone zebra quantum doctrine controls here')`
    );
    const text = `[LAW] The court applied "xylophone zebra quantum doctrine" plainly (410 U.S. 113).`;
    const citeStart = text.indexOf("410 U.S. 113");
    const report = analyzeCitationsAndQuotes(
      db,
      [
        {
          text: "410 U.S. 113",
          corrected: "410 U.S. 113",
          volume: "410",
          reporter: "U.S.",
          page: "113",
          type: "full",
          pin_cite: null,
          start: citeStart,
          end: citeStart + 12,
        },
      ],
      text
    );
    assert.equal(report.citations[0].status, "verified");
    assert.equal(report.quotes.length, 1);
    assert.equal(report.quotes[0].status, "quote_not_found");
    assert.equal(report.quotes[0].true_source, undefined);
  } finally {
    db.close();
  }
});
