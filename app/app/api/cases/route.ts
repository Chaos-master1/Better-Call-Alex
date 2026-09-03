import { NextResponse } from "next/server";
import { openApp } from "../../../lib/app_db";

export const runtime = "nodejs";

/** Case list for the history sidebar: newest first, with the latest run's
 *  status and verification overall. */
export async function GET() {
  let app;
  try {
    app = openApp();
  } catch (e) {
    console.error("[api/cases] app database unavailable:", e);
    return NextResponse.json(
      { error: "app database unavailable" },
      { status: 503 }
    );
  }
  try {
    const rows = app
      .prepare(
        `SELECT c.id, c.title, c.created_at,
                (SELECT r.status FROM runs r WHERE r.case_id = c.id
                  ORDER BY r.id DESC LIMIT 1) AS latest_status,
                (SELECT r.id FROM runs r WHERE r.case_id = c.id
                  ORDER BY r.id DESC LIMIT 1) AS latest_run_id,
                (SELECT r.ms FROM runs r WHERE r.case_id = c.id
                  ORDER BY r.id DESC LIMIT 1) AS latest_ms,
                (SELECT r.draft_json FROM runs r WHERE r.case_id = c.id
                  ORDER BY r.id DESC LIMIT 1) AS draft_json
           FROM cases c
          ORDER BY c.id DESC
          LIMIT 100`
      )
      .all() as Array<{
      id: number;
      title: string;
      created_at: string;
      latest_status: string | null;
      latest_run_id: number | null;
      latest_ms: number | null;
      draft_json: string | null;
    }>;
    const cases = rows.map((r) => {
      let overall: string | null = null;
      if (r.draft_json) {
        try {
          overall =
            (JSON.parse(r.draft_json) as { verification?: { overall?: string } })
              .verification?.overall ?? null;
        } catch {
          overall = null;
        }
      }
      return {
        id: r.id,
        title: r.title,
        created_at: r.created_at,
        status: r.latest_status,
        run_id: r.latest_run_id,
        ms: r.latest_ms,
        overall,
      };
    });
    return NextResponse.json({ cases });
  } finally {
    app.close();
  }
}
