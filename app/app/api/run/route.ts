import { NextResponse } from "next/server";
import { openApp } from "../../../lib/app_db";
import { runCase } from "../../../lib/agents/run";

export const runtime = "nodejs";
export const maxDuration = 600; // 10 min — the pipeline is model-bound

export async function POST(req: Request) {
  let body: { facts?: string };
  try {
    body = await req.json();
  } catch {
    return new NextResponse("invalid JSON body", { status: 400 });
  }
  const facts = (body.facts ?? "").trim();
  if (!facts) {
    return new NextResponse("facts is required", { status: 400 });
  }
  const app = openApp();
  try {
    const title = facts.length > 80 ? facts.slice(0, 77) + "..." : facts;
    const caseId = Number(
      app
        .prepare(`INSERT INTO cases (slug, title, facts) VALUES (?, ?, ?)`)
        .run(`web-${Date.now()}`, title, facts).lastInsertRowid
    );
    const out = await runCase(app, caseId, facts);
    const auditRows = app
      .prepare(`SELECT ts, kind, payload FROM audit_log ORDER BY id DESC LIMIT 12`)
      .all() as Array<{ ts: string; kind: string; payload: string }>;
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
  } catch (e: any) {
    return new NextResponse(
      `pipeline failed: ${e?.message ?? e}`.slice(0, 1000),
      { status: 500 }
    );
  } finally {
    app.close();
  }
}
