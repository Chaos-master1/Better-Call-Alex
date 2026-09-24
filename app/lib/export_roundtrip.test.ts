/**
 * Emitted-.docx round-trip tests (G5 "line breaks survive", beyond unit).
 * No new dependencies: a ~30-line local-header zip reader (stdlib zlib)
 * extracts word/document.xml and asserts on the real OOXML bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildMotionDocx, planMotionParagraphs } from "./export_docx.js";
import { DRAFT_BANNER, type DraftDoc } from "./draft.js";

/** Minimal zip reader: local file headers → name → inflated bytes. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (p + 30 <= buf.length) {
    const sig = buf.readUInt32LE(p);
    if (sig === 0x02014b50 || sig === 0x06054b50) break; // central dir / EOCD
    assert.equal(sig, 0x04034b50, `bad local header at ${p}`);
    const method = buf.readUInt16LE(p + 8);
    const compLen = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const data = buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + compLen);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 30 + nameLen + extraLen + compLen;
  }
  assert.ok(out.size > 0, "empty zip");
  return out;
}

function sampleDraft(): DraftDoc {
  return {
    banner: DRAFT_BANNER,
    title: "Research: probe",
    caption: "A v. B",
    irac: { issue: "i", rule: "r", application: "a\nb", conclusion: "c" },
    element_checklist: [],
    sentences: [
      { index: 0, tag: "LAW", text: "Good cite.", pin_cite: "410 U.S. 113", verified: true, detail: [], inferred: false },
      { index: 1, tag: "LAW", text: "Bad cite, no pin.", verified: false, detail: ["x"], inferred: false },
    ],
    adversary: { counter_argument: "x", counter_authority: [], treatment_caveats: [] },
    authority_appendix: [
      { citation: "410 U.S. 113", case_name: "Roe v. Wade", verified: true, inferred_treatment: [] },
    ],
    verification: {
      overall: "fail",
      summary: {},
      verdict: {
        overall: "fail",
        sentences_total: 2,
        sentences_verified: 1,
        sentences_struck: 1,
        citations_extracted: 0,
        citations_verified: 0,
        quotes_checked: 0,
        quotes_verified: 0,
        failures: [{ index: 1, tag: "LAW", reason: "x" }],
      },
    },
    generated_at: "2026-09-03T00:00:00.000Z",
  };
}

function countParas(xml: string): number {
  // "<w:p" alone also matches <w:pPr> — anchor on the delimiter end.
  return xml.split(/<w:p[ >]/).length - 1;
}

test("emitted docx: banner, appendix, one paragraph per sentence", async () => {
  const drafted = sampleDraft();
  const xml = unzip(await buildMotionDocx(drafted)).get("word/document.xml")!.toString("utf8");
  assert.ok(xml.includes("NOT LEGAL ADVICE"), "banner present");
  assert.ok(xml.includes("410 U.S. 113"), "appendix cite present");
  assert.ok(xml.includes("Roe v. Wade"), "appendix case name present");
  // Plan blocks and file paragraphs agree 1:1 — line breaks survive as
  // real paragraphs, never embedded newlines.
  assert.equal(countParas(xml), planMotionParagraphs(drafted).length);
});

test("emitted docx: exactly one true strike, UNVERIFIED marker, no val=false noise", async () => {
  const xml = unzip(await buildMotionDocx(sampleDraft())).get("word/document.xml")!.toString("utf8");
  assert.equal(xml.split("<w:strike/>").length - 1, 1);
  assert.ok(!xml.includes('w:val="false"'), "no explicit-false run noise");
  assert.ok(xml.includes("UNVERIFIED"), "marker present");
});
