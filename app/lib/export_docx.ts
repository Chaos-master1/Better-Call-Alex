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

export type PlannedBlock =
  | { kind: "banner"; text: string }
  | { kind: "title"; text: string }
  | { kind: "caption"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "body"; text: string }
  | { kind: "bullet"; text: string }
  | {
      kind: "sentence";
      tag: string;
      text: string;
      pin_cite?: string;
      verified: boolean;
      inferred: boolean;
    };

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
export function planMotionParagraphs(drafted: DraftDoc): PlannedBlock[] {
  const blocks: PlannedBlock[] = [];
  // §11: banner applied at the render/export layer in code, first thing out.
  blocks.push({ kind: "banner", text: drafted.banner });
  blocks.push({ kind: "title", text: drafted.title || "Case Research" });
  if (drafted.caption) blocks.push({ kind: "caption", text: drafted.caption });
  blocks.push({
    kind: "meta",
    text: `Generated ${drafted.generated_at} · verification: ${drafted.verification.overall} · ${JSON.stringify(drafted.verification.summary)}`,
  });

  blocks.push({ kind: "heading", text: "Issues, Rules, Analysis, Conclusion" });
  const irac = drafted.irac ?? {};
  for (const [label, key] of [
    ["ISSUE", "issue"],
    ["RULE", "rule"],
    ["APPLICATION", "application"],
    ["CONCLUSION", "conclusion"],
  ] as const) {
    const val = (irac as Record<string, unknown>)[key];
    if (typeof val === "string" && val.trim()) {
      for (const line of splitLines(val)) {
        blocks.push({ kind: "body", text: `${label}: ${line}` });
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
  for (const line of splitLines(drafted.adversary?.counter_argument ?? "")) {
    blocks.push({ kind: "body", text: line });
  }
  for (const caveat of drafted.adversary?.treatment_caveats ?? []) {
    blocks.push({ kind: "bullet", text: `Treatment caveat (inferred): ${caveat}` });
  }

  blocks.push({ kind: "heading", text: "Authority appendix" });
  for (const a of drafted.authority_appendix ?? []) {
    const treat = a.inferred_treatment?.length
      ? ` [inferred treatment: ${a.inferred_treatment.join(", ")}]`
      : "";
    const flag = a.verified ? "" : " — UNVERIFIED";
    blocks.push({
      kind: "bullet",
      text: `${a.citation} (${a.case_name ?? "—"})${treat}${flag}`,
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
