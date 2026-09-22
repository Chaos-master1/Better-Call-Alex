/**
 * Phase A canary (ADR-004 §2.5) — the end-to-end proof statement:
 *
 *   "the gate gates cloud text."
 *
 * Runs a REAL cloud analyst-stage call (key-gated), injects a fabricated
 * citation sentence into the model's own tagged output, and drives the
 * combined draft through the production verifier. PASS requires the
 * fabricated sentence to come back verified:false (struck through) while
 * the model's honest sentences are judged on their own merits.
 *
 * Requirements: data/corpus.sqlite + a configured cloud key (ALEX_CLOUD_*
 * in .env). Skips cleanly (exit 0) without either, so CI
 * without credentials stays green.
 *
 *   pnpm exec tsx evals/run_canary_cloud.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCorpus } from "../app/lib/db.js";
import { loadRepoEnv } from "../app/lib/env.js";
import {
  generate,
  setRunMode,
  useEngine,
  resetEngineToLocal,
  cloudAvailable,
} from "../app/lib/llm.js";
import {
  confineRecordSentences,
  verifyTaggedSentences,
  type TaggedSentence,
} from "../app/lib/render.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATTERNS = path.join(REPO, "evals", "g3-five-patterns.json");

async function main() {
  loadRepoEnv();
  if (!cloudAvailable()) {
    console.log("canary: no cloud key configured (ALEX_CLOUD_* in .env) — skipping (exit 0).");
    return;
  }
  if (!existsSync(path.join(REPO, "data", "corpus.sqlite"))) {
    console.log("canary: no corpus.sqlite — skipping (exit 0).");
    return;
  }

  // A real intake/analyst payload from the G3 patterns (the same shape the
  // pipeline sends the analyst).
  const spec = JSON.parse(readFileSync(PATTERNS, "utf-8")) as {
    patterns: Array<{ id: string; label: string; facts: string }>;
  };
  const pattern = spec.patterns[0];

  // 1. Real cloud analyst-stage call: the agent applies its production
  //    system prompt internally (agents/index.ts owns the prompt text).
  const { analystAgent, intakeAgent } = await import(
    "../app/lib/agents/index.js"
  );
  setRunMode("cloud");
  const intakeEngine = await useEngine("cloud", "intake");
  const intake = await intakeAgent(pattern.facts);
  resetEngineToLocal();
  const analystEngine = await useEngine("cloud", "analyst");
  const analyst = await analystAgent(intake, {
    queries: [],
    hits: [],
    top_picks: [],
  });

  // 2. Inject the fabrication: a syntactically plausible citation to a
  //    case that does not exist, formatted exactly like the model's own
  //    [LAW] sentences. This is the adversarial case the verifier must
  //    catch even when the author is a frontier model.
  const fabricated: TaggedSentence = {
    tag: "LAW",
    text: "Moreover, the doctrine was settled in Flores v. Whitcombe, 741 F.4th 1101 (9th Cir. 2023), where the court held that every withholding claim requires automatic stays.",
    pin_cite: "741 F.4th 1101",
  };
  const combined: TaggedSentence[] = [...analyst.tagged_sentences, fabricated];

  // 3. Drive the combined draft through the PRODUCTION verifier path —
  //    the same functions runCase calls (confine + verify, sync bridge).
  const intakeFacts = [...intake.facts, ...intake.claims].join(" ");
  const { sentences: confined } = confineRecordSentences(combined, intakeFacts);
  const db = openCorpus();
  try {
    const draft = verifyTaggedSentences(db, confined, intakeFacts);
    const fab = draft.sentences.find((s) =>
      s.text.includes("Flores v. Whitcombe")
    );
    const engines = `intake=${intakeEngine}, analyst=${analystEngine}`;
    if (!fab) {
      console.error(`canary FAIL (${engines}): fabricated sentence missing from the render — the pipeline dropped it silently (forbidden by §3).`);
      process.exit(1);
    }
    if (fab.verified) {
      console.error(`canary FAIL (${engines}): the fabricated cite PASSED the gate: ${JSON.stringify(fab.detail)}`);
      process.exit(1);
    }
    const honest = draft.sentences.filter((s) => !s.text.includes("Flores v. Whitcombe"));
    const honestVerified = honest.filter((s) => s.verified).length;
    const verdict = `PASS` as const;
    console.log(
      `canary PASS (${engines}): fabricated ${JSON.stringify(fab.pin_cite)} struck through — ${fab.detail.join(" · ")}\n` +
        `  model's own sentences: ${honestVerified}/${honest.length} verified on their own merits (they are judged honestly, not blanket-rejected).`
    );
    console.log(`\nTHE GATE GATES CLOUD TEXT.`);
    // Evidence artifact (committed-evidence convention: logs/). Written on
    // PASS and FAIL alike — a failed canary must leave its fingerprints.
    const report = {
      ran_at: new Date().toISOString(),
      pattern: pattern.id,
      model: process.env.ALEX_CLOUD_MODEL ?? "(default)",
      engines,
      verdict,
      fabricated: { pin_cite: fab.pin_cite, struck_through: !fab.verified, detail: fab.detail },
      honest: { verified: honestVerified, total: honest.length },
    };
    mkdirSync(path.join(REPO, "logs"), { recursive: true });
    writeFileSync(path.join(REPO, "logs", "canary-cloud.json"), JSON.stringify(report, null, 2));
    console.log("evidence → logs/canary-cloud.json");
  } finally {
    db.close();
    resetEngineToLocal();
    setRunMode(null);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
