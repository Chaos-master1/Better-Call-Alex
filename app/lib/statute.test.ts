/**
 * G4 statutory citation tests — corpus-free. The verifier's statutory path
 * runs against an in-memory statutes table; the quote ladder runs against
 * stored section text exactly as it does against opinion text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  parseStatuteCites,
  resolveStatute,
  statuteLabel,
  statuteTableExists,
} from "./statute.js";
import {
  analyzeCitationsAndQuotes,
  type BridgeCitation,
} from "./verify/core.js";

const USC1983_TEXT =
  "Every person who, under color of any statute, ordinance, regulation, custom, or usage, subjects any citizen of the United States to the deprivation of any rights secured by the Constitution and laws, shall be liable to the party injured.";

function memoryDb(withStatutes: boolean): Database.Database {
  const db = new Database(":memory:");
  if (withStatutes) {
    db.exec(
      "CREATE TABLE statutes (id INTEGER PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, section TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, effective_date TEXT, UNIQUE(source, title, section))"
    );
    const ins = db.prepare(
      "INSERT INTO statutes (source, title, section, heading, text) VALUES (?, ?, ?, ?, ?)"
    );
    ins.run("usc", "42", "1983", "Civil action for deprivation of rights", USC1983_TEXT);
    ins.run("ecfr", "12", "1026.36", "Prohibited acts or practices and certain requirements for credit secured by a dwelling", "No creditor shall impose a penalty rate increase without 45 days advance notice to the consumer.");
  }
  return db;
}

// ——— parser ———

test("parseStatuteCites reads the full forms", () => {
  const t = "Under 42 U.S.C. § 1983 and 12 C.F.R. § 1026.36, and 29 USC 1910.1200.";
  const cites = parseStatuteCites(t);
  assert.equal(cites.length, 3);
  assert.deepEqual([cites[0].source, cites[0].title, cites[0].section], ["usc", "42", "1983"]);
  assert.deepEqual([cites[1].source, cites[1].title, cites[1].section], ["ecfr", "12", "1026.36"]);
  assert.deepEqual([cites[2].source, cites[2].title, cites[2].section], ["usc", "29", "1910.1200"]);
  // offsets ride along and slice exactly to the cite text
  assert.equal(t.slice(cites[0].start, cites[0].end), "42 U.S.C. § 1983");
});

test("parseStatuteCites stops at a subsection paren", () => {
  const cites = parseStatuteCites("5 U.S.C. § 706(2)(A) controls review.");
  assert.equal(cites.length, 1);
  assert.equal(cites[0].section, "706");
});

test("parseStatuteCites never matches case cites or bare short forms", () => {
  assert.equal(parseStatuteCites("See 410 U.S. 113, and see also 384 U.S. 436.").length, 0);
  assert.equal(parseStatuteCites("The bare § 1983 form is not tracked in v1.").length, 0);
  assert.equal(parseStatuteCites("Id. at 117.").length, 0);
});

// ——— resolution ———

test("resolveStatute finds loaded sections and misses absent ones", () => {
  const db = memoryDb(true);
  const hit = resolveStatute(db, "usc", "42", "1983");
  assert.ok(hit);
  assert.equal(statuteLabel(hit!), "42 U.S.C. § 1983");
  assert.equal(resolveStatute(db, "usc", "44", "9999"), null);
  assert.equal(statuteTableExists(memoryDb(false)), false);
});

// ——— verifier integration ———

test("a verified statute citation with a true quote passes the gate", () => {
  const db = memoryDb(true);
  const text = 'Under [42 U.S.C. § 1983] the Court held "shall be liable to the party injured" as the remedy rule.';
  const report = analyzeCitationsAndQuotes(db, [], text);
  const stat = report.citations.find((c) => c.form === "statute");
  assert.ok(stat, "statute check emitted");
  assert.equal(stat!.status, "verified");
  assert.equal(stat!.case_name, "42 U.S.C. § 1983 — Civil action for deprivation of rights");
  assert.equal(report.quotes[0]?.status, "verified");
  assert.equal(report.overall, "pass");
});

test("an unloaded statute section fails the draft as unresolved", () => {
  const db = memoryDb(true);
  const text = "Congress addressed this in 44 U.S.C. § 9999, which does not exist in the loaded corpus.";
  const report = analyzeCitationsAndQuotes(db, [], text);
  const stat = report.citations.find((c) => c.form === "statute");
  assert.ok(stat);
  assert.equal(stat!.status, "unresolved_citation");
  assert.equal(report.overall, "fail");
});

test("a fabricated statute quote fails as quote_not_found", () => {
  const db = memoryDb(true);
  const text = 'Under 12 C.F.R. § 1026.36 the rule is that "creditors must mail notices by carrier pigeon".';
  const report = analyzeCitationsAndQuotes(db, [], text);
  assert.equal(report.quotes[0]?.status, "quote_not_found");
  assert.equal(report.overall, "fail");
});

test("a span inside a full statutory cite supersedes the eyecite entry", () => {
  const db = memoryDb(true);
  const text = "Under 42 U.S.C. § 1983 the plaintiff may sue.";
  // eyecite partial: it sees "42 U.S.C." and, without the G4 override,
  // would resolve (or fail) as a case citation over the same span.
  const extracted: BridgeCitation[] = [
    {
      text: "42 U.S.C.",
      corrected: "42 U.S.C.",
      volume: "42",
      reporter: "U.S.C.",
      page: "",
      type: "full",
      pin_cite: null,
      start: 6,
      end: 14,
    },
  ];
  const report = analyzeCitationsAndQuotes(db, extracted, text);
  const caseChecks = report.citations.filter((c) => c.form === "full");
  assert.equal(caseChecks.length, 0, "overlapping eyecite entry dropped");
  const stat = report.citations.find((c) => c.form === "statute");
  assert.equal(stat?.status, "verified");
  assert.equal(report.overall, "pass");
});

test("without the statutes table the verifier keeps pre-G4 behavior", () => {
  const db = memoryDb(false);
  const text = "Under 42 U.S.C. § 1983 the plaintiff may sue.";
  const report = analyzeCitationsAndQuotes(db, [], text);
  assert.equal(report.citations.length, 0, "no statute checks without the table");
  assert.equal(report.overall, "pass");
});
