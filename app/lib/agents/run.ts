/**
 * End-to-end run orchestrator (CLAUDE.md §3). One call drives:
 *
 *   intake → researcher → swap to 14b → analyst → adversary
 *            → verifier on the combined draft → render
 *
 * The orchestrator is the only place that calls the agents, swaps models,
 * and runs the verifier. It writes to `runs` and `messages` in the app
 * DB and appends to `audit_log` for every step (§5.6).
 *
 * The output is what the UI renders. Pin cites get verified. Sentences
 * that fail verification come back as `verified: false` and the UI
 * renders them struck-through (§3, §11).
 */
import type Database from "better-sqlite3";
import { audit } from "../app_db.js";
import {
  intakeAgent,
  researcherAgent,
  analystAgent,
  adversaryAgent,
  type IntakeOutput,
  type ResearcherOutput,
  type AnalystOutput,
  type AdversaryOutput,
} from "./index.js";
import { useModel, RESIDENT_MODEL, ANALYST_MODEL } from "../llm.js";
import {
  verifyTaggedSentences,
  type RenderedDraft,
  type TaggedSentence,
} from "../render.js";
import { openCorpus } from "../db.js";

export interface RunOutput {
  run_id: number;
  case_id: number;
  intake: IntakeOutput;
  research: ResearcherOutput;
  analyst: AnalystOutput;
  adversary: AdversaryOutput;
  draft: RenderedDraft;
  /** Total wall-clock ms. */
  ms: number;
}

export async function runCase(
  appDb: Database.Database,
  caseId: number,
  facts: string
): Promise<RunOutput> {
  const t0 = performance.now();
  const corpus = openCorpus();
  // One shared transaction context would be nicer; better-sqlite3 is sync,
  // so each call gets its own handle and we close at the end.
  try {
    // 1. intake (qwen3.5:9b)
    await useModel(RESIDENT_MODEL);
    const intake = await intakeAgent(facts);
    persistIntake(appDb, caseId, intake);
    audit(appDb, "agent.intake", { caseId });

    // 2. researcher (qwen3.5:9b, on resident model)
    const research = await researcherAgent(intake, corpus);
    persistResearch(appDb, caseId, research);
    audit(appDb, "agent.researcher", { caseId, hits: research.hits.length });

    // 3. swap to 14b for the analyst + adversary pass
    await useModel(ANALYST_MODEL);

    const analyst = await analystAgent(intake, research);
    persistAnalyst(appDb, caseId, analyst);
    audit(appDb, "agent.analyst", { caseId });

    const adversary = await adversaryAgent(intake, research, analyst, corpus);
    persistAdversary(appDb, caseId, adversary);
    audit(appDb, "agent.adversary", { caseId });

    // 4. verifier gate over the combined tagged sentences
    const combined: TaggedSentence[] = [
      ...analyst.tagged_sentences,
      ...adversary.tagged_sentences,
    ];
    const draft = verifyTaggedSentences(corpus, combined);
    audit(appDb, "verifier.run", {
      caseId,
      overall: draft.overall,
      sentences: draft.sentences.length,
      verified: draft.sentences.filter((s) => s.verified).length,
    });

    // 5. swap back to 9b so subsequent runs start on the resident model
    await useModel(RESIDENT_MODEL);

    const runId = finalizeRun(appDb, caseId, "succeeded");
    return {
      run_id: runId,
      case_id: caseId,
      intake,
      research,
      analyst,
      adversary,
      draft,
      ms: performance.now() - t0,
    };
  } catch (err) {
    audit(appDb, "agent.error", { caseId, err: String(err) });
    finalizeRun(appDb, caseId, "failed");
    throw err;
  } finally {
    corpus.close();
  }
}

// ---------------------------------------------------------------------
// persistence helpers
// ---------------------------------------------------------------------

function startRun(appDb: Database.Database, caseId: number): number {
  return Number(
    appDb
      .prepare(`INSERT INTO runs (case_id, status) VALUES (?, 'running')`)
      .run(caseId).lastInsertRowid
  );
}

/**
 * Mark the most recent running row for the case as finished and return
 * its id. The `ORDER BY id DESC LIMIT 1` makes this safe even if more
 * than one running row exists for the case (e.g. a previous attempt
 * that crashed before finalize).
 */
function finalizeRun(
  appDb: Database.Database,
  caseId: number,
  status: "succeeded" | "failed" | "cancelled"
): number {
  const target = appDb
    .prepare(
      `SELECT id FROM runs WHERE case_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`
    )
    .get(caseId) as { id: number } | undefined;
  if (!target) return 0;
  appDb
    .prepare(
      `UPDATE runs SET status = ?, finished_at = datetime('now') WHERE id = ?`
    )
    .run(status, target.id);
  return target.id;
}

function persistIntake(
  appDb: Database.Database,
  caseId: number,
  intake: IntakeOutput
): void {
  startRun(appDb, caseId);
  appDb
    .prepare(
      `INSERT INTO messages (case_id, role, content, model) VALUES (?, 'assistant', ?, ?)`
    )
    .run(caseId, JSON.stringify(intake), "qwen3.5:9b");
  appDb
    .prepare(
      `UPDATE runs SET intake_json = ? WHERE case_id = ? AND status = 'running'`
    )
    .run(JSON.stringify(intake), caseId);
}

function persistResearch(
  appDb: Database.Database,
  caseId: number,
  research: ResearcherOutput
): void {
  appDb
    .prepare(
      `UPDATE runs SET research_json = ? WHERE case_id = ? AND status = 'running'`
    )
    .run(JSON.stringify(research.queries), caseId);
}

function persistAnalyst(
  appDb: Database.Database,
  caseId: number,
  analyst: AnalystOutput
): void {
  appDb
    .prepare(
      `INSERT INTO messages (case_id, role, content, model) VALUES (?, 'assistant', ?, ?)`
    )
    .run(caseId, JSON.stringify(analyst), "qwen3:14b");
  appDb
    .prepare(
      `UPDATE runs SET analyst_json = ? WHERE case_id = ? AND status = 'running'`
    )
    .run(JSON.stringify(analyst), caseId);
}

function persistAdversary(
  appDb: Database.Database,
  caseId: number,
  adversary: AdversaryOutput
): void {
  appDb
    .prepare(
      `INSERT INTO messages (case_id, role, content, model) VALUES (?, 'assistant', ?, ?)`
    )
    .run(caseId, JSON.stringify(adversary), "qwen3:14b");
  appDb
    .prepare(
      `UPDATE runs SET adversary_json = ? WHERE case_id = ? AND status = 'running'`
    )
    .run(JSON.stringify(adversary), caseId);
}
