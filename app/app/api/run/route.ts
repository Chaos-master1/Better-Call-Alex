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
    const caseId = Number(
      app
        .prepare(`INSERT INTO cases (slug, title, facts) VALUES (?, ?, ?)`)
        .run(`web-${Date.now()}`, "Web run", facts).lastInsertRowid
    );
    const out = await runCase(app, caseId, facts);
    return NextResponse.json({
      case_id: caseId,
      intake: out.intake,
      irac: out.analyst.irac,
      element_checklist: out.analyst.element_checklist,
      adversary: {
        counter_argument: out.adversary.counter_argument,
        treatment_caveats: out.adversary.treatment_caveats,
      },
      draft: {
        overall: out.draft.overall,
        sentences: out.draft.sentences,
      },
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
