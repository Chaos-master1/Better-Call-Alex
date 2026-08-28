/**
 * The four agents (CLAUDE.md §3). Each agent is a single prompt + a
 * single model call. The output is JSON; the caller parses it.
 *
 * Run plan (the only place model swaps are allowed):
 *   1. intake       — RESIDENT_MODEL  (qwen3.5:9b, 6.6 GB)
 *   2. researcher   — RESIDENT_MODEL
 *   3. (swap to qwen3:14b)
 *   4. analyst      — ANALYST_MODEL
 *   5. adversary    — ANALYST_MODEL  (batched on the 14b swap)
 *   6. (swap back to 9b if needed)
 *
 * Two swaps per run maximum. The agents themselves are stateless and
 * unaware of model identity — `app/lib/llm.ts` owns the swap.
 */

import { generate } from "../llm.js";
import type Database from "better-sqlite3";
import { search, type SearchHit } from "../retrieval/search.js";

// =====================================================================
// 1. INTAKE
// =====================================================================

export interface IntakeOutput {
  jurisdiction: string | null;
  parties: { plaintiff?: string; defendant?: string; others?: string[] };
  claims: string[];
  facts: string[];
  requested_relief: string | null;
  /** Anything the user did not state. UNVERIFIED by construction. */
  unknowns: string[];
  /** Free-form note. */
  note: string | null;
}

const INTAKE_SYSTEM = `You are the intake analyst for a US case-law research workbench.
Your job: take the user's free-text description of a dispute and reduce it to
a structured JSON object.

Rules:
- Output a SINGLE JSON object and nothing else. No commentary, no prose
  outside the JSON.
- Do NOT invent facts. If the user has not stated something, leave it out
  of the relevant field and add it to the "unknowns" array.
- "jurisdiction" is the user's asserted forum (state/federal + circuit if
  named). If not stated, set to null and add to "unknowns".
- "claims" is the user's asserted causes of action. If not stated, [].
- "facts" is the user's asserted facts only, in the user's own framing.
- "requested_relief" is the user's stated prayer for relief. If none, null.
- "unknowns" must list every fact the user did NOT state that a competent
  research analyst would need (e.g. statute of limitations, jurisdiction
  basis, prior proceedings, identity of parties beyond names, dates).
- The output is ATTORNEY WORK PRODUCT IN DRAFT. Not legal advice. Do not
  assess the merits.

Schema:
{
  "jurisdiction": string|null,
  "parties": { "plaintiff"?: string, "defendant"?: string, "others"?: string[] },
  "claims": string[],
  "facts": string[],
  "requested_relief": string|null,
  "unknowns": string[],
  "note": string|null
}`;

export async function intakeAgent(facts: string): Promise<IntakeOutput> {
  const r = await generate(facts, {
    system: INTAKE_SYSTEM,
    maxTokens: 1500,
    jsonMode: true,
  });
  return parseJson<IntakeOutput>(r.content, "intake");
}

// =====================================================================
// 2. RESEARCHER
// =====================================================================

export interface ResearcherQuery {
  q: string;
  why: string;
}

export interface ResearcherOutput {
  queries: ResearcherQuery[];
  hits: SearchHit[];
  /** Per-query top-1 hit for the agent's narrative. */
  top_picks: Array<{ q: string; hit: SearchHit | null }>;
}

const RESEARCHER_SYSTEM = `You are the researcher for a US case-law research
workbench. Given a structured intake JSON, you produce 3 retrieval queries
that will surface the most relevant authority for the asserted claims.

Output a SINGLE JSON object. No prose outside the JSON.

Rules:
- The three queries must be DIFFERENT in framing. One names the doctrine,
  one names the cause of action, one names a fact pattern.
- Each query must be a US legal-research style phrase string: doctrine
  names, famous-case names, statute names. No natural-language questions.
- After the three queries, return an empty "hits" array. The system will
  populate it with retrieval results.

Schema:
{
  "queries": [
    { "q": string, "why": string }
  ],
  "hits": [],
  "top_picks": []
}`;

