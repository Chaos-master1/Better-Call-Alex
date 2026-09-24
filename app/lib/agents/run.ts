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
import {
  useModel,
  useEngine,
  setRunMode,
  consumeFallbackEvent,
  resetEngineToLocal,
  setCloudPayloadTransform,
  RESIDENT_MODEL,
  ANALYST_MODEL,
  engineQualifiedModel,
  type EngineId,
  type EngineMode,
} from "../llm.js";
import { createPayloadGuard, type PayloadGuard } from "./payload.js";
import {
  IRAC_FIELDS,
  iracSentence,
  counterArgumentSentence,
} from "../markers.js";
import {
  verifyTaggedSentences,
  verifyTaggedSentencesAsync,
  confineRecordSentences,
  type RenderedDraft,
  type TaggedSentence,
} from "../render.js";
import { draftDocument, type DraftDoc } from "../draft.js";
import {
  repairStruckSentences,
  applyRepairs,
  type RepairEvidence,
} from "./repair.js";
import { buildVerificationCertificate } from "../certificate.js";
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
  /** Per-stage engine provenance (ADR-004): stage → engine + qualified model. */
  engines: Array<{ stage: string; engine: EngineId; model: string }>;
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
  /** Per-run engine mode (ADR-004 UI toggle): "local" | "cloud" | "auto".
   *  Omitted → the env default (ALEX_ENGINE, local). Auto routes per-stage
   *  via ALEX_AUTO_ROUTE (analyst/adversary → cloud by default; researcher
   *  stays local — it writes for OUR FTS dialect). */
  engineMode?: EngineMode;
  /** Cloud failure policy for this run: "abort" (default, honest) or
   *  "local" (disclosed fallback — audit row + UI badge, never silent). */
  cloudFallback?: "abort" | "local";
  /** Party names to redact from CLOUD payloads (ADR-004 §2.4): replaced
   *  with [PARTY n] placeholders before any bytes leave the machine and
   *  rehydrated in the returned draft. Local mode is untouched (the guard
   *  only runs in the cloud transform). The audit records counts only. */
  redactParties?: string[];
}

/**
 * Phase E2 verify-then-revise guards. A repair is accepted only when it
 * verifies at least MIN_REPAIR_GAIN above the original verified-vs-total
 * rate; the [LAW] count may not shrink by more than the tolerance (no
 * gaming the rate by writing less law).
 */
