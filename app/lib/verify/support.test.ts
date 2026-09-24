/**
 * F2 support-evidence tests — the passage surfacing layer.
 * Unit tests drive supportForCitation directly (no bridge); the integration
 * test proves the advisory rides on the real verifyText report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { supportForCitation } from "./support.js";
import type { CitationCheck } from "./core.js";
import { verifyText } from "./verify.js";

/** Corpus fixture with star anchors and two distinct page windows. */
function corpus(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE opinions (id INTEGER PRIMARY KEY, cluster_id INTEGER,
      case_name TEXT, case_name_short TEXT, date_filed TEXT, court_id TEXT,
      type TEXT, blocked INTEGER DEFAULT 0,
      precedential_status TEXT, citation_count INTEGER, text TEXT)`
  );
  const anchored =
    "*401 the magistrate must weigh the totality of the circumstances when " +
    "evaluating the informant tip under the Fourth Amendment *402 completely " +
    "different words appear on the next page about collateral estoppel and " +
    "res judicata doctrines entirely";
  db.exec(
    `INSERT INTO opinions (id, cluster_id, case_name, type, blocked, text)
     VALUES (1, 100, 'Illinois v. Gates', 'lead', 0, '${anchored}')`
  );
  db.exec(
    `CREATE TABLE citation_strings (cluster_id INTEGER, volume TEXT,
      reporter TEXT, page TEXT, type TEXT)`
  );
  db.exec(`INSERT INTO citation_strings VALUES (100, '462', 'U.S.', '213', 'full')`);
  db.exec(
    `CREATE TABLE cites (citing_id INTEGER, cited_id INTEGER, depth INTEGER,
      char_pos INTEGER, context TEXT)`
  );
  db.exec(`CREATE VIRTUAL TABLE opinions_fts USING fts5(text)`);
  db.exec(
    `CREATE TABLE authority (opinion_id INTEGER, treatment_flags INTEGER, pagerank REAL)`
  );
  db.exec(
    `INSERT INTO opinions_fts (rowid, text) VALUES (1,
      'the magistrate must weigh the totality of the circumstances when evaluating the informant tip under the fourth amendment completely different words appear on the next page about collateral estoppel and res judicata doctrines entirely')`
  );
  return db;
}

function check(over: Partial<CitationCheck>): CitationCheck {
  return {
    citation_text: "462 U.S. 213",
    corrected: "462 U.S. 213",
    volume: "462",
    reporter: "U.S.",
    page: "213",
    form: "full",
    cite_start: 0,
    cite_end: 11,
    status: "verified",
    pin_unverified: false,
    opinion_id: 1,
    cluster_id: 100,
    ...over,
  } as CitationCheck;
}

test("F2: pinned full cite surfaces the anchored page window", () => {
  const db = corpus();
  const c = check({ cite_pin_raw: "401" });
  const ev = supportForCitation(db, c, "The magistrate must weigh the totality of the circumstances. 462 U.S. 213");
  assert.ok(ev, "evidence present");
  assert.equal(ev.opinion_id, 1);
  assert.equal(ev.pin, "401");
  assert.match(ev.passage, /totality of the circumstances/);
  assert.equal(ev.passage_offset, 0);
  assert.equal(ev.pin_unsupported, undefined, "overlapping window is not flagged");
});

test("F2: pin on the second anchor returns that page's window", () => {
  const db = corpus();
  const c = check({ cite_pin_raw: "402" });
  const ev = supportForCitation(db, c, "Collateral estoppel discussion. 462 U.S. 213");
  assert.ok(ev);
  assert.match(ev.passage, /collateral estoppel/);
  assert.notEqual(ev.passage_offset, 0);
});

test("F2: divergent pinned window is flagged pin_unsupported, never struck", () => {
  const db = corpus();
  // Sentence about torts; window is about magistrate informants.
  const c = check({ cite_pin_raw: "401" });
  const ev = supportForCitation(
    db,
    c,
    "Under Tennessee negligence law, comparative fault bars recovery where the plaintiff's own conduct contributed substantially to the injury. 462 U.S. 213"
  );
  assert.ok(ev);
  assert.equal(ev.pin_unsupported, true, "advisory flag set");
});

test("F2: no-anchors opinion degrades to the opening span, unjudged", () => {
  const db = corpus();
  db.prepare(`UPDATE opinions SET text = ? WHERE id = 1`).run(
    "the magistrate must weigh the totality of the circumstances without any star markers here at all"
  );
  const c = check({ cite_pin_raw: "401" });
  const ev = supportForCitation(db, c, "The magistrate weighs the totality. 462 U.S. 213");
  assert.ok(ev);
  assert.equal(ev.pin_unsupported, undefined, "unjudgeable ≠ unsupported");
  assert.match(ev.passage, /magistrate/);
});

test("F2: unverified or unresolved citations get no evidence", () => {
  const db = corpus();
  assert.equal(supportForCitation(db, check({ status: "unresolved_citation" }), "x"), null);
  assert.equal(supportForCitation(db, check({ opinion_id: undefined }), "x"), null);
});

test("F2 integration: supports ride on the verifyText report and render detail", () => {
  const db = corpus();
  const text =
    "[LAW] The totality of the circumstances governs informant tips. (462 U.S. 213, 401)";
  const report = verifyText(db, text);
  assert.ok(report.supports && report.supports.length > 0, "supports attached");
  const sp = report.supports![0];
  assert.equal(sp.citation, "462 U.S. 213");
  assert.match(sp.passage, /totality/);
});
