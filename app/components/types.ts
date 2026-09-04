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
  element_checklist: Array<{ element: string; status: string; basis: string }>;
  adversary: { counter_argument: string; treatment_caveats: string[]; counter_authority: HitCard[] };
  draft: { overall: "pass" | "fail"; sentences: VerifiedSentence[]; report: unknown };
  drafted: {
    banner: string;
    title: string;
    caption: string;
    authority_appendix: Array<{ citation: string; case_name: string | null; verified: boolean; inferred_treatment: string[] }>;
    verification: { overall: string; summary: Record<string, number> };
    generated_at: string;
  };
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
    lines.push(`- ${a.citation} (${a.case_name ?? "—"})${a.verified ? "" : " UNVERIFIED"}${treat}`);
  }
  lines.push("");
  lines.push(
    `verification: ${out.draft.overall} · ${JSON.stringify(out.drafted.verification.summary)}`
  );
  return lines.join("\n");
}
