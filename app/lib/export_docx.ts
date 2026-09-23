/**
 * G5 motion export — DraftDoc → .docx (CLAUDE.md §8 G5, §11).
 *
 * Two layers:
 *
 *   1. planMotionParagraphs() — pure, corpus-free planner. Turns a DraftDoc
 *      into an ordered list of blocks. This is where the G5 criteria live:
 *      every draft sentence becomes its OWN block (line breaks survive as
 *      real OOXML paragraphs, never "\n" inside a run), unverified
 *      sentences are kept and marked STRUCK (never silently dropped —
 *      §3/§11), and the §11 banner leads the document in code.
 *   2. buildMotionDocx() — thin serializer over the `docx` lib (the
 *      canon-confirmed G5 tool). No logic here beyond the mapping.
 *
 * No PDF path: react-pdf silently ignores `whiteSpace: pre-wrap` (G5 row),
 * and no failing eval case demands a second format (§2).
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { DraftDoc } from "./draft.js";
import type { VerifiedSentence } from "./render.js";

export type PlannedBlock =
  | { kind: "banner"; text: string }
  | { kind: "title"; text: string }
  | { kind: "caption"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "body"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "cert_head"; text: string }
  | { kind: "cert_line"; text: string }
  | { kind: "cert_hash"; text: string }
  | {
      kind: "sentence";
      tag: string;
      text: string;
      pin_cite?: string;
      verified: boolean;
      inferred: boolean;
    };

/** Sentence-kind payload shared by the verified-IRAC and counter-argument
 *  blocks: a failed gate renders struck-through with an UNVERIFIED marker,
 *  exactly like draft sentences (§3: the user must see what failed). */
type SentenceInfo = {
  tag: string;
  text: string;
  pin_cite?: string;
  verified: boolean;
  inferred: boolean;
};

function sentenceInfo(s: VerifiedSentence): SentenceInfo {
  return { tag: s.tag, text: s.text, pin_cite: s.pin_cite, verified: s.verified, inferred: s.inferred };
}

/** Split free text on newlines into non-empty paragraphs. A "\n" inside one
 *  OOXML run does not reliably survive as a line break in Word — the G5
 *  "exported line breaks survive" criterion is met by emitting real
 *  paragraphs, so multi-line model output (counter-argument, IRAC fields)
 *  is split here, not at render time. */
