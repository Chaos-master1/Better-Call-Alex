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

import { findQuote, resetQuoteCaches } from "./quotes.js";
import { openCorpus, resolveCluster } from "../db.js";
import { extractQuotedSpans, probeFragment } from "./verify.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_DB = existsSync(path.join(REPO, "data", "corpus.sqlite"));

// ---------------------------------------------------------------- matcher

test.beforeEach?.(resetQuoteCaches);

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

test("bracket/paren ellipsis variants match like ... does", () => {
  const text =
    "The right of privacy is fundamental and applies to the states through due process.";
  assert.equal(
    findQuote(text, "The right of privacy [...] applies to the states through due process.").found,
    true
  );
  assert.equal(
    findQuote(text, "The right of privacy (...) applies to the states through due process.").found,
    true
  );
});

test("bracket ellipsis with a missing fragment does NOT match", () => {
  const text = "alpha beta gamma delta epsilon zeta.";
  assert.equal(findQuote(text, "alpha beta [...] delta omega zeta.").found, false);
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

test("single-quoted spans extract under word-boundary guards", () => {
  const spans = extractQuotedSpans("held that 'due process requires notice' here");
  assert.deepEqual(
    spans.map((s) => s.quote),
    ["due process requires notice"]
  );
});

test("curly single quotes extract", () => {
  const spans = extractQuotedSpans("held that \u2018due process requires notice\u2019 here");
  assert.deepEqual(
    spans.map((s) => s.quote),
    ["due process requires notice"]
  );
});

test("possessives and contractions never delimit", () => {
  assert.deepEqual(extractQuotedSpans("plaintiff's motion and defendants' claims"), []);
  assert.deepEqual(extractQuotedSpans("don't stop believin'"), []);
  assert.deepEqual(extractQuotedSpans("rock 'n' roll music band"), []);
});

test("singles nested in doubles are not double-reported", () => {
  const spans = extractQuotedSpans(`she said "hello world today loudly" end`);
  assert.equal(spans.length, 1);
  const nested = extractQuotedSpans(`she said "the court held 'due process applies' today" end`);
  assert.equal(nested.length, 1);
  assert.match(nested[0].quote, /due process applies/);
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

// ------------------------------------------------- pin cross-check

test(
  "LAW pin with no extractable citation fails closed",
  { skip: !HAS_DB },
  async () => {
    const { verifyTaggedSentences } = await import("../render.js");
    const db = openCorpus();
    try {
      const bad = verifyTaggedSentences(db, [
        { tag: "LAW", text: "The Court requires notice.", pin_cite: "26065" },
      ]);
      assert.equal(bad.sentences[0].verified, false);
      assert.equal(bad.overall, "fail");
      assert.ok(
        bad.sentences[0].detail.some((d) => d.includes("no extractable citation"))
      );

      // Control: a real pin still verifies.
      const good = verifyTaggedSentences(db, [
        { tag: "LAW", text: "The Court requires notice.", pin_cite: "410 U.S. 113" },
      ]);
      assert.equal(good.sentences[0].verified, true);
    } finally {
      db.close();
    }
  }
);

// ------------------- dropped-negator veto (audit probe02 2026-09-20)

test(
  "a quote that silently sheds its negator fails (dropped-negator veto)",
  { skip: !HAS_DB },
  async () => {
    const { verifyText } = await import("./verify.js");
    const db = openCorpus();
    try {
      // Find a real negated span and drop its negator — the exact mutation
      // class that escaped every textual rung in audit probe02.
      // Pick a cluster where EVERY occurrence of the phrase is negator-shed
      // — if any sibling carries a clean occurrence, the quote legitimately
      // verifies (per-occurrence veto semantics) and the fixture premise
      // breaks (audit probe02 rerun exposed exactly that collision).
      const probe = db
        .prepare(
          `SELECT o.id AS id, o.cluster_id AS cluster_id, o.text AS text
             FROM opinions o
            WHERE o.blocked = 0
              AND o.id IN (SELECT rowid FROM opinions_fts
                           WHERE opinions_fts MATCH '"no person shall be deprived"')
              AND o.text LIKE '%no person shall be deprived%'
              AND NOT EXISTS (
                    SELECT 1 FROM opinions sib
                     WHERE sib.cluster_id = o.cluster_id
                       AND sib.blocked = 0
                       AND sib.text LIKE '%person shall be deprived of life%'
                       AND sib.text NOT LIKE '%no person shall be deprived of life%'
                  )
            LIMIT 1`
        )
        .get() as { id: number; cluster_id: number; text: string } | undefined;
      assert.ok(probe, "corpus must contain an all-negated cluster for the span");
      // Belt-and-suspenders: confirm in JS that NO live opinion of this
      // cluster carries a clean occurrence (the SQL guard above covers
      // others; this covers the probe opinion itself).
      const sibs = db
        .prepare(
          `SELECT text FROM opinions WHERE cluster_id = ? AND blocked = 0`
        )
        .all(probe.cluster_id) as Array<{ text: string }>;
      for (const sib of sibs) {
        assert.ok(
          !(sib.text.includes("person shall be deprived of life") &&
            !sib.text.includes("no person shall be deprived of life")),
          "fixture premise: no clean occurrence anywhere in the cluster"
        );
      }
      const m = probe.text.match(/[Nn]o\s+(person shall be deprived of life)/);
      assert.ok(m, "negator directly precedes the span");
      const quote = m[1]; // negator dropped
      const at = m.index! + m[0].indexOf(m[1]);
      // Veto precondition: the source match is immediately preceded by "no ".
      assert.ok(/no\s$/i.test(probe.text.slice(0, at)));

      // Attribute to the source opinion's own primary citation — but the
      // 7.2% (vol, rep, page) collision rate (probe04) means a cite can
      // resolve to a DIFFERENT cluster that carries a clean occurrence.
      // Choose a citation that provably resolves to the probed cluster,
      // unambiguously, or the fixture premise is void.
      const cites = db
        .prepare(
          `SELECT volume, reporter, page FROM citation_strings WHERE cluster_id = ?`
        )
        .all(probe.cluster_id) as Array<{ volume: string; reporter: string; page: string }>;
      const { resolveCluster } = await import("../db.js");
      let chosen: { volume: string; reporter: string; page: string } | undefined;
      for (const c of cites) {
        const res = resolveCluster(db, c.volume, c.reporter, c.page);
        if (
          res &&
          res.cluster_id === probe.cluster_id &&
          (res.all_cluster_ids?.length ?? 1) === 1
        ) {
          chosen = c;
          break;
        }
      }
      assert.ok(chosen, "cluster must carry an unambiguous self-resolving citation");
      const cite = chosen;

      const draft = `[LAW] The court said "${quote}" (${cite.volume} ${cite.reporter} ${cite.page}).`;
      const r = verifyText(db, draft);
      assert.equal(r.overall, "fail");
      assert.equal(r.quotes[0].status, "quote_not_found");
    } finally {
      db.close();
    }
  }
);

// ------------------- sibling-opinion attribution (audit probe02 2026-09-20)

test(
  "a quote living in a SIBLING opinion of the cited cluster downgrades to quote_not_found, not wrong-case",
  { skip: !HAS_DB },
  async () => {
    const { verifyText } = await import("./verify.js");
    const db = openCorpus();
    try {
      // Find a real sibling pair: two opinions sharing a cluster, where a
      // quoted sentence exists in one but not the other.
      const pair = db
        .prepare(
          `SELECT a.id AS aid, a.text AS atext, b.id AS bid, b.text AS btext,
                  a.cluster_id AS cid
             FROM opinions a JOIN opinions b ON a.cluster_id = b.cluster_id
            WHERE a.id < b.id AND a.blocked = 0 AND b.blocked = 0
              AND a.text != b.text
              AND length(a.text) > 2000 AND length(b.text) > 2000 LIMIT 1`
        )
        .get() as
          | { aid: number; atext: string; bid: number; btext: string; cid: number }
          | undefined;
      assert.ok(pair, "corpus must contain sibling opinions");

      // Extract a quoted span from A's text and cite B's primary citation.
      const m = pair.atext.match(/[\u201c"]([^\u201c\u201d"]{40,320})[\u201d"]/);
      assert.ok(m, "sibling A must contain a quoted span");
      const q = m[1];
      const bCite = db
        .prepare(
          `SELECT volume, reporter, page FROM citation_strings
           WHERE cluster_id = ? ORDER BY CAST(volume AS INTEGER), page LIMIT 1`
        )
      .get(pair.cid) as { volume: string; reporter: string; page: string };
      assert.ok(bCite);
      const draft = `[LAW] The court said "${q}" (${bCite.volume} ${bCite.reporter} ${bCite.page}).`;
      const r = verifyText(db, draft);
      const qc = r.quotes[0];
      assert.ok(qc);
      // Real quote of the cited case, found in a sibling opinion: VERIFIED
      // with honest provenance (audit probe02 rerun 2026-09-21) — the old
      // downgrade-to-not_found design still false-struck real law.
      assert.equal(qc.status, "verified");
      assert.equal(qc.true_source?.within_cluster, true);
      assert.ok(r.overall === "pass");
    } finally {
      db.close();
    }
  }
);

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