const MIN_REPAIR_GAIN = 0.05;
const REPAIR_MAX_LAW_SHRINK = 0.2;

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
  // Per-run engine mode (ADR-004): the explicit UI choice wins; otherwise
  // the env default stands. Restored in finally so a server process never
  // leaks one run's override into the next.
  setRunMode(opts.engineMode ?? null);
  // Cloud payload protections live for exactly this run (cleared in the
  // finally): redaction + caps apply INSIDE the llm seam, where the routed
  // engine is known — local prompts ride through untouched.
  const guard = createPayloadGuard(opts.redactParties ?? []);
  setCloudPayloadTransform(guard.transform);
  const engines: Array<{ stage: string; engine: EngineId; model: string }> = [];
  try {
    // The running row is created BEFORE any fallible work: a pre-intake
    // throw (openCorpus, model load) must still leave a failed run behind,
    // not an invisible case that 404s in history.
    startRun(appDb, caseId);
    audit(appDb, "engine.mode", { caseId, mode: opts.engineMode ?? "(env)", fallback: opts.cloudFallback ?? "abort" }, caseId);
    throwIfAborted(opts.signal);
    corpus = openCorpus();
    // 1. intake — engine pinned per stage (auto routes via ALEX_AUTO_ROUTE;
    //    default route keeps intake local: it is extraction, 9B handles it).
    const intakeEngine = await useEngine("auto", "intake");
    await useModel(RESIDENT_MODEL);
    throwIfAborted(opts.signal);
    const intake = await intakeAgent(facts);
    const intakeModel = engineQualifiedModel(intakeEngine, RESIDENT_MODEL);
    persistIntake(appDb, caseId, intake, intakeModel);
    engines.push({ stage: "intake", engine: intakeEngine, model: intakeModel });
    audit(appDb, "agent.intake", { caseId, engine: intakeEngine, model: intakeModel }, caseId);
    auditFallback(appDb, caseId, "intake", engines);

    // 2. researcher — stays LOCAL in the default auto route: it writes
    //    queries for OUR FTS dialect (phrase dictionary, AND semantics);
    //    a frontier model's natural-language queries can retrieve WORSE.
    throwIfAborted(opts.signal);
    const researchEngine = await useEngine("auto", "researcher");
    const research = await researcherAgent(intake, corpus);
    persistResearch(appDb, caseId, research);
    const researchModel = engineQualifiedModel(researchEngine, RESIDENT_MODEL);
    engines.push({ stage: "researcher", engine: researchEngine, model: researchModel });
    audit(appDb, "agent.researcher", { caseId, hits: research.hits.length, engine: researchEngine, model: researchModel }, caseId);
    auditFallback(appDb, caseId, "researcher", engines);

    // 3. analyst + adversary pass — the reasoning-heavy stages. Local tier:
    //    swap to 14b (useModel no-ops under the cloud engine).
    throwIfAborted(opts.signal);
    const analystEngine = await useEngine("auto", "analyst");
    await useModel(ANALYST_MODEL);

    const analyst = await analystAgent(intake, research);
    const analystModel = engineQualifiedModel(analystEngine, ANALYST_MODEL);
    persistAnalyst(appDb, caseId, analyst, analystModel);
    engines.push({ stage: "analyst", engine: analystEngine, model: analystModel });
    audit(appDb, "agent.analyst", { caseId, engine: analystEngine, model: analystModel }, caseId);
    auditFallback(appDb, caseId, "analyst", engines);

    throwIfAborted(opts.signal);
    const adversaryEngine = await useEngine("auto", "adversary");
    await useModel(ANALYST_MODEL);
    const adversary = await adversaryAgent(intake, research, analyst, corpus);
    const adversaryModel = engineQualifiedModel(adversaryEngine, ANALYST_MODEL);
    persistAdversary(appDb, caseId, adversary, adversaryModel);
    engines.push({ stage: "adversary", engine: adversaryEngine, model: adversaryModel });
    audit(appDb, "agent.adversary", { caseId, engine: adversaryEngine, model: adversaryModel }, caseId);
    auditFallback(appDb, caseId, "adversary", engines);

    // 4. verifier gate over the combined tagged sentences (async — does not block loop)
    // §5.3 gate coverage (2026-09-20 audit): the analyst's IRAC fields and
    // the adversary's counter-argument are model prose too. They used to be
    // rendered as ungated body text in the UI and the exported DOCX — the
    // one artifact a lawyer files was the one place verification was not
    // stamped. They are split into sentences, tagged [INFERRED] (they are
    // reasoning, not record), and verified with the same gate: INFERRED
    // quotes ARE quote-checked, so an invented quote in an IRAC rule now
    // fails visibly, struck through, everywhere the prose appears.
    const iracSentences: TaggedSentence[] = IRAC_FIELDS.map((field) =>
      iracSentence(field, analyst.irac[field])
    );
    const adversarySentences: TaggedSentence[] = [
      counterArgumentSentence(adversary.counter_argument),
    ];
    const combined: TaggedSentence[] = [
      ...analyst.tagged_sentences,
      ...iracSentences,
      ...adversary.tagged_sentences,
      ...adversarySentences,
    ];
    // RECORD confinement runs here for the audit count AND inside the
    // verify fns (idempotent second pass) so the gate holds for all
    // callers, not just this orchestrator. `let` because the E2 repair
    // pass may replace sentences and re-confine.
    const intakeFacts = [...intake.facts, ...intake.claims].join(" ");
    const confinedInit = confineRecordSentences(combined, intakeFacts);
    let confined: TaggedSentence[] = confinedInit.sentences;
    const retagged = confinedInit.retagged;
    // Phase E2: verify-then-revise — the ONE bounded repair pass behind
    // the fail-closed gate. The drafter sees its own struck sentences + the
    // retrieval evidence and must repair, weaken, or drop each one.
    // Accepted only when the guards hold; the gate never gets weaker for
    // trying (a failed repair leaves the original draft standing).
    const draft0 = process.env.ALEX_VERIFY_SYNC === "1"
      ? verifyTaggedSentences(corpus, confined, intakeFacts)
      : await verifyTaggedSentencesAsync(corpus, confined, intakeFacts);
    let draft = draft0;

    const repairEvidence: RepairEvidence[] = research.hits.map((h) => ({
      case_name: h.case_name,
      ...(h.cites && h.cites.length > 0 ? { canonical_cites: h.cites } : {}),
      passages: h.passages.map((p) => p.text),
    }));
    const before = {
      law: draft0.sentences.filter((s) => s.tag === "LAW").length,
      verified: draft0.sentences.filter((s) => s.verified).length,
      total: draft0.sentences.length,
    };
    // Pin the repair stage on the engine seam BEFORE the call (auto mode
    // routes on the active stage) and swap to 14b only when there is
    // something to repair — an idle swap costs the VRAM budget for nothing.
    const hasStruck =
      before.verified < before.total && repairEvidence.length > 0;
    if (hasStruck) {
      const repairEngine = await useEngine("auto", "repair");
      await useModel(ANALYST_MODEL);
      let repair: Awaited<ReturnType<typeof repairStruckSentences>>;
      try {
        repair = await repairStruckSentences(draft0, repairEvidence, intake);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw err;
        // Repair is never critical (§11): any failure — including a
        // malformed model answer — leaves the verified original standing.
        audit(appDb, "verifier.repair", { caseId, flagged: before.total - before.verified, skipped: `repair failed: ${(err as Error)?.message ?? String(err)}` }, caseId);
        repair = null;
      }
      if (repair) {
        throwIfAborted(opts.signal);
        const repairedList = applyRepairs(confined, repair);
        const { sentences: repairedConfined } = confineRecordSentences(repairedList, intakeFacts);
        const redraft = process.env.ALEX_VERIFY_SYNC === "1"
          ? verifyTaggedSentences(corpus, repairedConfined, intakeFacts)
          : await verifyTaggedSentencesAsync(corpus, repairedConfined, intakeFacts);
        const after = {
          law: redraft.sentences.filter((s) => s.tag === "LAW").length,
          verified: redraft.sentences.filter((s) => s.verified).length,
          total: redraft.sentences.length,
        };
        const originalRate = before.total > 0 ? before.verified / before.total : 0;
        const repairedRate = after.total > 0 ? after.verified / after.total : 0;
        const lawShrink = before.law > 0 ? (before.law - after.law) / before.law : 0;
        const accepted =
          repairedRate >= originalRate + MIN_REPAIR_GAIN &&
          lawShrink <= REPAIR_MAX_LAW_SHRINK;
        audit(appDb, "verifier.repair", {
          caseId,
          flagged: before.total - before.verified,
          repaired: repair.repaired_count,
          dropped: repair.replacements.length - repair.repaired_count,
          verified_before: before.verified,
          verified_after: after.verified,
          total_before: before.total,
          total_after: after.total,
          law_before: before.law,
          law_after: after.law,
          accepted,
        }, caseId);
        if (accepted) {
          confined = repairedConfined;
          draft = redraft;
        }
        const repairModel = engineQualifiedModel(repairEngine, ANALYST_MODEL);
        engines.push({ stage: "repair", engine: repairEngine, model: repairModel });
        audit(appDb, "agent.repair", { caseId, engine: repairEngine, model: repairModel, accepted }, caseId);
      } else {
        audit(appDb, "verifier.repair", { caseId, flagged: before.total - before.verified, skipped: "repair declined or empty" }, caseId);
      }
    } else {
      audit(appDb, "verifier.repair", { caseId, flagged: before.total - before.verified, skipped: "no struck sentences" }, caseId);
    }

    audit(appDb, "verifier.run", {
      caseId,
      overall: draft.overall,
      sentences: draft.sentences.length,
      verified: draft.sentences.filter((s) => s.verified).length,
      record_retagged: retagged,
    }, caseId);

    // 5. drafter template (pure, no LLM) — banner applied in code per §11
    let drafted = draftDocument(draft, intake, research, analyst, adversary);
    // Rehydrate redacted party names in the USER-FACING document only: the
    // cloud payloads left the machine with placeholders, the draft comes
    // home to the person who owns the names.
    if (opts.redactParties && opts.redactParties.length > 0) {
      drafted = rehydrateParties(drafted, guard.namesInAssignmentOrder());
    }
    // Disclose payload caps + redaction (counts only, never names).
    const disclosures = guard.disclosures();
    if (disclosures.cappedStages.length > 0 || disclosures.redactedPartyCount > 0) {
      audit(appDb, "cloud.payload_guard", { caseId, ...disclosures }, caseId);
    }
    // keep the JSON for audit; the UI renders `draft` + `drafted` together
    appDb
      .prepare(`UPDATE runs SET draft_json = ? WHERE case_id = ? AND status = 'running'`)
      .run(JSON.stringify(drafted), caseId);
    const renderAuditRow = audit(appDb, "drafter.render", { caseId, banner: drafted.banner, overall: drafted.verification.overall }, caseId);
    // Verification certificate (Phase A): digest over the draft, engine
    // provenance, anchored to the drafter.render audit row (append-only ⇒
    // tamper-evident). Attached AFTER the audit row exists so the anchor
    // is real; the certificate rides in the persisted draft_json.
    drafted.certificate = buildVerificationCertificate(drafted, {
      caseId,
      runId: null, // the run row is finalized next; the route backfills run_id
      auditRowId: renderAuditRow,
      engines,
      generatedAt: drafted.generated_at,
    });
    appDb
      .prepare(`UPDATE runs SET draft_json = ? WHERE case_id = ? AND status = 'running'`)
      .run(JSON.stringify(drafted), caseId);

    // 6. swap back to 9b so subsequent runs start on the resident model
    await useModel(RESIDENT_MODEL);

    const runId = finalizeRun(appDb, caseId, "succeeded", performance.now() - t0);
    // Backfill the real run id into the certificate (it was built before
    // finalization) so the persisted artifact is self-describing.
    if (drafted.certificate) drafted.certificate.run_id = runId;
    appDb
      .prepare(
        `UPDATE runs SET draft_json = ? WHERE id = ? AND status = 'succeeded'`
      )
      .run(JSON.stringify(drafted), runId);
    return {
      run_id: runId,
      case_id: caseId,
      intake,
      research,
      analyst,
      adversary,
      draft,
      drafted,
      engines,
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
      // Engine state is per-run: clear the mode override, drop any cloud
      // pin, and unregister the payload transform so a server process
      // never leaks one run's routing or redaction map into the next.
      setRunMode(null);
      resetEngineToLocal();
      setCloudPayloadTransform(null);
      release();
    }
  }
}


