import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { openApp } from "../../../lib/app_db";
import { runCase } from "../../../lib/agents/run";

export const runtime = "nodejs";
export const maxDuration = 600; // 10 min — the pipeline is model-bound

/** 16 KB of facts ≈ 4k tokens — the intake prompt leaves ample room under
 *  the 32k window with the retrieval payload riding behind it. Larger
 *  pastes are a UI accident (or abuse) and burn minutes of model time. */
const MAX_FACTS_CHARS = 16_000;

export async function POST(req: Request) {
  let body: { facts?: unknown };
  try {
    body = await req.json();
  } catch {
    return new NextResponse("invalid JSON body", { status: 400 });
  }
  if (typeof body.facts !== "string" || !body.facts.trim()) {
    return new NextResponse(
      "facts is required and must be a non-empty string",
      { status: 400 }
    );
  }
  const facts = body.facts.trim();
  if (facts.length > MAX_FACTS_CHARS) {
    return new NextResponse(
      `facts exceeds the ${MAX_FACTS_CHARS}-character limit`,
      { status: 413 }
    );
  }

  let app;
  try {
    app = openApp();
  } catch (e) {
    console.error("[api/run] app database unavailable:", e);
    return new NextResponse(
      "app database unavailable — start the app once to create data/app.sqlite, or run the ETL (docs/data-pipeline.md)",
      { status: 503 }
    );
  }

  try {
    const title = facts.length > 80 ? facts.slice(0, 77) + "..." : facts;
    const caseId = Number(
      app
        .prepare(`INSERT INTO cases (slug, title, facts) VALUES (?, ?, ?)`)
        .run(`web-${randomUUID()}`, title, facts).lastInsertRowid
    );
    const out = await runCase(app, caseId, facts);
    const auditRows = app
      .prepare(
        `SELECT ts, kind, payload FROM audit_log WHERE case_id = ? ORDER BY id DESC LIMIT 12`
      )
      .all(caseId) as Array<{ ts: string; kind: string; payload: string }>;
    return NextResponse.json({
      case_id: caseId,
      run_id: out.run_id,
      intake: out.intake,
      research: {
        queries: out.research.queries,
        top_picks: out.research.top_picks.map((t) => ({
          q: t.q,
          hit: t.hit
            ? {
                case_name: t.hit.case_name,
                court_id: t.hit.court_id,
                scores: t.hit.scores,
                treatment_flags: t.hit.treatment_flags,
                passages: t.hit.passages,
              }
            : null,
        })),
        hits: out.research.hits.map((h) => ({
          case_name: h.case_name,
          case_name_short: h.case_name_short,
          court_id: h.court_id,
          date_filed: h.date_filed,
          precedential_status: h.precedential_status,
          scores: h.scores,
          treatment_flags: h.treatment_flags,
          cited_by_recent: h.cited_by_recent,
          passages: h.passages,
          via_parenthetical_recall: h.via_parenthetical_recall ?? false,
        })),
      },
      irac: out.analyst.irac,
      element_checklist: out.analyst.element_checklist,
      adversary: {
        counter_argument: out.adversary.counter_argument,
        treatment_caveats: out.adversary.treatment_caveats,
        counter_authority: out.adversary.counter_authority.map((h) => ({
          case_name: h.case_name,
          court_id: h.court_id,
          passages: h.passages,
        })),
      },
      draft: {
        overall: out.draft.overall,
        sentences: out.draft.sentences,
        report: out.draft.report,
      },
      drafted: out.drafted,
      audit: auditRows,
      ms: out.ms,
    });
  } catch (e) {
    console.error("[api/run] pipeline failed:", e);
    const msg = String((e as Error)?.message ?? e);
    // Infrastructure failures get remediation hints and 503; details stay
    // in the server log instead of a leaked SqliteError body.
    if (/unable to open database file|SQLITE_CANTOPEN|no such table/i.test(msg)) {
      return new NextResponse(
        "corpus database unavailable — run the ETL to build data/corpus.sqlite (docs/data-pipeline.md)",
        { status: 503 }
      );
    }
    if (/fetch failed|ECONNREFUSED|ollama/i.test(msg)) {
      return new NextResponse(
        "Ollama unreachable — start the daemon and pull the models (ollama pull qwen3.5:9b qwen3:14b)",
        { status: 503 }
      );
    }
    return new NextResponse(`pipeline failed: ${msg.slice(0, 300)}`, {
      status: 500,
    });
  } finally {
    app.close();
  }
}
