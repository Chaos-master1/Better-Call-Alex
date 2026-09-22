/**
 * Phase A A/B harness (ADR-004 §2.9) — the same five G3 fact patterns run
 * under BOTH engines against the same corpus and the same verifier gate.
 *
 * This is a decision instrument, not a demo:
 *   - objective metrics only (verification rates, pin-cite density,
 *     latency). NO LLM judge — a model grading models is circular.
 *   - per-pattern side-by-side records go to logs/g3-ab-report.json for
 *     HUMAN review (the operator reads both drafts and judges quality).
 *   - the report doubles as ADR-004 evidence, auto-route evidence, and
 *     the methodology seed for the Phase B public benchmark.
 *
 * Requirements: data/corpus.sqlite, Ollama with both local models, and a
 * configured cloud key (ALEX_CLOUD_* in .env). Skips cleanly (exit 0) when
 * prerequisites are missing so CI without credentials stays green.
 *
 *   pnpm exec tsx evals/run_g3_ab.ts
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openApp } from "../app/lib/app_db.js";
import { runCase } from "../app/lib/agents/run.js";
import { parseEngineMode } from "../app/lib/env.js";
import { cloudAvailable } from "../app/lib/llm.js";
import { loadRepoEnv } from "../app/lib/env.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATTERNS = path.join(REPO, "evals", "g3-five-patterns.json");
const OUT_DIR = path.join(REPO, "logs");
const OUT = path.join(OUT_DIR, "g3-ab-report.json");

const TIME_BUDGET_MS = 600_000;

interface Pattern {
  id: string;
  label: string;
  jurisdiction: string | null;
  facts: string;
  expect: { adversary_nonempty: boolean; element_checklist_nonempty: boolean };
}

interface RunMetrics {
  engine_mode: string;
  ms: number;
  sentences: number;
  verified: number;
  unverified: number;
  law_sentences: number;
  law_with_resolving_pin: number;
  citation_resolution_rate: number | null;
  element_checklist_size: number;
  adversary_counter_authority: number;
  overall: string;
  engines: Array<{ stage: string; engine: string; model: string }>;
  draft_text: string;
}

async function runAndMeasure(
  app: ReturnType<typeof openApp>,
  pattern: Pattern,
  engineMode: "local" | "cloud"
): Promise<RunMetrics> {
  const facts = pattern.jurisdiction
    ? `[Jurisdiction: ${pattern.jurisdiction}] ${pattern.facts}`
    : pattern.facts;
  let caseId = Number(
    app
      .prepare(`INSERT INTO cases (slug, title, facts) VALUES (?, ?, ?)`)
      .run(`g3ab-${pattern.id}-${engineMode}-${Date.now()}`, `${pattern.label} [${engineMode}]`.slice(0, 80), facts)
      .lastInsertRowid
  );
  const t0 = performance.now();
  let out;
  while (true) {
    try {
      out = await runCase(app, caseId, facts, { engineMode });
      break;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const transient = /fetch failed|ECONNREFUSED|timeout/i.test(msg);
      if (transient) {
        console.log(`  transient (${msg.slice(0, 100)}) — retrying once with a fresh case row`);
        caseId = Number(
          app
            .prepare(`INSERT INTO cases (slug, title, facts) VALUES (?, ?, ?)`)
            .run(`g3ab-${pattern.id}-${engineMode}-retry-${Date.now()}`, `${pattern.label} [${engineMode}]`.slice(0, 80), facts)
            .lastInsertRowid
        );
        continue;
      }
      throw e;
    }
  }
  const ms = Math.round(performance.now() - t0);
  const lawSentences = out.draft.sentences.filter((s) => s.tag === "LAW");
  // What matters is LAW sentences carrying CHECKED authority — via the pin
  // field or inline prose (the render gate enforces exactly this). A field
  // count alone would report 0 for a draft whose inline cites all resolved.
  const lawWithAuthority = lawSentences.filter(
    (s) => s.pin_cite || s.verified
  );
  const cites = out.draft.report.citations;
  const resolved = cites.filter((c) => c.status === "verified").length;
  const appended = out.drafted.sentences.length
    ? out.drafted.sentences.map((s) => `[${s.tag}] ${s.text}`).join("\n")
    : out.draft.sentences.map((s) => `[${s.tag}] ${s.text}`).join("\n");
  return {
    engine_mode: engineMode,
    ms,
    sentences: out.draft.sentences.length,
    verified: out.draft.sentences.filter((s) => s.verified).length,
    unverified: out.draft.sentences.filter((s) => !s.verified).length,
    law_sentences: lawSentences.length,
    law_with_resolving_pin: lawWithAuthority.length,
    citation_resolution_rate: cites.length ? resolved / cites.length : null,
    element_checklist_size: out.analyst.element_checklist.length,
    adversary_counter_authority: out.adversary.counter_authority.length,
    overall: out.draft.overall,
    engines: out.engines,
    draft_text: appended,
  };
}

async function main() {
  loadRepoEnv();
  // Measurement runs land in a scratch DB unless the caller explicitly
  // overrides ALEX_APP_DB — evidence harnesses must not pollute production
  // history (learned the hard way: probe runs required a trigger-gated
  // cleanup of app.sqlite to undo).
  if (!process.env.ALEX_APP_DB) {
    const scratch = path.join(REPO, "data", "app-ab-scratch.sqlite");
    rmSync(scratch, { force: true });
    process.env.ALEX_APP_DB = scratch;
  }
  const hasCloud = cloudAvailable();
  if (!hasCloud) {
    console.log(
      "A/B harness: no cloud key configured (ALEX_CLOUD_* in .env) — nothing to compare. Skipping (exit 0)."
    );
    return;
  }
  const spec = JSON.parse(readFileSync(PATTERNS, "utf-8")) as { patterns: Pattern[] };
  // --only <id>[,<id>…] runs an honest subset: the report records which
  // patterns ran, so partial evidence is labeled partial, never mistaken
  // for the full set.
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1]?.split(",").map((s) => s.trim()) : undefined;
  const selected = only ? spec.patterns.filter((p) => only.includes(p.id)) : spec.patterns;
  if (selected.length === 0) {
    console.error(`A/B harness: --only matched no pattern (known: ${spec.patterns.map((p) => p.id).join(", ")})`);
    process.exit(1);
  }
  const app = openApp();
  const report: any[] = [];
  let hardFail = false;

  try {
    for (const p of selected) {
      console.log(`\n— ${p.id} ${p.label} —`);
      const entry: any = { id: p.id, label: p.label };
      for (const mode of ["local", "cloud"] as const) {
        if (mode === "cloud" && !hasCloud) continue;
        try {
          const m = await runAndMeasure(app, p, mode);
          entry[mode] = m;
          const rate =
            m.citation_resolution_rate == null
              ? "n/a"
              : `${(m.citation_resolution_rate * 100).toFixed(0)}%`;
          console.log(
            `  [${mode.padEnd(5)}] ${m.overall.toUpperCase()} · ${m.verified}/${m.sentences} verified · ` +
              `LAW ${m.law_with_resolving_pin}/${m.law_sentences} pinned · resolve ${rate} · ` +
              `${(m.ms / 1000).toFixed(1)}s · ${m.engines.map((e) => `${e.stage}:${e.engine}`).join(",")}`
          );
        } catch (e: any) {
          entry[mode] = { error: String(e?.message ?? e).slice(0, 300) };
          console.error(`  [${mode}] FAILED: ${String(e?.message ?? e).slice(0, 200)}`);
          // A cloud-stage hard failure is a finding, not a harness crash:
          // record and continue (abort policy means the run refuses).
        }
      }
      report.push(entry);
    }

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          env_mode: parseEngineMode(process.env.ALEX_ENGINE),
          scope: only ? `partial: patterns ${selected.map((p) => p.id).join(", ")} (--only)` : "full: all five patterns",
          note:
            "Objective metrics only; no LLM judge (circularity). Side-by-side drafts are for human review. A/B per ADR-004 §2.9.",
          patterns: report,
        },
        null,
        2
      )
    );
    console.log(`\nreport written: ${OUT}`);

    // Gate: both engines must produce VERIFIER-GATED output on every
    // pattern that ran. A run whose sentences are untagged/ungated would
    // break §5.3 — but runCase throws on that upstream, so here we only
    // assert the harness ran at least one comparable pair.
    const comparable = report.filter((r) => r.local && r.cloud && !r.local.error && !r.cloud.error);
    if (comparable.length === 0) {
      console.error("A/B harness: no pattern completed under both engines.");
      hardFail = true;
    } else {
      console.log(
        `A/B harness: ${comparable.length}/${report.length} pattern(s) comparable. Read the drafts side by side — the metrics inform, you judge.`
      );
    }
  } finally {
    app.close();
  }
  if (hardFail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
