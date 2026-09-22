/**
 * Phase A — the verifier gates CLOUD-STYLE text (ADR-004 §2.5).
 *
 * Frontier models are fluent fabricators: the gate must prove itself
 * against their formatting habits, not just the local tier's plain text.
 * Fixtures reuse the G2 golden set's VERBATIM corpus spans (from
 * verifier/fixtures/golden.json — never from-memory quotes) re-wrapped
 * the way a cloud model writes: markdown emphasis, §-variants, `et seq.`,
 * plus the same mechanical mutation classes.
 *
 * The gate: every rejection-class fixture fails; every control passes.
 * Corpus-dependent, so it skips cleanly when corpus.sqlite is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCorpus } from "../db.js";
import { verifyText } from "./verify.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_DB = existsSync(path.join(REPO, "data", "corpus.sqlite"));

// Verbatim spans from the G2 golden set (generator-validated against the
// corpus) — the same truth the permanent fixtures use.
const GOLDEN = JSON.parse(
  readFileSync(path.join(REPO, "verifier", "fixtures", "golden.json"), "utf-8")
) as { cases: Array<{ id: string; text: string }> };

function goldenText(id: string): string {
  const c = GOLDEN.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden fixture ${id} missing`);
  return c.text;
}

/** Extract (quote, cite) from the valid_passage control text. */
const CONTROL = goldenText("valid_passage-01");
const ROE_QUOTE = CONTROL.match(/"((?:[^"\\]|\\.)*)"/)![1];
const ROE_CITE = "410 U.S. 113";

test("control: Roe quote + cite in cloud markdown wrapping still passes", { skip: !HAS_DB }, () => {
  const db = openCorpus();
  try {
    const text = `**Analysis.** The Court's holding controls: *"${ROE_QUOTE}"* (${ROE_CITE}).`;
    const report = verifyText(db, text);
    assert.equal(
      report.overall,
      "pass",
      `cites: ${report.citations.map((c) => `${c.form}:${c.status}`).join(" ")} | quotes: ${report.quotes.map((q) => q.status).join(" ")}`
    );
  } finally {
    db.close();
  }
});

test("rejection: fabricated cite (golden class) in bold still fails", { skip: !HAS_DB }, () => {
  const db = openCorpus();
  try {
    const text = `**Rule.** As held in *734 F.3d 999*, the doctrine requires dismissal.`;
    const report = verifyText(db, text);
    assert.equal(report.overall, "fail");
    assert.ok(
      report.citations.some((c) => c.status === "unresolved_citation"),
      "fabrication must land as unresolved_citation"
    );
  } finally {
    db.close();
  }
});

test("rejection: one-word-altered Roe quote in bold still fails", { skip: !HAS_DB }, () => {
  const db = openCorpus();
  try {
    // Mechanical mutation of the verbatim span — mirrors the altered_quote
    // fixture class; the mutation's absence is machine-checked below.
    const altered = ROE_QUOTE.replace("otherwise", "differently");
    assert.notEqual(altered, ROE_QUOTE);
    const text = `The Court said **"${altered}"** (${ROE_CITE}).`;
    const report = verifyText(db, text);
    assert.equal(report.overall, "fail");
    assert.ok(
      report.quotes.some((q) => q.status === "quote_not_found"),
      "altered quote must not match"
    );
  } finally {
    db.close();
  }
});

test("rejection: real Roe quote attributed to Katz (wrong case) fails", { skip: !HAS_DB }, () => {
  const db = openCorpus();
  try {
    const text = `See **"${ROE_QUOTE}"** (389 U.S. 347).`;
    const report = verifyText(db, text);
    assert.equal(report.overall, "fail");
    assert.ok(
      report.quotes.some(
        (q) => q.status === "quote_wrong_case" || q.status === "quote_not_found"
      ),
      `wrong-case quote must be rejected; got: ${report.quotes.map((q) => q.status).join(" ")}`
    );
  } finally {
    db.close();
  }
});

test("§-variant statutory form still EXTRACTS as a citation", { skip: !HAS_DB }, () => {
  const db = openCorpus();
  try {
    // G4 truth (CLAUDE.md §8): the US Code adapter is fixture-tested but
    // NOT live-loaded on this network — so resolution is expected to fail
    // here. What the cloud-formatting test proves is that the § form with
    // variant spacing still EXTRACTS (eyecite sees it), landing in the
    // honest unresolved state rather than vanishing.
    const text = ` Jurisdiction lies under 42 U.S.C. § 1983 .`;
    const report = verifyText(db, text);
    assert.ok(
      report.citations.some((c) => c.citation_text.includes("1983")),
      `§ form must extract; got: ${report.citations.map((c) => c.citation_text).join(" | ")}`
    );
  } finally {
    db.close();
  }
});

test("et seq. does not prevent extraction of the base cite", { skip: !HAS_DB }, () => {
  const db = openCorpus();
  try {
    const text = `Under *42 U.S.C. § 1983, et seq.*, the claim proceeds.`;
    const report = verifyText(db, text);
    assert.ok(
      report.citations.some((c) => c.citation_text.includes("1983")),
      "base cite must still be found"
    );
  } finally {
    db.close();
  }
});

test("out-of-corpus reporter (WL) annotates without failing — cloud habit", { skip: !HAS_DB }, () => {
  const db = openCorpus();
  try {
    const text = `Accord *2020 WL 4673834* (WL cite, cloud-style).`;
    const report = verifyText(db, text);
    const wl = report.citations.find((c) => c.citation_text.includes("WL"));
    if (wl) {
      // When the WL form extracts, it must be out_of_corpus (annotation),
      // never an unresolved fabrication — probe01's false-strike rule.
      assert.equal(wl.status, "out_of_corpus");
    }
    assert.notEqual(
      report.overall,
      "fail",
      "a WL cite alone must never fail the draft"
    );
  } finally {
    db.close();
  }
});