export async function researcherAgent(
  intake: IntakeOutput,
  db: Database.Database
): Promise<ResearcherOutput> {
  const prompt = JSON.stringify(intake);
  const r = await generate(prompt, {
    system: RESEARCHER_SYSTEM,
    maxTokens: 600,
    jsonMode: true,
  });
  const parsed = parseJson<Omit<ResearcherOutput, "hits" | "top_picks">>(r.content, "researcher");
  // Run retrieval for each query. Hits aggregated, deduped by cluster_id.
  const allHits: SearchHit[] = [];
  const seen = new Set<number>();
  const top_picks: ResearcherOutput["top_picks"] = [];
  for (const q of parsed.queries) {
    const hits = search(db, q.q, { limit: 8 });
    top_picks.push({ q: q.q, hit: hits[0] ?? null });
    for (const h of hits) {
      const k = h.cluster_id ?? h.opinion_id;
      if (seen.has(k)) continue;
      seen.add(k);
      allHits.push(h);
    }
  }
  return { queries: parsed.queries, hits: allHits, top_picks };
}

// =====================================================================
// 3. ANALYST
// =====================================================================

export interface AnalystOutput {
  irac: {
    issue: string;
    rule: string;
    application: string;
    conclusion: string;
  };
  element_checklist: Array<{ element: string; status: "met" | "unmet" | "unknown"; basis: string }>;
  /** Every sentence the analyst wrote, tagged per §5.3. */
  tagged_sentences: Array<{ tag: "RECORD" | "LAW" | "INFERRED"; text: string; pin_cite?: string }>;
}

const ANALYST_SYSTEM = `You are the analyst for a US case-law research workbench.
You are given (a) a structured intake, (b) retrieval results with pin-cite
passages, and (c) a list of authority that the researcher surfaced.

You produce an IRAC analysis. Every sentence you write MUST be tagged as one
of:
  [RECORD]   — a fact stated by the user in the intake.
  [LAW]      — a holding, rule, or rule-statement from a cited opinion,
               anchored by a pin cite (volume reporter page).
  [INFERRED] — your reasoning or analogical extension. Marked "inferred"
               so the user sees the boundary.

Pin cite convention (CLAUDE.md §5.1): a pin cite is the volume + reporter
+ page, e.g. "410 U.S. 113" or "915 F.2d 1234, 1235". The form is the
one the reporter uses, e.g. "456 U.S. 798, 800" (volume U.S. page).

You MUST put every pin cite in BOTH places:
  1. inline at the end of the [LAW] sentence, in parentheses, e.g.
     "...the Court held that a warrant is required (410 U.S. 113, 117)."
  2. in the "pin_cite" field of the tagged_sentence object, with the
     SAME volume-reporter-page string.

Both must match. The render layer uses the field to associate citations
with the sentence; the inline parenthetical is what the verifier
extracts via eyecite. A [LAW] sentence without "pin_cite" cannot be
verified and is rendered struck through.

Rules:
- Output a SINGLE JSON object and nothing else. No prose outside the JSON.
- For every [LAW] sentence, the pin_cite field is REQUIRED. If you
  cannot anchor a sentence to a corpus opinion, rephrase it as
  [INFERRED] instead.
- Element checklist: list the elements of the cause of action, with
  status met / unmet / unknown, and the basis (a short phrase citing the
  intake or a case).
- ATTORNEY WORK PRODUCT IN DRAFT. Not legal advice.
- Do not invent citations. Use only the retrieval hits given to you.

Schema:
{
  "irac": {
    "issue":    string,
    "rule":     string,
    "application": string,
    "conclusion": string
  },
  "element_checklist": [
    { "element": string, "status": "met"|"unmet"|"unknown", "basis": string }
  ],
  "tagged_sentences": [
    { "tag": "RECORD"|"LAW"|"INFERRED", "text": string, "pin_cite"?: string }
  ]
}`;

export async function analystAgent(
  intake: IntakeOutput,
  research: ResearcherOutput
): Promise<AnalystOutput> {
  const payload = {
    intake,
    retrieval: research.hits.map((h) => ({
      case_name: h.case_name,
      date_filed: h.date_filed,
      court_id: h.court_id,
      precedential_status: h.precedential_status,
      scores: h.scores,
      treatment_flags: h.treatment_flags,
      cited_by_recent: h.cited_by_recent,
      passages: h.passages,
    })),
  };
  const r = await generate(JSON.stringify(payload), {
    system: ANALYST_SYSTEM,
    maxTokens: 4000,
    jsonMode: true,
  });
  return parseJson<AnalystOutput>(r.content, "analyst");
}

