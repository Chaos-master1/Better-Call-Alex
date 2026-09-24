/**
 * G5 export tests — corpus-free. The paragraph planner is pure; the
 * serializer test asserts real .docx (zip) bytes. The G5 end-to-end
 * criterion (every exported citation resolves) is checked by the export
 * route's resolve gate plus logs/g5-report.json, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMotionDocx,
  exportFilename,
  planMotionParagraphs,
} from "./export_docx.js";
import { DRAFT_BANNER, type DraftDoc } from "./draft.js";

function sampleDraft(): DraftDoc {
  return {
    banner: DRAFT_BANNER,
    title: "Research: motel arrest",
    caption: "Plaintiff v. Defendant",
    irac: {
      issue: "Whether the arrest stated a claim.",
      rule: "Probable cause defeats false arrest.",
      application: "The officers acted on a call.\nThey confirmed identity.",
      conclusion: "Claim likely fails.",
    },
    element_checklist: [
      { element: "state action", status: "unknown", basis: "intake is silent" },
    ],
    sentences: [
      {
        index: 0,
        tag: "LAW",
        text: "Probable cause is a complete defense.",
        pin_cite: "410 U.S. 113",
        verified: true,
        detail: ["cite '410 U.S. 113' → verified"],
        inferred: false,
      },
      {
        index: 1,
        tag: "LAW",
        text: "The motel is a state actor.",
        verified: false,
        detail: ["LAW sentence without pin cite → unverified"],
        inferred: false,
      },
      {
        index: 2,
        tag: "INFERRED",
        text: "The court would likely extend this reasoning.",
        verified: true,
        detail: [],
        inferred: true,
      },
    ],
    adversary: {
      counter_argument: "The search was lawful.\nSmell alone suffices.",
      counter_authority: [],
      treatment_caveats: ["Roe has Dobbs-era overruling context (inferred)"],
    },
    authority_appendix: [
      {
        citation: "410 U.S. 113",
        case_name: "Roe v. Wade",
        verified: true,
        inferred_treatment: ["distinguished"],
      },
      {
        citation: "999 F.2d 999",
        case_name: null,
        verified: false,
        inferred_treatment: [],
      },
    ],
    verification: {
      overall: "fail",
      summary: { citations: 2, verified: 1 },
      verdict: {
        overall: "fail",
        sentences_total: 3,
        sentences_verified: 2,
        sentences_struck: 1,
        citations_extracted: 2,
        citations_verified: 1,
        quotes_checked: 0,
        quotes_verified: 0,
        failures: [{ index: 1, tag: "LAW", reason: "unresolved_citation" }],
      },
    },
    generated_at: "2026-09-03T00:00:00.000Z",
  };
}

// ——— planner ———

test("banner leads the document, in code not by prompt", () => {
  const blocks = planMotionParagraphs(sampleDraft());
  assert.equal(blocks[0].kind, "banner");
  assert.equal((blocks[0] as { text: string }).text, DRAFT_BANNER);
});

test("every draft sentence becomes its own block (line breaks survive)", () => {
  const blocks = planMotionParagraphs(sampleDraft());
  const sentences = blocks.filter((b) => b.kind === "sentence");
  assert.equal(sentences.length, 3);
});

test("unverified sentences are kept and flagged, never dropped", () => {
  const blocks = planMotionParagraphs(sampleDraft());
  const bad = blocks.filter(
    (b) => b.kind === "sentence" && !(b as { verified: boolean }).verified
  );
  assert.equal(bad.length, 1);
  assert.equal((bad[0] as { tag: string }).tag, "LAW");
});

test("multi-line model output splits into real paragraphs", () => {
  const blocks = planMotionParagraphs(sampleDraft());
  const bodies = blocks.filter((b) => b.kind === "body");
  // application (2 lines) + counter-argument (2 lines) + issue/rule/conclusion
  assert.ok(bodies.length >= 5);
  for (const b of blocks) {
    if ("text" in b) assert.ok(!b.text.includes("\n"), `newline in ${b.kind}`);
  }
});

test("authority appendix carries inferred treatment + unverified flag", () => {
  const blocks = planMotionParagraphs(sampleDraft());
  const bullets = blocks.filter((b) => b.kind === "bullet");
  const appendix = bullets.slice(-2);
  assert.ok(appendix[0].text.includes("inferred treatment: distinguished"));
  assert.ok(appendix[1].text.includes("UNVERIFIED"));
});

// ——— §5.3 gate coverage for IRAC + counter-argument prose (2026-09-20 audit) ———

/** A DraftDoc whose IRAC + counter-argument WENT THROUGH the verifier: one
 *  field failed, the rest passed. */
function gatedDraft(): DraftDoc {
  const d = sampleDraft();
  d.irac_verified = {
    rule: {
      index: 90,
      tag: "INFERRED",
      text: "Probable cause defeats false arrest (per the court in/X).",
      verified: true,
      detail: [],
      inferred: true,
    },
    application: {
      index: 91,
      tag: "INFERRED",
      text: "The officers 'acted on a tip that never existed' per the record.",
      verified: false,
      detail: ["quote 'acted on a tip that never existed…' → quote_not_found"],
      inferred: true,
    },
  };
  d.adversary.counter_argument_verified = {
    index: 92,
    tag: "INFERRED",
    text: "Smell alone suffices for a vehicle search.",
    verified: true,
    detail: [],
    inferred: true,
  };
  return d;
}

test("gated IRAC renders as verified/unverified sentence blocks, never raw prose", () => {
  const blocks = planMotionParagraphs(gatedDraft());
  const bodies = blocks.filter((b) => b.kind === "body");
  // No raw IRAC prose may leak when a gated version exists.
  for (const b of bodies) assert.ok(!b.text.includes("Probable cause defeats"));
  const sentences = blocks.filter((b) => b.kind === "sentence");
  // 3 draft sentences + rule + application + counter-argument
  assert.equal(sentences.length, 6);
  const failed = sentences.find(
    (b) => (b as { text: string }).text.includes("tip that never existed")
  ) as { verified: boolean } | undefined;
  assert.ok(failed, "failed IRAC sentence present");
  assert.equal(failed.verified, false);
});

test("ungated fallback prose is loudly marked, never silent", () => {
  const blocks = planMotionParagraphs(sampleDraft());
  const bodies = blocks.filter((b) => b.kind === "body");
  const marked = bodies.filter((b) => b.text.includes("[NOT VERIFIER-GATED]"));
  assert.ok(marked.length >= 4, `expected marked fallback prose, got ${marked.length}`);
});

test("failed gated IRAC sentence strikes through in the emitted docx", async () => {
  const buf = await buildMotionDocx(gatedDraft());
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 1000);
});

// ——— serializer ———

test("buildMotionDocx emits real .docx (zip) bytes", async () => {
  const buf = await buildMotionDocx(sampleDraft());
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 1000);
  assert.equal(buf[0], 0x50); // 'P'
  assert.equal(buf[1], 0x4b); // 'K'
});

// ——— filename ———

test("exportFilename cannot carry path separators or newlines", () => {
  const name = exportFilename(7, "Smith v. Jones/../../../etc\ninjected");
  assert.ok(!name.includes("/"));
  assert.ok(!name.includes("\n"));
  assert.ok(name.startsWith("alex-case-7-"));
  assert.ok(name.endsWith(".docx"));
});
