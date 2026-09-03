import { NextResponse } from "next/server";
import { openApp } from "../../../../lib/app_db";
import { toJsonError } from "../../../../lib/http";

export const runtime = "nodejs";

/** One case, hydrated to the same shape POST /api/run returns, so the UI
 *  renders history and fresh runs through one component. Legacy rows
 *  (research_json holding only queries) degrade gracefully: the research
 *  panel shows the queries and empty hits. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const caseId = Number(id);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    return NextResponse.json({ error: "bad case id" }, { status: 400 });
  }
  let app;
  try {
    app = openApp();
  } catch (e) {
    console.error("[api/cases/:id] app database unavailable:", e);
    return NextResponse.json(
      { error: "app database unavailable" },
      { status: 503 }
    );
  }
  try {
    const run = app
      .prepare(
        `SELECT id, status, intake_json, research_json, analyst_json,
                adversary_json, draft_json, ms
           FROM runs WHERE case_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(caseId) as
      | {
          id: number;
          status: string;
          intake_json: string | null;
          research_json: string | null;
          analyst_json: string | null;
          adversary_json: string | null;
          draft_json: string | null;
          ms: number | null;
        }
      | undefined;
    if (!run) {
      return NextResponse.json({ error: "no runs for case" }, { status: 404 });
    }
    const parse = <T,>(s: string | null, fallback: T): T => {
      if (!s) return fallback;
      try {
        return JSON.parse(s) as T;
      } catch {
        return fallback;
      }
    };
    const intake = parse<Record<string, unknown>>(run.intake_json, {});
    const researchRaw = parse<Record<string, unknown>>(run.research_json, {});
    const analyst = parse<Record<string, unknown>>(run.analyst_json, {});
    const adversary = parse<Record<string, unknown>>(run.adversary_json, {});
    const drafted = parse<{
      irac?: unknown;
      banner?: string;
      title?: string;
      caption?: string;
      sentences?: Array<Record<string, unknown>>;
      authority_appendix?: Array<Record<string, unknown>>;
      verification?: { overall?: string; summary?: Record<string, number> };
      generated_at?: string;
      element_checklist?: Array<Record<string, unknown>>;
      adversary?: Record<string, unknown>;
    }>(run.draft_json, {});

    // research_json became the full object after G4; older rows hold only
    // the queries array.
    const researchFull = researchRaw as {
      queries?: Array<{ q: string; why: string }>;
      top_picks?: Array<{ q: string; hit: unknown | null }>;
      hits?: Array<Record<string, unknown>>;
    };
    const queries = Array.isArray(researchFull.queries)
      ? researchFull.queries
      : [];

    const auditRows = app
      .prepare(
        `SELECT ts, kind, payload FROM audit_log WHERE case_id = ? ORDER BY id ASC LIMIT 40`
      )
      .all(caseId) as Array<{ ts: string; kind: string; payload: string }>;

    return NextResponse.json({
      case_id: caseId,
      run_id: run.id,
      status: run.status,
      intake,
      research: {
        queries,
        top_picks: Array.isArray(researchFull.top_picks)
          ? researchFull.top_picks
          : [],
        hits: Array.isArray(researchFull.hits) ? researchFull.hits : [],
      },
      irac: analyst.irac ?? drafted.irac ?? {},
      element_checklist:
        analyst.element_checklist ?? drafted.element_checklist ?? [],
      adversary:
        (adversary.counter_argument != null
          ? adversary
          : drafted.adversary) ?? {},
      draft: {
        overall: drafted.verification?.overall ?? "fail",
        sentences: drafted.sentences ?? [],
        // The full G2 report is not persisted; the summary is (and the UI
        // renders the summary, not the raw report).
        report: {
          citations: [],
          quotes: [],
          summary: drafted.verification?.summary ?? {},
        },
      },
      drafted,
      audit: auditRows,
      ms: run.ms ?? 0,
    });
  } catch (e) {
    return toJsonError("api/cases/[id]", e);
  } finally {
    app.close();
  }
}
