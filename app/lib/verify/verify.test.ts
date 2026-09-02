/**
 * G2 Verifier unit tests — quote matcher ladder + resolver.
 *
 *   pnpm test          (wired in app/package.json)
 *
 * DB-dependent cases skip when corpus.sqlite is absent (CI-safe).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findQuote } from "./quotes.js";
import { openCorpus, resolveCluster } from "../db.js";
import { extractQuotedSpans, probeFragment } from "./verify.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_DB = existsSync(path.join(REPO, "data", "corpus.sqlite"));

// ---------------------------------------------------------------- matcher

test("exact substring matches", () => {
  const r = findQuote("before the quick brown fox jumps after", "the quick brown fox");
  assert.equal(r.found, true);
  if (r.found) {
    assert.equal(r.start, 7);
    assert.equal(r.end, 26);
  }
});

test("curly quotes, dashes and whitespace variance match via normalization", () => {
  const text = "The Court said \u201cno\u2014state may\u00a0 interfere   here.\u201d";
  const r = findQuote(text, "NO–STATE   may\ninterferE here.");
  assert.equal(r.found, true);
});

test("bracket alteration [t]he matches plain the", () => {
  const r = findQuote(
    "statute requires that the filing be timely.",
    "[t]HE filing be timely."
  );
  assert.equal(r.found, true);
});

test("one altered word must NOT match (the adversarial case)", () => {
  const text = "Only recently in Kings County the police brutally beat a suspect.";
  const mutated = text.replace("brutally", "gently");
  assert.equal(findQuote(text, mutated).found, false);
});

test("ellipsis elision matches ordered fragments", () => {
  const text =
    "The right of privacy is fundamental and applies to the states through due process.";
  const q = "The right of privacy ... applies to the states through due process.";
  const r = findQuote(text, q);
  assert.equal(r.found, true);
});

test("ellipsis with a missing fragment does NOT match", () => {
  const text = "alpha beta gamma delta epsilon zeta.";
  assert.equal(findQuote(text, "alpha beta ... delta omega zeta.").found, false);
});

test("empty quote never matches", () => {
  assert.equal(findQuote("anything", "   ").found, false);
});

test("offsets point into the original string", () => {
  const text = "X \u201cA\u00a0 B c\u201d Y"; // normalized: x "a b c" y
  const r = findQuote(text, "a b c");
  assert.ok(r.found);
  if (r.found) {
    assert.equal(text.slice(r.start, r.end).toLowerCase().replace(/\s+/g, " "), "a\u00a0 b c".replace(/\s+/g, " "));
  }
});

// ------------------------------------------------------------- span probe

test("quoted-span extraction finds straight and curly pairs", () => {
  const t = 'a "first quote" then \u201csecond one here\u201d end';
  const spans = extractQuotedSpans(t);
  assert.deepEqual(
    spans.map((s) => s.quote),
    ["first quote", "second one here"]
  );
});

test("block quotes spanning newlines are extracted", () => {
  const t = 'The Court held:\n"line one of the quote\nline two continues here"\nend.';
  const spans = extractQuotedSpans(t);
  assert.equal(spans.length, 1);
  assert.match(spans[0].quote, /line two continues/);
});

test("probeFragment picks whole words off the edges", () => {
  const q = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const frag = probeFragment(q);
  const words = frag.split(" ");
  assert.ok(words.length <= 12, `expected <=12 words, got ${words.length}`);
  assert.ok(!frag.startsWith("w0 "), "first word must be dropped");
  assert.ok(!frag.endsWith(" w39"), "last word must be dropped");
  assert.ok(frag.startsWith("w"), "no mid-word shards");
});

// -------------------------------------------------------------- resolver

test("resolveCluster resolves Roe and rejects fabrications", { skip: !HAS_DB }, () => {
  const db = openCorpus();
  try {
    const roe = resolveCluster(db, "410", "U.S.", "113");
    assert.ok(roe);
    assert.match(roe!.case_name ?? "", /Roe/);
    assert.ok(roe!.cited_by > 1000);

    assert.equal(resolveCluster(db, "734", "F.3d", "999"), null);
    assert.equal(resolveCluster(db, "123", "U.S.", "456"), null);
  } finally {
    db.close();
  }
});

// --------------------------------------------------- [RECORD] quote ranges

test(
  "[RECORD] quotes are the client's own facts — they never fail the draft",
  { skip: !HAS_DB },
  async () => {
    const { verifyTaggedSentencesAsync } = await import("../render.js");
    const { verifyText } = await import("./verify.js");
    const db = openCorpus();
    try {
      const sentences = [
        {
          tag: "RECORD" as const,
          text: 'The client told the intake clerk "please help me file before june" on the call.',
        },
        { tag: "INFERRED" as const, text: "The client appears concerned about timing." },
      ];
      const out = await verifyTaggedSentencesAsync(db, sentences);
      // The record quote is never checked, so the report carries no quote
      // checks and the draft passes.
      assert.equal(out.report.quotes.length, 0);
      assert.equal(out.overall, "pass");

      // Control: the identical draft text WITHOUT the record skip fails —
      // the quote is unattributed. Proves the skip is what changed.
      const raw = verifyText(db, out.draft);
      assert.equal(raw.overall, "fail");
      assert.ok(raw.quotes.some((q) => q.status === "unattributed"));
    } finally {
      db.close();
    }
  }
);
