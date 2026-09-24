/**
 * Verify-then-revise (Phase E2) — the cite-check loop a real lawyer runs
 * on their own draft before filing.
 *
 * The verifier is the fail-closed gate; this module is the ONE bounded
 * repair pass behind it. The drafter sees its own struck sentences plus
 * the retrieval payload's canonical_cites and must, per sentence: repair
 * the citation, weaken the claim honestly, or drop the sentence. It can
 * never add authority that was not supplied (the verifier re-gates every
 * repaired word — grounding reduces error sources, it never bypasses
 * proof).
 *
 * Guards (each one exists because a model WILL try it):
 *   - exactly one pass, bounded output (maxTokens), boundary-typed;
 *   - the output is EXACT JSON: an array per flagged sentence, in order,
 *     so nothing can be smuggled in that was never flagged;
 *   - [LAW] count may not shrink (no gaming the verified rate by writing
 *     less law) and the verified count may not drop (a "repair" that
 *     verifies fewer sentences than doing nothing is a regression);
 *   - any repair failure is non-critical: the original draft stands and
 *     the audit trail says so. The gate never gets weaker for trying.
 */
import type { RenderedDraft, TaggedSentence, VerifiedSentence } from "../render.js";
import type { IntakeOutput } from "./index.js";
import { generate, type EngineId } from "../llm.js";

/** The retrieval evidence a repair may cite. Owned by this module so the
 *  agents' SearchHit (a heavier export graph) stays out of the repair's
 *  public surface; run.ts maps hits into this shape at the call site. */
export interface RepairEvidence {
  case_name: string | null;
  canonical_cites?: string[];
  passages: string[];
}

/** A struck sentence the drafter must answer for, with its verifier detail. */
interface FlaggedSentence {
  index: number;
  tag: string;
  text: string;
  detail: string[];
}

/** One replacement emitted by the drafter: a tagged sentence, or null to
 *  drop the struck sentence entirely (honest weakling: say less). */
interface RepairEntry {
  tag: "RECORD" | "LAW" | "INFERRED";
  text: string;
  pin_cite?: string;
}

const REPAIR_SYSTEM = `You are the repair pass for a US case-law research workbench.
The verifier struck some sentences of the draft you wrote. You receive each
struck sentence, WHY it failed (verifier detail), and the retrieval evidence
that was supplied for this case.

For EVERY flagged sentence, output exactly one entry, in the same order:
  - repair it: fix the citation to one of the supplied canonical_cites
    VERBATIM (you may append only a pin page after a comma), keep the
    proposition the evidence actually supports; or
  - weaken it honestly: rewrite as [INFERRED] with no citation; or
  - drop it: return null.

Hard rules:
- Never invent or "recall" a citation. Only canonical_cites you were given.
- Do not import facts or authority that was not in the original draft or
  the supplied evidence.
- [LAW] entries MUST carry a pin_cite AND the same cite inline in
  parentheses at the end of the text.
- Keep each repaired sentence a single sentence.
- Output a SINGLE JSON array and nothing else — one entry per flagged
  sentence, same order, null where you drop.

Schema per entry:
  { "tag": "RECORD"|"LAW"|"INFERRED", "text": string, "pin_cite"?: string }
or null.`;

export interface RepairSentence {
  tag: "RECORD" | "LAW" | "INFERRED";
  text: string;
  pin_cite?: string;
}

export interface RepairAnalysis {
  /** One entry per flagged sentence index: the replacement, or null when
   *  the drafter dropped the sentence (honest weakling: say less). */
  replacements: Array<{ index: number; sentence: RepairSentence | null }>;
  /** How many sentences survived the repair (non-null entries). */
  repaired_count: number;
  law_count: number;
  /** Engine that produced the repair (ADR-004 provenance). */
  engine?: EngineId;
}

/** Parse the model's exact-shaped answer against the flagged list.
 *  Pure — separated from the prompt call so the boundary contract is
 *  testable without an LLM. Throws on any contract violation. */