/** Disclose a cloud→local fallback for a stage (fail-loud, §5: never a
 *  silent degradation). A no-op when no fallback happened this stage. */
function auditFallback(
  appDb: Database.Database,
  caseId: number,
  stage: string,
  engines: Array<{ stage: string; engine: EngineId; model: string }>
): void {
  const fb = consumeFallbackEvent();
  if (fb) {
    audit(appDb, "engine.fallback", { caseId, ...fb, disclosed: true }, caseId);
    // Provenance honesty: the engines list records what ACTUALLY produced
    // the stage. A pinned cloud stage that fell back to local is a local
    // stage in the UI badge — silently local would be a lie.
    const last = engines.at(-1);
    if (last && last.stage === stage && last.engine === "cloud") {
      last.engine = "local";
      last.model = `local (cloud fallback: ${fb.error.slice(0, 60)})`;
    }
  }
}

/**
 * Rehydrate redacted party placeholders in the draft document: cloud saw
 * [PARTY n], the user gets their names back. The name→placeholder mapping
 * is the guard's own assignment order (occurrence order in the payloads),
 * so [PARTY n] always resolves to the exact party it replaced. Applied to
 * the user-facing doc AFTER verification: the verifier judged exactly what
 * the model wrote (placeholders), and the digest covers the REHYDRATED
 * document — the honest chain from what was checked to what the user holds.
 */
