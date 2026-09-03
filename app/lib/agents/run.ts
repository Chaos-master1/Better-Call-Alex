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
  verifyTaggedSentencesAsync,
  confineRecordSentences,
  type RenderedDraft,
  type TaggedSentence,
} from "../render.js";
import { draftDocument, type DraftDoc } from "../draft.js";
import { openCorpus } from "../db.js";

export interface RunOutput {
  run_id: number;
  case_id: number;
  intake: IntakeOutput;
  research: ResearcherOutput;
  analyst: AnalystOutput;
  adversary: AdversaryOutput;
  draft: RenderedDraft;
  drafted: DraftDoc;
  /** Total wall-clock ms. */
  ms: number;
}

// 12 GB VRAM can hold only one model at a time — serialize runs so swaps
// do not thrash. Concurrent POST /api/run calls queue here instead of
// issuing concurrent Ollama loads that surface as "fetch failed".
let _runQueue: Promise<void> = Promise.resolve();

export interface RunOptions {
  /** Client disconnect (route passes req.signal). Cooperative: checked at
   *  every stage boundary — an in-flight model call still finishes, but the
   *  pipeline stops at the next boundary instead of burning minutes and
   *  holding the single-flight slot. The installed ollama client has no
   *  per-call signal support, so boundary checks are the full mechanism. */
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const e = new Error("run cancelled by client");
    e.name = "AbortError";
    throw e;
  }
}

