/**
 * Drafter — template plus optional one LLM call (CLAUDE.md §3).
 * Pure template by default: re-verified before emit if polish is enabled.
 *
 * The banner DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE is
 * applied HERE in code, not by prompt (CLAUDE.md §11).
 */

import type { RenderedDraft } from "./render.js";
import { TREATMENT_LABELS } from "./verify/core.js";
import type { IntakeOutput, AnalystOutput, AdversaryOutput, ResearcherOutput } from "./agents/index.js";
import type { VerificationCertificate } from "./certificate.js";
import { IRAC_MARKER, COUNTER_ARGUMENT_MARKER, ANY_MARKER, iracFieldOf } from "./markers.js";

export const DRAFT_BANNER = "DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE";

export interface DraftSection {
  heading: string;
  body: string;
}

export interface DraftDoc {
  banner: string;
  title: string;
  caption: string;
  /**
   * IRAC fields as VERIFIED sentences (2026-09-20 audit fix). The raw
   * analyst prose used to ride ungated into the UI and the exported DOCX;
   * it now goes through the same Verifier gate as the draft — failed
   * sentences arrive struck-through and the export renders them so.
   * Keyed by IRAC field; `undefined` when the pipeline did not gate that
   * field (defensive for callers built before the fix).
   */
  irac_verified?: Partial<Record<keyof AnalystOutput["irac"], RenderedDraft["sentences"][number]>>;
  /** The full IRAC prose still rides along for JSON round-trips. */
  irac: AnalystOutput["irac"];
  element_checklist: AnalystOutput["element_checklist"];
  sentences: RenderedDraft["sentences"];
  adversary: {
    /** Verified [COUNTER-ARGUMENT] sentence, if the gate covered it. */
    counter_argument_verified?: RenderedDraft["sentences"][number];
    /** Raw prose (audit JSON round-trip); the UI/export prefer the verified form. */
    counter_argument: string;
    counter_authority: AdversaryOutput["counter_authority"];
    treatment_caveats: string[];
  };
  authority_appendix: Array<{
    citation: string;
    case_name: string | null;
    verified: boolean;
    inferred_treatment: string[];
    /** F1 good-law: strike-grade proven signal (same labels; from the
     *  strict treatment_proven table). Overruled-family proven signal is
     *  surfaced as a hard warning in UI/DOCX — the sentence strike itself
     *  happens in render. */
    proven_treatment?: string[];
    /** citation maps to >1 cluster — the cite alone is not unique */
    ambiguous?: boolean;
  }>;
  verification: {
    overall: RenderedDraft["overall"];
    summary: RenderedDraft["report"]["summary"];
    verdict: RenderedDraft["verdict"];
  };
  /** Machine-checkable proof artifact (Phase A): digest of THIS document,
   *  per-citation verdicts, engine provenance, and the append-only audit
   *  row anchor. Absent on drafts from pre-certificate runs (the export
   *  renders an honest "no certificate" line for those). */
  certificate?: VerificationCertificate;
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

  // Pull the gated IRAC + counter-argument sentences back out of the
  // verified render (run.ts emits them via the shared marker contract in
  // markers.ts).
  const irac_verified: DraftDoc["irac_verified"] = {};
  let counter_argument_verified: DraftDoc["adversary"]["counter_argument_verified"];
  for (const s of rendered.sentences) {
    const field = iracFieldOf(s.text);
    if (field) {
      irac_verified[field] = { ...s, text: s.text.replace(IRAC_MARKER, "") };
      continue;
    }
    if (COUNTER_ARGUMENT_MARKER.test(s.text)) {
      counter_argument_verified = { ...s, text: s.text.replace(COUNTER_ARGUMENT_MARKER, "") };
    }
  }

  // Markers are assembly scaffolding, not document content, so the
  // published sentence list is stripped too. The model sometimes echoes
  // the marker as well as the bare sentence — the duplicate would read as
  // a stutter, so drop it.
  const cleanSentences: typeof rendered.sentences = [];
  for (const s of rendered.sentences) {
    const m = s.text.match(ANY_MARKER);
    const clean = m ? { ...s, text: s.text.slice(m[0].length) } : s;
    if (
      m &&
      cleanSentences.length > 0 &&
      cleanSentences[cleanSentences.length - 1].text === clean.text
    ) {
      continue;
    }
    cleanSentences.push(clean);
  }

  const authority_appendix = rendered.report.citations
    .filter((c) => c.form === "full")
    .map((c) => ({
      citation: c.corrected || c.citation_text,
      case_name: c.case_name ?? null,
      verified: c.status === "verified",
      inferred_treatment: c.inferred_treatment ?? [],
      proven_treatment:
        c.proven_treatment != null
          ? TREATMENT_LABELS.filter((t) => c.proven_treatment! & t.bit).map((t) => t.label)
          : undefined,
      ambiguous: (c.ambiguous_cluster_ids?.length ?? 0) > 1,
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
    irac_verified,
    irac: analyst.irac,
    element_checklist: analyst.element_checklist,
    sentences: cleanSentences,
    adversary: {
      counter_argument_verified,
      counter_argument: adversary.counter_argument,
      counter_authority: adversary.counter_authority,
      treatment_caveats: adversary.treatment_caveats,
    },
    authority_appendix: deduped,
    verification: (() => {
      // The verify report's summary counts citations/quotes; a draft whose
      // only problem is a struck sentence (or with none of either) would
      // serialize an unhelpful {}. Sentence verdicts are draft-layer facts,
      // so they are folded in here — summary is never empty.
      return {
        overall: rendered.overall,
        summary: rendered.verdict
          ? {
              ...rendered.report.summary,
              "sentence:struck": rendered.verdict.sentences_struck,
              "sentence:verified": rendered.verdict.sentences_verified,
            }
          : rendered.report.summary,
        verdict: rendered.verdict,
      };
    })(),
    generated_at: new Date().toISOString(),
  };
}