export function parseRepairEntries(
  flagged: FlaggedSentence[],
  raw: string
): RepairAnalysis {
  let parsed: unknown = JSON.parse(raw);
  // Models in jsonMode frequently wrap a bare array as {"items": [...]}/
  // {"repairs": [...]}/{"sentences": [...]}; unwrap a single-key object
  // whose value is the array we asked for.
  if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
    const vals = Object.values(parsed as Record<string, unknown>);
    if (vals.length === 1 && Array.isArray(vals[0])) parsed = vals[0];
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[repair] model returned ${typeof parsed}, expected an array`);
  }
  if (parsed.length !== flagged.length) {
    throw new Error(
      `[repair] model returned ${parsed.length} entries for ${flagged.length} flagged sentences`
    );
  }
  const replacements: RepairAnalysis["replacements"] = [];
  for (const [i, entry] of (parsed as unknown[]).entries()) {
    const index = flagged[i].index;
    if (entry === null) {
      replacements.push({ index, sentence: null }); // honest drop
      continue;
    }
    const e = entry as { tag?: unknown; text?: unknown; pin_cite?: unknown };
    const tag = e.tag === "RECORD" || e.tag === "LAW" || e.tag === "INFERRED" ? e.tag : null;
    if (!tag || typeof e.text !== "string" || e.text.trim() === "") {
      throw new Error(`[repair] entry ${i} is not a valid tagged sentence`);
    }
    if (tag === "LAW" && typeof e.pin_cite !== "string") {
      // Boundary rule: a LAW repair without a pin cite would be born
      // struck — treat as invalid and keep the original sentence instead
      // of silently re-striking the model's new prose.
      throw new Error(`[repair] entry ${i} is [LAW] without pin_cite`);
    }
    replacements.push({
      index,
      sentence:
        tag === "LAW"
          ? { tag, text: e.text.trim(), pin_cite: (e.pin_cite as string).trim() }
          : { tag, text: e.text.trim() },
    });
  }
  const kept = replacements.filter((r) => r.sentence !== null);
  const law_count = kept.filter((r) => r.sentence!.tag === "LAW").length;
  return { replacements, repaired_count: kept.length, law_count };
}

/** Build the repair payload + prompt and parse the model's exact-shaped
 *  answer. Exported for tests; callers want `repairStruckSentences`. */
export async function repairAnalysis(
  flagged: FlaggedSentence[],
  evidence: RepairEvidence[],
  intake: IntakeOutput
): Promise<RepairAnalysis> {
  const payload = {
    intake_claims: intake.claims,
    evidence: evidence.map((e) => ({
      case_name: e.case_name,
      ...(e.canonical_cites && e.canonical_cites.length > 0 ? { canonical_cites: e.canonical_cites } : {}),
      passages: e.passages,
    })),
    flagged_sentences: flagged,
  };
  const r = await generate(JSON.stringify(payload), {
    system: REPAIR_SYSTEM,
    maxTokens: 3000,
    jsonMode: true,
    stage: "repair",
  });
  const analysis = parseRepairEntries(flagged, r.content);
  return { ...analysis, engine: r.engine };
}

/**
 * Swap repaired sentences into the confined list by index and remove the
 * dropped ones. Indexes are the render/verify positions — crossReference
 * maps sentences 1:1 in order, so a flagged index IS a confined index.
 */
export function applyRepairs(
  confined: TaggedSentence[],
  repair: RepairAnalysis
): TaggedSentence[] {
  const byIndex = new Map<number, RepairSentence | null>();
  for (const r of repair.replacements) byIndex.set(r.index, r.sentence);
  const out: TaggedSentence[] = [];
  for (const [i, s] of confined.entries()) {
    if (!byIndex.has(i)) {
      out.push(s);
      continue;
    }
    const r = byIndex.get(i)!;
    if (r) {
      out.push({ tag: r.tag, text: r.text, ...(r.pin_cite ? { pin_cite: r.pin_cite } : {}) });
    }
    // null → dropped
  }
  return out;
}

/** The pipeline seam: collect struck sentences, run the ONE repair pass,
 *  and return sentences to re-verify — or null when there is nothing to
 *  repair or the drafter declined (callers keep the original draft). */
export async function repairStruckSentences(
  draft: RenderedDraft,
  evidence: RepairEvidence[],
  intake: IntakeOutput
): Promise<RepairAnalysis | null> {
  const flagged: FlaggedSentence[] = draft.sentences
    .filter((s: VerifiedSentence) => !s.verified)
    .map((s) => ({ index: s.index, tag: s.tag, text: s.text, detail: s.detail }));
  if (flagged.length === 0) return null;
  if (evidence.length === 0) return null; // no evidence → nothing honest to repair with
  return repairAnalysis(flagged, evidence, intake);
}