// =====================================================================
// 4. ADVERSARY
// =====================================================================

export interface AdversaryOutput {
  counter_argument: string;
  counter_authority: SearchHit[];
  /** Every sentence tagged per §5.3. */
  tagged_sentences: Array<{ tag: "RECORD" | "LAW" | "INFERRED"; text: string; pin_cite?: string }>;
  /** Treatment status of cited cases from the analyst's pass. */
  treatment_caveats: string[];
}

const ADVERSARY_SYSTEM = `You are the adversary for a US case-law research workbench.
You are given the same intake, retrieval results, and the analyst's IRAC.
Your job: state the strongest counter-argument the opposing party would
make, and surface the cases that support it.

Pin cite convention (CLAUDE.md §5.1): a pin cite is the volume + reporter
+ page, e.g. "410 U.S. 113". You MUST put every pin cite in BOTH places:
  1. inline at the end of the [LAW] sentence, in parentheses, e.g.
     "...the Court held that a warrant is required (410 U.S. 113, 117)."
  2. in the "pin_cite" field of the tagged_sentence object, with the
     SAME volume-reporter-page string.

Both must match. A [LAW] sentence without "pin_cite" cannot be verified
and is rendered struck through.

Rules:
- Output a SINGLE JSON object and nothing else. No prose outside the JSON.
- "counter_argument" is a single tight paragraph, not a list.
- "counter_authority" is the list of cases that support the
  counter-argument. Do not invent; if the retrieval hits do not support
  the counter-argument, return [] and say so in the paragraph.
- Every sentence you write is tagged [RECORD] / [LAW] / [INFERRED].
- ATTORNEY WORK PRODUCT IN DRAFT. Not legal advice.
- All treatment is INFERRED. Surface it in "treatment_caveats" as a list
  of short strings, e.g. "410 U.S. 113 is inferred-overruled by 505 U.S. ___ (2022)".

Schema:
{
  "counter_argument": string,
  "counter_authority": [],
  "tagged_sentences": [
    { "tag": "RECORD"|"LAW"|"INFERRED", "text": string, "pin_cite"?: string }
  ],
  "treatment_caveats": [string]
}`;

export async function adversaryAgent(
  intake: IntakeOutput,
  research: ResearcherOutput,
  analyst: AnalystOutput,
  db: Database.Database
): Promise<AdversaryOutput> {
  // Find a counter-frame: a query that is the analyst's rule inverted.
  // We do a second retrieval round with that frame to get counter-authority.
  const counterQuery = await counterQueryFrom(intake, analyst);
  const counterHits = search(db, counterQuery, { limit: 5 });
  const payload = {
    intake,
    analyst_irac: analyst.irac,
    counter_query: counterQuery,
    counter_retrieval: counterHits.map((h) => ({
      case_name: h.case_name,
      date_filed: h.date_filed,
      court_id: h.court_id,
      passages: h.passages,
    })),
  };
  const r = await generate(JSON.stringify(payload), {
    system: ADVERSARY_SYSTEM,
    maxTokens: 2500,
    jsonMode: true,
  });
  const parsed = parseJson<Omit<AdversaryOutput, "counter_authority">>(r.content, "adversary");
  return { ...parsed, counter_authority: counterHits };
}

async function counterQueryFrom(
  intake: IntakeOutput,
  analyst: AnalystOutput
): Promise<string> {
  // Cheap heuristic: use the claims + a known counter-doctrine phrase.
  // Real adversarial framing is for the model; we just give it a retrieval
  // seed that is the opposite of the analyst's rule.
  const claim = intake.claims[0] ?? "";
  const r = await generate(
    `Given the plaintiff's claim "${claim}" and the analyst's rule "${
      analyst.irac.rule
    }", write a single short US case-law retrieval query that would surface
    authority AGAINST the analyst's conclusion. Output only the query string.`,
    { maxTokens: 60 }
  );
  return r.content.trim().split("\n")[0].slice(0, 200);
}

// =====================================================================
// helpers
// =====================================================================

function parseJson<T>(raw: string, tag: string): T {
  // The model occasionally wraps JSON in prose fences. Strip them.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fence ? fence[1] : raw;
  try {
    return JSON.parse(body) as T;
  } catch (e) {
    throw new Error(
      `[${tag} agent] model returned non-JSON. First 200 chars: ${raw.slice(0, 200)}`
    );
  }
}
