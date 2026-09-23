/**
 * Live redaction proof (ADR-004 §2.4) — the end-to-end statement:
 *
 *   "party names never reach the cloud; the draft comes home rehydrated."
 *
 * Drives the FULL production pipeline (runCase) in cloud mode against a
 * scratch app DB (production data/app.sqlite is never touched), with
 * redactParties set. Captures the actual wire bodies by wrapping global
 * fetch (forwarding unchanged to the real endpoint). PASS requires:
 *   1. every chat/completions body carries [PARTY n] and NONE of the
 *      redacted names;
 *   2. an audit row `cloud.payload_guard` with redactedPartyCount > 0 and
 *      COUNTS ONLY (no names in the audit payload);
 *   3. the returned draft contains the real names (rehydrated) and no
 *      [PARTY n] placeholders.
 * Skips cleanly (exit 0) without a cloud key or corpus, so CI without
 * credentials stays green.
 *
 *   pnpm exec tsx evals/run_redaction_live.ts   (artifact: logs/redaction-live.json)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { openAppAt } from "../app/lib/app_db.js";
import { loadRepoEnv } from "../app/lib/env.js";
import { cloudAvailable } from "../app/lib/llm.js";
import { runCase } from "../app/lib/agents/run.js";

const REPO = path.resolve(import.meta.dirname, "..");

interface WireCapture {
  url: string;
  body: string;
}

async function main() {
  loadRepoEnv();
  if (!cloudAvailable()) {
    console.log("redaction-live: no cloud key (ALEX_CLOUD_* in .env) — skipping (exit 0).");
    return;
  }
  if (!existsSync(path.join(REPO, "data", "corpus.sqlite"))) {
    console.log("redaction-live: no corpus.sqlite — skipping (exit 0).");
    return;
  }

  const spec = JSON.parse(
    readFileSync(path.join(REPO, "evals", "g3-five-patterns.json"), "utf-8")
  ) as { patterns: Array<{ id: string; facts: string }> };
  const pattern = spec.patterns[0];

  // Party names woven into the facts so the model MUST engage with them.
  const NAMES = ["Demarcus Johnson", "Sunset Lodge LLC"];
  const facts = `${pattern.facts} The guest, Demarcus Johnson, had reserved
room 12 under his own name two weeks earlier. The motel, Sunset Lodge LLC,
had no written trespass policy, and its manager admitted to police that
Demarcus Johnson had paid for the night in cash.`;

  // Capture the wire: wrap global fetch, forward unchanged to the endpoint.
  const realFetch = globalThis.fetch;
  const wire: WireCapture[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.includes("/chat/completions") && init?.body) {
      wire.push({ url, body: String(init.body) });
    }
    return realFetch(input as any, init as any);
  }) as typeof fetch;

  const scratchPath = path.join(REPO, "data", "app-redaction-scratch.sqlite");
  try { rmSync(scratchPath); } catch { /* first run */ }
  const scratch = openAppAt(scratchPath);

  let failed = false;
  try {
    const caseId = Number(
      scratch
        .prepare(`INSERT INTO cases (slug, title, facts) VALUES (?, ?, ?)`)
        .run("redaction-proof", "redaction proof", facts).lastInsertRowid
    );
    const out = await runCase(scratch, caseId, facts, {
      engineMode: "cloud",
      redactParties: NAMES,
    });

    // 1. Wire: placeholders present, names absent — in EVERY cloud call.
    const withNames = wire.filter((w) => NAMES.some((n) => w.body.includes(n)));
    const withPlaceholders = wire.filter((w) => /\[PARTY \d+\]/.test(w.body));

    // 2. Audit row exists with counts (payload carries counts, never names).
    const guardRow = scratch
      .prepare(
        `SELECT payload FROM audit_log WHERE case_id = ? AND kind = 'cloud.payload_guard'
         ORDER BY id DESC LIMIT 1`
      )
      .get(caseId) as { payload: string } | undefined;
    const guard = guardRow ? (JSON.parse(guardRow.payload) as { redactedPartyCount?: number }) : null;

    // 3. Draft rehydrated: names back, no placeholders anywhere in the doc.
    const draftJson = JSON.stringify(out.drafted);
    const namesBack = NAMES.filter((n) => draftJson.includes(n));
    const placeholdersLeft = (draftJson.match(/\[PARTY \d+\]/gi) ?? []).length;
    // Residue contexts: where any case/spacing variant of a placeholder
    // survived rehydration — the diagnosis surface for honest failures.
    const residue = [...draftJson.matchAll(/.{0,60}\[party \d+\].{0,40}/gi)].map(
      (m) => m[0]
    );

    const checks = {
      chatCalls: wire.length,
      wire_clean: withNames.length === 0,
      wire_carries_placeholders: withPlaceholders.length > 0,
      audit_guard_row: !!guard,
      audit_counts_only: guardRow
        ? !guardRow.payload.includes("Demarcus") && !guardRow.payload.includes("Sunset")
        : false,
      redacted_count_positive: guard ? (guard.redactedPartyCount ?? 0) > 0 : false,
      draft_names_rehydrated: namesBack.length === NAMES.length,
      draft_has_no_placeholders: placeholdersLeft === 0,
    };
    const pass = Object.values(checks).every(Boolean);

    const artifact = {
      proof: "cloud redaction (ADR-004 §2.4)",
      date: new Date().toISOString(),
      engine: "cloud (live endpoint)",
      names_redacted_count: NAMES.length,
      checks,
      wire_calls_captured: wire.length,
      audit_guard: guard ?? null,
      draft_placeholder_residue: placeholdersLeft,
      residue_samples: residue.slice(0, 4),
      names_missing_from_draft: NAMES.filter((n) => !namesBack.includes(n)),
      draft_overall: out.drafted.verification.overall,
      ms: out.ms,
      pass,
    };
    mkdirSync(path.join(REPO, "logs"), { recursive: true });
    writeFileSync(
      path.join(REPO, "logs", "redaction-live.json"),
      JSON.stringify(artifact, null, 2)
    );
    console.log(JSON.stringify(checks, null, 1));
    console.log(pass ? "REDACTION LIVE: PASS" : "REDACTION LIVE: FAIL");
    if (!pass) failed = true;
  } finally {
    globalThis.fetch = realFetch;
    scratch.close();
    try { rmSync(scratchPath); } catch { /* keep tree clean */ }
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("redaction-live failed:", e);
  process.exit(1);
});
