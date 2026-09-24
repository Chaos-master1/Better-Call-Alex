/**
 * Shared UI types — mirrors of the POST /api/run + /api/cases payloads.
 * Presentation-only: no fetch, no verification logic lives here.
 */

export interface VerifiedSentence {
  index: number;
  tag: "RECORD" | "LAW" | "INFERRED";
  text: string;
  pin_cite?: string;
  verified: boolean;
  detail: string[];
  inferred: boolean;
}

export interface HitCard {
  case_name: string | null;
  case_name_short?: string | null;
  court_id: string | null;
  date_filed?: string | null;
  precedential_status?: string | null;
  scores: { bm25: number; authority_multiplier: number; final: number; parenthetical_hits: number };
  treatment_flags: number;
  cited_by_recent?: number;
  passages: Array<{ text: string; start: number; end: number }>;
  via_parenthetical_recall?: boolean;
}

/** ADR-004 per-stage engine provenance. */
export interface StageEngine {
  stage: string;
  engine: string;
  model: string;
}

/** Client mirror of the verification certificate (lib/certificate.ts). */
export interface VerificationCertificateClient {
  schema: string;
  issued_at: string;
  case_id: number;
  run_id: number | null;
  draft_sha256: string;
  audit_row_id: number | null;
  overall: string;
  summary: Record<string, number>;
  banner: string;
  citations: Array<{
    citation: string;
    case_name: string | null;
    status: string;
    verified: boolean;
    inferred_treatment: string[];
    ambiguous: boolean;
  }>;
  engines: Array<{ stage: string; engine: string; model: string }>;
  statement: string;
}

export interface RunResponse {
  case_id: number;
  run_id: number;
  intake: unknown;
  research: {
    queries: Array<{ q: string; why: string }>;
    top_picks: Array<{ q: string; hit: HitCard | null }>;
    hits: HitCard[];
  };
  irac: { issue: string; rule: string; application: string; conclusion: string };
  /** Per-field verified IRAC sentences (2026-09-20 §5.3 gate coverage).
   *  Failed fields carry verified:false and render struck-through. */
  drafted_irac_verified?: Partial<
    Record<"issue" | "rule" | "application" | "conclusion", VerifiedSentence>
  >;
  drafted_counter_argument_verified?: VerifiedSentence;
  element_checklist: Array<{ element: string; status: string; basis: string }>;
  adversary: { counter_argument: string; treatment_caveats: string[]; counter_authority: HitCard[] };
  draft: { overall: "pass" | "fail"; sentences: VerifiedSentence[]; report: unknown };
  drafted: {
    banner: string;
    title: string;
    caption: string;
    authority_appendix: Array<{ citation: string; case_name: string | null; verified: boolean; inferred_treatment: string[]; proven_treatment?: string[]; ambiguous?: boolean }>;
    verification: {
      overall: string;
      summary: Record<string, number>;
      verdict?: {
        overall: "pass" | "fail";
        sentences_total: number;
        sentences_verified: number;
        sentences_struck: number;
        citations_extracted: number;
        citations_verified: number;
        quotes_checked: number;
        quotes_verified: number;
        failures: Array<{ index: number; tag: string; reason: string }>;
      };
    };
    certificate?: VerificationCertificateClient;
    generated_at: string;
  };
  /** Which engine produced which stage (ADR-004). */
  engines?: StageEngine[];
  audit: Array<{ ts: string; kind: string; payload: string }>;
  ms: number;
}

export interface CaseSummary {
  id: number;
  title: string;
  created_at: string;
  status: string | null;
  run_id: number | null;
  ms: number | null;
  overall: string | null;
}

export const SAMPLE = `A 67-year-old Black man checked into a motel in Atlanta. The motel
manager called police and reported him as a 'suspicious person' after seeing
him in the lobby. Officers arrived, asked him to leave, and when he refused,
arrested him for trespass. He was held for 9 hours and released without
charges. He sues the motel under 42 U.S.C. § 1983.`;

const TREATMENT_BITS: Array<{ bit: number; label: string }> = [
  { bit: 1, label: "overruled" },
  { bit: 2, label: "abrogated" },
  { bit: 4, label: "distinguished" },
  { bit: 8, label: "but_see" },
  { bit: 16, label: "declined_to_follow" },
];

export function treatmentLabels(flags: number): string[] {
  if (!flags) return [];
  return TREATMENT_BITS.filter((t) => flags & t.bit).map((t) => t.label);
}

/** Plain-text rendering of a draft (clipboard copy path). */
export function draftToText(out: RunResponse): string {
  const lines: string[] = [];
  lines.push(out.drafted.banner);
  lines.push("");
  lines.push(out.drafted.title);
  lines.push(out.drafted.caption);
  lines.push("");
  lines.push("— IRAC —");
  for (const [k, v] of Object.entries(out.irac ?? {})) {
    lines.push(`${k.toUpperCase()}: ${String(v)}`);
  }
  lines.push("");
  lines.push("— DRAFT (sentences) —");
  for (const s of out.draft.sentences) {
    const cite = s.pin_cite ? ` (${s.pin_cite})` : "";
    const mark = s.verified ? "" : " [UNVERIFIED]";
    lines.push(`[${s.tag}] ${s.text}${cite}${mark}`);
  }
  lines.push("");
  lines.push("— COUNTER-ARGUMENT —");
  lines.push(String(out.adversary?.counter_argument ?? ""));
  lines.push("");
  lines.push("— AUTHORITY APPENDIX —");
  for (const a of out.drafted.authority_appendix ?? []) {
    const treat = a.inferred_treatment?.length
      ? ` [inferred: ${a.inferred_treatment.join(", ")}]`
      : "";
    const proven = a.proven_treatment?.length ? ` [PROVEN: ${a.proven_treatment.join(", ")}]` : "";
    lines.push(`- ${a.citation} (${a.case_name ?? "—"})${a.verified ? "" : " UNVERIFIED"}${proven}${treat}`);
  }
  lines.push("");
  lines.push(
    verificationLine(out)
  );
  return lines.join("\n");
}

/** The human-readable verdict line, shared by the UI status chip and the
 *  copy-as-text export. Reads the structured verdict when present. */
export function verificationLine(out: RunResponse): string {
  const v = out.drafted.verification.verdict;
  if (!v) return `verification: ${out.draft.overall}`;
  return (
    `verification: ${v.overall.toUpperCase()} — ` +
    `sentences ${v.sentences_verified}/${v.sentences_total} verified, ` +
    `citations ${v.citations_verified}/${v.citations_extracted} resolved, ` +
    `quotes ${v.quotes_verified}/${v.quotes_checked} matched`
  );
}