function splitLines(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Pure planner: DraftDoc → ordered blocks. Deterministic, no I/O, no DB.
 * Unit-tested in export_docx.test.ts (corpus-free, like statute.test.ts).
 */
/** One human-readable verification line for the document status block. */
function verificationLine(drafted: DraftDoc): string {
  const v = drafted.verification.verdict;
  if (!v) {
    return `Generated ${drafted.generated_at} · verification: ${drafted.verification.overall}`;
  }
  return (
    `Generated ${drafted.generated_at} · verification: ${v.overall.toUpperCase()} — ` +
    `sentences ${v.sentences_verified}/${v.sentences_total} verified, ` +
    `citations ${v.citations_verified}/${v.citations_extracted} resolved, ` +
    `quotes ${v.quotes_verified}/${v.quotes_checked} matched`
  );
}

export function planMotionParagraphs(drafted: DraftDoc): PlannedBlock[] {
  const blocks: PlannedBlock[] = [];
  // §11: banner applied at the render/export layer in code, first thing out.
  blocks.push({ kind: "banner", text: drafted.banner });
  blocks.push({ kind: "title", text: drafted.title || "Case Research" });
  if (drafted.caption) blocks.push({ kind: "caption", text: drafted.caption });
  blocks.push({
    kind: "meta",
    text: verificationLine(drafted),
  });

  blocks.push({ kind: "heading", text: "Issues, Rules, Analysis, Conclusion" });
  // §5.3 gate coverage: IRAC fields are rendered from their VERIFIED
  // sentences. A gate failure renders struck-through + UNVERIFIED — the
  // filed document can no longer carry prose the Verifier never checked.
  // When irac_verified is absent (pre-fix callers / eval fixtures), fall
  // back to the raw prose WITH an explicit [NOT VERIFIER-GATED] marker so
  // the fallback is loud, never silent.
  const irac = drafted.irac ?? {};
  const iracV = drafted.irac_verified ?? {};
  for (const [label, key] of [
    ["ISSUE", "issue"],
    ["RULE", "rule"],
    ["APPLICATION", "application"],
    ["CONCLUSION", "conclusion"],
  ] as const) {
    const gated = iracV[key];
    if (gated) {
      blocks.push({ kind: "sentence", ...sentenceInfo({ ...gated, tag: "INFERRED" }) });
      continue;
    }
    const val = (irac as Record<string, unknown>)[key];
    if (typeof val === "string" && val.trim()) {
      for (const line of splitLines(val)) {
        blocks.push({ kind: "body", text: `${label} [NOT VERIFIER-GATED]: ${line}` });
      }
    }
  }

  if (drafted.element_checklist?.length) {
    blocks.push({ kind: "heading", text: "Element checklist" });
    for (const el of drafted.element_checklist) {
      blocks.push({
        kind: "bullet",
        text: `${el.element} — ${el.status} (${el.basis})`,
      });
    }
  }

  blocks.push({ kind: "heading", text: "Draft" });
  for (const s of drafted.sentences ?? []) {
    blocks.push({
      kind: "sentence",
      tag: s.tag,
      text: s.text,
      pin_cite: s.pin_cite,
      verified: s.verified,
      inferred: s.inferred,
    });
  }

  blocks.push({ kind: "heading", text: "Counter-argument" });
  // Same §5.3 gate coverage for the adversary prose: prefer the verified
  // sentence (struck-through on failure); raw fallback is loudly marked.
  const counterV = drafted.adversary?.counter_argument_verified;
  if (counterV) {
    blocks.push({ kind: "sentence", ...sentenceInfo({ ...counterV, tag: "INFERRED" }) });
  } else {
    for (const line of splitLines(drafted.adversary?.counter_argument ?? "")) {
      blocks.push({ kind: "body", text: `COUNTER-ARGUMENT [NOT VERIFIER-GATED]: ${line}` });
    }
  }
  for (const caveat of drafted.adversary?.treatment_caveats ?? []) {
    blocks.push({ kind: "bullet", text: `Treatment caveat (inferred): ${caveat}` });
  }

  blocks.push({ kind: "heading", text: "Authority appendix" });
  for (const a of drafted.authority_appendix ?? []) {
    const treat = a.inferred_treatment?.length
      ? ` [inferred treatment: ${a.inferred_treatment.join(", ")}]`
      : "";
    const amb = a.ambiguous ? " [AMBIGUOUS — this citation maps to multiple cases]" : "";
    const flag = a.verified ? amb : amb + " — UNVERIFIED";
    blocks.push({
      kind: "bullet",
      text: `${a.citation} (${a.case_name ?? "—"})${treat}${flag}`,
    });
  }

  blocks.push({ kind: "heading", text: "Verification certificate" });
  const cert = drafted.certificate;
  if (cert) {
    blocks.push({ kind: "cert_head", text: `${cert.schema} · overall ${cert.overall.toUpperCase()}` });
    blocks.push({ kind: "cert_hash", text: `SHA-256 (canonical draft JSON): ${cert.draft_sha256}` });
    blocks.push({
      kind: "cert_line",
      text: `Audit anchor: audit_log row ${cert.audit_row_id ?? "(none)"} (append-only, trigger-enforced) · run ${cert.run_id ?? "—"} · issued ${cert.issued_at}`,
    });
    if (cert.engines.length) {
      blocks.push({
        kind: "cert_line",
        text: `Engines: ${cert.engines.map((e) => `${e.stage}=${e.engine}:${e.model}`).join(" · ")}`,
      });
    }
    blocks.push({ kind: "cert_line", text: cert.statement });
    blocks.push({
      kind: "cert_line",
      text: `Treatment signals are INFERRED from citing language, never asserted (§5.5). Pin pages are checked against star pagination where the corpus carries it; a pin outside the cited opinion\’s pages is flagged (docs/verifier.md).`,
    });
  } else {
    blocks.push({
      kind: "cert_line",
      text: "No verification certificate attached to this draft (pre-certificate run). Verification summary only.",
    });
  }
  return blocks;
}

function blockToParagraph(b: PlannedBlock): Paragraph {
  switch (b.kind) {
    case "banner":
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: b.text, bold: true, allCaps: true })],
      });
    case "title":
      return new Paragraph({ heading: HeadingLevel.TITLE, text: b.text });
    case "caption":
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: b.text, italics: true })],
      });
    case "meta":
      return new Paragraph({
        children: [new TextRun({ text: b.text, size: 18, color: "737373" })],
      });
    case "heading":
      return new Paragraph({ heading: HeadingLevel.HEADING_1, text: b.text });
    case "body":
      return new Paragraph({ text: b.text });
    case "bullet":
      return new Paragraph({ bullet: { level: 0 }, text: b.text });
    case "cert_head":
      return new Paragraph({
        children: [new TextRun({ text: b.text, bold: true })],
      });
    case "cert_hash":
      return new Paragraph({
        children: [new TextRun({ text: b.text, font: "Courier New", size: 18 })],
      });
    case "cert_line":
      return new Paragraph({
        children: [new TextRun({ text: b.text, size: 18, color: "595959" })],
      });
    case "sentence": {
      const children = [
        new TextRun({ text: `[${b.tag}] `, bold: true }),
        new TextRun({
          text: b.text,
          // Unverified sentences render struck-through, mirroring the UI
          // (§3: the user must see what failed). Inferred sentences render
          // italic — the §5.5 "never state as fact" boundary in print.
          // Omitted (not false) when off: the serializer would otherwise
          // emit an explicit w:val="false" on every run.
          strike: !b.verified ? true : undefined,
          italics: b.verified && b.inferred ? true : undefined,
        }),
      ];
      if (b.pin_cite) children.push(new TextRun({ text: ` (${b.pin_cite})` }));
      if (!b.verified) {
        children.push(new TextRun({ text: " — UNVERIFIED", bold: true }));
      }
      return new Paragraph({ children });
    }
  }
}

/** Serialize a drafted motion to .docx bytes. Pure mapping over the plan. */
export async function buildMotionDocx(drafted: DraftDoc): Promise<Buffer> {
  const doc = new Document({
    sections: [{ children: planMotionParagraphs(drafted).map(blockToParagraph) }],
  });
  return Packer.toBuffer(doc);
}

/** Attachment filename for a case export. Case titles are free text —
 *  slugify so the header cannot carry newlines or path separators. */
export function exportFilename(caseId: number, title: string): string {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `alex-case-${caseId}${slug ? `-${slug}` : ""}.docx`;
}