function rehydrateParties(
  drafted: ReturnType<typeof draftDocument>,
  namesInAssignmentOrder: string[]
): ReturnType<typeof draftDocument> {
  const byIndex = new Map<number, string>();
  namesInAssignmentOrder.forEach((n, i) => byIndex.set(i + 1, n));
  const phRe = /\[PARTY (\d+)\]/g;
  const swap = (s: string): string =>
    s.replace(phRe, (_m, d: string) => byIndex.get(Number(d)) ?? `[PARTY ${d}]`);
  return {
    ...drafted,
    title: swap(drafted.title),
    caption: swap(drafted.caption),
    irac_verified: Object.fromEntries(
      Object.entries(drafted.irac_verified ?? {}).map(([k, v]) => [
        k,
        v ? { ...v, text: swap(v.text) } : v,
      ])
    ) as typeof drafted.irac_verified,
    irac: Object.fromEntries(
      Object.entries(drafted.irac).map(([k, v]) => [k, swap(v)])
    ) as typeof drafted.irac,
    element_checklist: drafted.element_checklist.map((e) => ({
      ...e,
      element: swap(e.element),
      basis: swap(e.basis),
    })) as typeof drafted.element_checklist,
    sentences: drafted.sentences.map((s) => ({ ...s, text: swap(s.text) })),
    adversary: {
      ...drafted.adversary,
      counter_argument_verified: drafted.adversary.counter_argument_verified
        ? { ...drafted.adversary.counter_argument_verified, text: swap(drafted.adversary.counter_argument_verified.text) }
        : undefined,
      counter_argument: swap(drafted.adversary.counter_argument),
    },
  };
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
  intake: IntakeOutput,
  model: string
): void {
  // startRun() already ran before any fallible work (see runCase); this
  // only persists the intake payload onto the running row. The model
  // column records the engine-qualified identity (ADR-004 provenance).
  appDb
    .prepare(
      `INSERT INTO messages (case_id, role, content, model) VALUES (?, 'assistant', ?, ?)`
    )
    .run(caseId, JSON.stringify(intake), model);
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
  analyst: AnalystOutput,
  model: string
): void {
  appDb
    .prepare(
      `INSERT INTO messages (case_id, role, content, model) VALUES (?, 'assistant', ?, ?)`
    )
    .run(caseId, JSON.stringify(analyst), model);
  appDb
    .prepare(
      `UPDATE runs SET analyst_json = ? WHERE case_id = ? AND status = 'running'`
    )
    .run(JSON.stringify(analyst), caseId);
}

function persistAdversary(
  appDb: Database.Database,
  caseId: number,
  adversary: AdversaryOutput,
  model: string
): void {
  appDb
    .prepare(
      `INSERT INTO messages (case_id, role, content, model) VALUES (?, 'assistant', ?, ?)`
    )
    .run(caseId, JSON.stringify(adversary), model);
  appDb
    .prepare(
      `UPDATE runs SET adversary_json = ? WHERE case_id = ? AND status = 'running'`
    )
    .run(JSON.stringify(adversary), caseId);
}
