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
import { resolveCluster } from "../db.js";
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

function fullCite(page: string, start = 0, end = 11): BridgeCitation {  return {
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

// ——— citation ambiguity (probe04, independent audit 2026-09-20) ———

test("a cite mapping to multiple clusters stays verified and is annotated AMBIGUOUS", () => {
  const db = memoryCorpus();
  try {
    // A second, unrelated cluster holds the same (vol, rep, page) string —
    // the 7.2% collision population probe04 measured.
    db.exec(
      `INSERT INTO opinions (id, cluster_id, case_name, type, blocked, text)
       VALUES (2, 200, 'Other Case', 'lead', 0, 'unrelated words entirely')`
    );
    db.exec(`INSERT INTO citation_strings VALUES (200, '410', 'U.S.', '113', 'full')`);

    const report = analyzeCitationsAndQuotes(db, [fullCite("113")], "410 U.S. 113");
    assert.equal(report.citations[0].status, "verified");
    assert.equal(report.overall, "pass");
    const amb = report.citations[0].ambiguous_cluster_ids;
    assert.ok(Array.isArray(amb) && amb.length === 2, `expected 2 clusters, got ${JSON.stringify(amb)}`);
    assert.ok([...amb].sort().join(",") === "100,200");
  } finally {
    db.close();
  }
});

test("a unique cite carries no ambiguity annotation", () => {
  const db = memoryCorpus();
  try {
    const report = analyzeCitationsAndQuotes(db, [fullCite("113")], "410 U.S. 113");
    assert.equal(report.citations[0].status, "verified");
    assert.equal(report.citations[0].ambiguous_cluster_ids, undefined);
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

// ——— cited-by counts direct unblocked citers only ———

test("cited_by excludes transitive and de-indexed citers", () => {
  const db = memoryCorpus();
  try {
    db.exec(
      `INSERT INTO opinions (id, cluster_id, case_name, blocked, text) VALUES
        (2, 200, 'Direct Citer', 0, 'citing text'),
        (3, 300, 'Indirect Citer', 0, 'citing text'),
        (4, 400, 'Blocked Citer', 1, 'citing text'),
        (5, 500, 'Anchor-only Citer', 0, 'citing text')`
    );
    db.exec(
      `INSERT INTO cites (citing_id, cited_id, depth) VALUES
        (2, 1, 1), (3, 1, 3), (4, 1, 1), (5, 1, NULL)`
    );
    const res = resolveCluster(db, "410", "U.S.", "113");
    assert.ok(res);
    // direct (2) + anchor-only (5); transitive (3) and blocked (4) excluded.
    assert.equal(res.cited_by, 2);
  } finally {
    db.close();
  }
});
// ——— dropped-negator veto (audit probe02 2026-09-20) ———

test("a quote that silently sheds its negator fails, everywhere in the ladder", () => {
  const db = memoryCorpus();
  try {
    // Source contains: No person shall be deprived of life liberty
    db.exec(
      `INSERT INTO opinions (id, cluster_id, case_name, blocked, text)
       VALUES (2, 200, 'Negator Source', 0,
         'The statute reads no person shall be deprived of life liberty without due process')`
    );
    db.exec(
      `INSERT INTO opinions_fts (rowid, text) VALUES (2, 'The statute reads no person shall be deprived of life liberty without due process')`
    );
    // Citation row so "410 U.S. 200" resolves to cluster 200 (the source).
    db.exec(`INSERT INTO citation_strings VALUES (200, '410', 'U.S.', '200', 'full')`);
    const cite = fullCite("200", 0, 9);
    const text = `[LAW] The court said "person shall be deprived of life liberty" (410 U.S. 200).`;
    cite.start = text.indexOf("410 U.S. 200");
    cite.end = cite.start + 12;
    const report = analyzeCitationsAndQuotes(db, [cite], text);
    assert.equal(report.citations[0].status, "verified");
    assert.equal(report.quotes[0].status, "quote_not_found");

    // Control: quoting the negated form honestly verifies.
    const good = `[LAW] The court said "no person shall be deprived of life liberty" (410 U.S. 200).`;
    const cite2 = fullCite("200", 0, 9);
    cite2.start = good.indexOf("410 U.S. 200");
    cite2.end = cite2.start + 12;
    const report2 = analyzeCitationsAndQuotes(db, [cite2], good);
    assert.equal(report2.quotes[0].status, "verified");
  } finally {
    db.close();
  }
});

// ——— sibling-opinion attribution (audit probe02 2026-09-20) ———

test("a quote in a SIBLING opinion of the cited cluster VERIFIES with within_cluster provenance", () => {
  const db = memoryCorpus();
  try {
    // Same cluster 100: lead (id 1) holds the quick-fox text; sibling (id 6)
    // holds a distinctive span the lead does NOT.
    db.exec(
      `INSERT INTO opinions (id, cluster_id, case_name, type, blocked, text)
       VALUES (6, 100, 'Roe v. Wade', 'dissent', 0,
         'the falcon soars above seven crimson towers at midnight seeking wisdom')`
    );
    db.exec(
      `INSERT INTO opinions_fts (rowid, text) VALUES (6, 'the falcon soars above seven crimson towers at midnight seeking wisdom')`
    );
    const text = `[LAW] The court said "falcon soars above seven crimson towers" (410 U.S. 113).`;
    const citeStart = text.indexOf("410 U.S. 113");
    const report = analyzeCitationsAndQuotes(
      db,
      [{ ...fullCite("113"), start: citeStart, end: citeStart + 12 }],
      text
    );
    assert.equal(report.citations[0].status, "verified");
    assert.equal(report.quotes[0].status, "verified");
    assert.equal(report.overall, "pass");
    assert.equal(report.quotes[0].true_source?.within_cluster, true);
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

// ——— short-form / Id. chain resolution (Phase B rung 1) ———

function shortCite(
  text: string,
  opts: Partial<BridgeCitation> = {}
): BridgeCitation {
  return {
    text,
    corrected: text,
    volume: "410",
    reporter: "U.S.",
    page: null,
    type: "short",
    pin_cite: "200",
    start: 0,
    end: text.length,
    ...opts,
  };
}

test("short form with matching verified antecedent resolves (chain semantics)", () => {
  const db = memoryCorpus();
  try {
    const full = fullCite("113", 0, 11);
    const short = shortCite("410 U.S., at 200", { start: 20, end: 36 });
    const report = analyzeCitationsAndQuotes(db, [full, short], "410 U.S. 113 … 410 U.S., at 200");
    assert.equal(report.citations[0].status, "verified");
    assert.equal(report.citations[1].status, "verified");
    assert.equal(report.citations[1].cluster_id, 100);
    assert.equal(report.citations[1].case_name, "Roe v. Wade");
  } finally {
    db.close();
  }
});

test("short form WITHOUT antecedent stays unsupported_form, not resolved", () => {
  const db = memoryCorpus();
  try {
    const short = shortCite("410 U.S., at 200");
    const report = analyzeCitationsAndQuotes(db, [short], "410 U.S., at 200");
    assert.equal(report.citations[0].status, "unsupported_form");
  } finally {
    db.close();
  }
});

test("short form after a FAILED full cite stays unsupported_form (broken chain)", () => {
  const db = memoryCorpus();
  try {
    const bad = fullCite("999", 0, 11); // not in the memory corpus
    const short = shortCite("410 U.S., at 200", { start: 20, end: 36 });
    const report = analyzeCitationsAndQuotes(db, [bad, short], "410 U.S. 999 … 410 U.S., at 200");
    assert.equal(report.citations[0].status, "unresolved_citation");
    assert.equal(report.citations[1].status, "unsupported_form");
  } finally {
    db.close();
  }
});

test("short form with MISMATCHED reporter stays unsupported_form", () => {
  const db = memoryCorpus();
  try {
    const full = fullCite("113", 0, 11);
    const other = shortCite("347 U.S., at 200", {
      volume: "347",
      start: 20,
      end: 36,
    });
    const report = analyzeCitationsAndQuotes(db, [full, other], "410 U.S. 113 … 347 U.S., at 200");
    assert.equal(report.citations[1].status, "unsupported_form");
  } finally {
    db.close();
  }
});

test("Id. after a verified full cite resolves to that antecedent", () => {
  const db = memoryCorpus();
  try {
    const full = fullCite("113", 0, 11);
    const id = shortCite("Id. at 205.", {
      type: "id",
      volume: null,
      reporter: null,
      page: null,
      start: 20,
      end: 31,
    });
    const report = analyzeCitationsAndQuotes(db, [full, id], "410 U.S. 113 … Id. at 205.");
    assert.equal(report.citations[1].status, "verified");
    assert.equal(report.citations[1].cluster_id, 100);
  } finally {
    db.close();
  }
});

test("Id. with no antecedent stays unsupported_form", () => {
  const db = memoryCorpus();
  try {
    const id = shortCite("Id.", {
      type: "id",
      volume: null,
      reporter: null,
      page: null,
    });
    const report = analyzeCitationsAndQuotes(db, [id], "Id.");
    assert.equal(report.citations[0].status, "unsupported_form");
  } finally {
    db.close();
  }
});

test("supra with a name matching a resolved antecedent resolves", () => {
  const db = memoryCorpus();
  try {
    const full = fullCite("113", 0, 11); // resolves to "Roe v. Wade"
    const supra = shortCite("supra, at 164", {
      type: "supra",
      volume: null,
      reporter: null,
      page: null,
      name: "Roe",
      start: 20,
      end: 33,
    });
    const report = analyzeCitationsAndQuotes(
      db,
      [full, supra],
      "410 U.S. 113 … supra, at 164"
    );
    assert.equal(report.citations[0].status, "verified");
    assert.equal(report.citations[1].status, "verified");
    assert.equal(report.citations[1].cluster_id, 100);
  } finally {
    db.close();
  }
});

test("supra name NOT in the resolved chain stays unsupported_form", () => {
  const db = memoryCorpus();
  try {
    const full = fullCite("113", 0, 11); // "Roe v. Wade"
    const supra = shortCite("supra, at 164", {
      type: "supra",
      volume: null,
      reporter: null,
      page: null,
      name: "Katz",
      start: 20,
      end: 33,
    });
    const report = analyzeCitationsAndQuotes(
      db,
      [full, supra],
      "410 U.S. 113 … supra, at 164"
    );
    assert.equal(report.citations[1].status, "unsupported_form");
  } finally {
    db.close();
  }
});

test("supra with no name metadata falls back to unsupported_form", () => {
  const db = memoryCorpus();
  try {
    const full = fullCite("113", 0, 11);
    const supra = shortCite("supra, at 164", {
      type: "supra",
      volume: null,
      reporter: null,
      page: null,
      name: null,
      start: 20,
      end: 33,
    });
    const report = analyzeCitationsAndQuotes(
      db,
      [full, supra],
      "410 U.S. 113 … supra, at 164"
    );
    assert.equal(report.citations[1].status, "unsupported_form");
  } finally {
    db.close();
  }
});
