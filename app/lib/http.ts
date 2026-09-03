/**
 * Shared HTTP error mapping for the read routes (Phase 3).
 *
 * Raw throws (SqliteError bodies, trigger ABORT strings, FTS syntax
 * errors) must never reach the client as HTML 500s or leak driver text —
 * the full error goes to the server log, the client gets a JSON code:
 *   503 + busy hint   — SQLITE_BUSY (retryable contention)
 *   503 + ETL hint    — missing/corrupt corpus (actionable)
 *   500 generic       — everything else (no internals)
 */
import { NextResponse } from "next/server";

export function toJsonError(route: string, e: unknown): NextResponse {
  const msg = String((e as Error)?.message ?? e);
  console.error(`[${route}] failed:`, msg.slice(0, 500));
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    return NextResponse.json(
      { error: "database busy — retry the request" },
      { status: 503 }
    );
  }
  if (
    /unable to open database file|SQLITE_CANTOPEN|no such table|SQLITE_CORRUPT/i.test(
      msg
    )
  ) {
    return NextResponse.json(
      {
        error:
          "corpus database unavailable — run the ETL to build data/corpus.sqlite (docs/data-pipeline.md)",
      },
      { status: 503 }
    );
  }
  return NextResponse.json({ error: "request failed" }, { status: 500 });
}