export async function runCase(
  appDb: Database.Database,
  caseId: number,
  facts: string,
  opts: RunOptions = {}
): Promise<RunOutput> {
  // acquire single-flight slot
  let release!: () => void;
  const myTurn = new Promise<void>((r) => (release = r));
  const prev = _runQueue;
  _runQueue = myTurn;
  await prev;
  const t0 = performance.now();
  // One shared transaction context would be nicer; better-sqlite3 is sync,
  // so each call gets its own handle and we close at the end. openCorpus()
  // must stay inside the try: a throw before the finally would leak the
  // single-flight slot and deadlock every subsequent run.
  let corpus: Database.Database | null = null;
  try {
    // The running row is created BEFORE any fallible work: a pre-intake
    // throw (openCorpus, model load) must still leave a failed run behind,
    // not an invisible case that 404s in history.
    startRun(appDb, caseId);
    throwIfAborted(opts.signal);
    corpus = openCorpus();
    // 1. intake (qwen3.5:9b)
    await useModel(RESIDENT_MODEL);
    throwIfAborted(opts.signal);
    const intake = await intakeAgent(facts);
    persistIntake(appDb, caseId, intake);
    audit(appDb, "agent.intake", { caseId }, caseId);

    // 2. researcher (qwen3.5:9b, on resident model)
    throwIfAborted(opts.signal);
    const research = await researcherAgent(intake, corpus);
    persistResearch(appDb, caseId, research);
    audit(appDb, "agent.researcher", { caseId, hits: research.hits.length }, caseId);

    // 3. swap to 14b for the analyst + adversary pass
    throwIfAborted(opts.signal);
    await useModel(ANALYST_MODEL);

    const analyst = await analystAgent(intake, research);
    persistAnalyst(appDb, caseId, analyst);
    audit(appDb, "agent.analyst", { caseId }, caseId);

    throwIfAborted(opts.signal);
    const adversary = await adversaryAgent(intake, research, analyst, corpus);
    persistAdversary(appDb, caseId, adversary);
    audit(appDb, "agent.adversary", { caseId }, caseId);

    // 4. verifier gate over the combined tagged sentences (async — does not block loop)
    const combined: TaggedSentence[] = [
      ...analyst.tagged_sentences,
      ...adversary.tagged_sentences,
    ];
    // RECORD confinement runs here for the audit count AND inside the
    // verify fns (idempotent second pass) so the gate holds for all
    // callers, not just this orchestrator.
    const intakeFacts = [...intake.facts, ...intake.claims].join(" ");
    const { sentences: confined, retagged } = confineRecordSentences(combined, intakeFacts);
    // Use async bridge when an event loop is present (server); fall back to sync
    // for the CLI where top-level await is not needed. The sync path is still
    // the canonical one for evals; this path just avoids blocking.
    const draft = process.env.ALEX_VERIFY_SYNC === "1"
      ? verifyTaggedSentences(corpus, confined, intakeFacts)
      : await verifyTaggedSentencesAsync(corpus, confined, intakeFacts);
    audit(appDb, "verifier.run", {
      caseId,
      overall: draft.overall,
      sentences: draft.sentences.length,
      verified: draft.sentences.filter((s) => s.verified).length,
      record_retagged: retagged,
    }, caseId);

    // 5. drafter template (pure, no LLM) — banner applied in code per §11
    const drafted = draftDocument(draft, intake, research, analyst, adversary);
    // keep the JSON for audit; the UI renders `draft` + `drafted` together
    appDb
      .prepare(`UPDATE runs SET draft_json = ? WHERE case_id = ? AND status = 'running'`)
      .run(JSON.stringify(drafted), caseId);
    audit(appDb, "drafter.render", { caseId, banner: drafted.banner, overall: drafted.verification.overall }, caseId);

    // 6. swap back to 9b so subsequent runs start on the resident model
    await useModel(RESIDENT_MODEL);

    const runId = finalizeRun(appDb, caseId, "succeeded", performance.now() - t0);
    return {
      run_id: runId,
      case_id: caseId,
      intake,
      research,
      analyst,
      adversary,
      draft,
      drafted,
      ms: performance.now() - t0,
    };
  } catch (err) {
    try {
      audit(appDb, "agent.error", { caseId, err: String(err) }, caseId);
    } catch {
      // The audit write itself must never mask the pipeline error or skip
      // finalization (DB-locked audit previously left rows running for an
      // hour until recoverStaleRuns).
    }
    try {
      // Restore the resident model even on failure: without this the daemon
      // sits on the 14b weights and the next run pays an extra swap, which
      // breaks the ≤2-swaps accounting and slows recovery.
      await useModel(RESIDENT_MODEL);
    } catch {
      // Ollama itself is down — nothing to restore; the next run retries.
    }
    // A client-aborted run is cancelled, not failed: the pipeline did not
    // break, the user walked away. History shows the truth either way.
    const cancelled = (err as Error)?.name === "AbortError";
    finalizeRun(appDb, caseId, cancelled ? "cancelled" : "failed", performance.now() - t0);
    throw err;
  } finally {
    try {
      corpus?.close();
    } finally {
      release();
    }
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
  status: "succeeded" | "failed" | "cancelled",
  ms?: number
): number {
  const target = appDb
    .prepare(
      `SELECT id FROM runs WHERE case_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`
    )
    .get(caseId) as { id: number } | undefined;
  if (!target) return 0;
  appDb
    .prepare(
      `UPDATE runs SET status = ?, finished_at = datetime('now'), ms = ? WHERE id = ?`
    )
    .run(status, Math.round(ms ?? 0), target.id);
  return target.id;
}

function persistIntake(
  appDb: Database.Database,
  caseId: number,
  intake: IntakeOutput
): void {
  // startRun() already ran before any fallible work (see runCase); this
  // only persists the intake payload onto the running row.
  appDb
    .prepare(
      `INSERT INTO messages (case_id, role, content, model) VALUES (?, 'assistant', ?, ?)`
    )
    .run(caseId, JSON.stringify(intake), RESIDENT_MODEL);
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
    // Full object, not just queries — the history API rehydrates the
    // research panel (top picks + hits) from this column.
    .run(JSON.stringify(research), caseId);
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
    .run(caseId, JSON.stringify(analyst), ANALYST_MODEL);
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
    .run(caseId, JSON.stringify(adversary), ANALYST_MODEL);
  appDb
    .prepare(
      `UPDATE runs SET adversary_json = ? WHERE case_id = ? AND status = 'running'`
    )
    .run(JSON.stringify(adversary), caseId);
}
