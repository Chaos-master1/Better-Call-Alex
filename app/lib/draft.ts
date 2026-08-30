/**
 * Drafter — template plus optional one LLM call (CLAUDE.md §3).
 * Pure template by default: re-verified before emit if polish is enabled.
 *
 * The banner DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE is
 * applied HERE in code, not by prompt (CLAUDE.md §11).
 */

import type { RenderedDraft } from "./render.js";
import type { IntakeOutput, AnalystOutput, AdversaryOutput, ResearcherOutput } from "./agents/index.js";

export const DRAFT_BANNER = "DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE";

export interface DraftSection {
  heading: string;
  body: string;
}

export interface DraftDoc {
  banner: string;
  title: string;
  caption: string;
  irac: AnalystOutput["irac"];
  element_checklist: AnalystOutput["element_checklist"];
  sentences: RenderedDraft["sentences"];
  adversary: {
    counter_argument: string;
    counter_authority: AdversaryOutput["counter_authority"];
    treatment_caveats: string[];
  };
  authority_appendix: Array<{
    citation: string;
    case_name: string | null;
    verified: boolean;
    inferred_treatment: string[];
  }>;
  verification: {
    overall: RenderedDraft["overall"];
    summary: RenderedDraft["report"]["summary"];
  };
  generated_at: string;
}

export function draftDocument(
  rendered: RenderedDraft,
  intake: IntakeOutput,
  research: ResearcherOutput,
  analyst: AnalystOutput,
  adversary: AdversaryOutput
): DraftDoc {
  const title = intake.claims[0] ? `Research: ${intake.claims[0].slice(0, 80)}` : "Case Research";
  const plaintiff = intake.parties.plaintiff ?? "Plaintiff";
  const defendant = intake.parties.defendant ?? "Defendant";
  const caption = `${plaintiff} v. ${defendant}`;

  const authority_appendix = rendered.report.citations
    .filter((c) => c.form === "full")
    .map((c) => ({
      citation: c.corrected || c.citation_text,
      case_name: c.case_name ?? null,
      verified: c.status === "verified",
      inferred_treatment: c.inferred_treatment ?? [],
    }));

  // Deduplicate appendix by citation string
  const seen = new Set<string>();
  const deduped: DraftDoc["authority_appendix"] = [];
  for (const a of authority_appendix) {
    if (!seen.has(a.citation)) {
      seen.add(a.citation);
      deduped.push(a);
    }
  }

  return {
    banner: DRAFT_BANNER,
    title,
    caption,
    irac: analyst.irac,
    element_checklist: analyst.element_checklist,
    sentences: rendered.sentences,
    adversary: {
      counter_argument: adversary.counter_argument,
      counter_authority: adversary.counter_authority,
      treatment_caveats: adversary.treatment_caveats,
    },
    authority_appendix: deduped,
    verification: {
      overall: rendered.overall,
      summary: rendered.report.summary,
    },
    generated_at: new Date().toISOString(),
  };
}
