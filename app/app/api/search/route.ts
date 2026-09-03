import { NextResponse } from "next/server";
import { openCorpus } from "../../../lib/db";
import { toJsonError } from "../../../lib/http";
import { search } from "../../../lib/retrieval/search";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? "";
  // Present-but-empty (?jurisdiction=) means "no filter", not "match
  // nothing": an empty set would 200 with [] — indistinguishable from a
  // real no-results answer.
  const jurisdiction = searchParams.get("jurisdiction")?.trim() || undefined;
  // Clamp: `?limit=abc` must not become NaN (which would disable every
  // early-exit in search() and return the whole candidate pool).
  const limit = Math.min(
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "10", 10) || 10),
    50
  );
  if (!q.trim()) {
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }
  let db;
  try {
    db = openCorpus();
  } catch (e) {
    console.error("[api/search] corpus unavailable:", e);
    return NextResponse.json(
      { error: "corpus database unavailable — run the ETL (docs/data-pipeline.md)" },
      { status: 503 }
    );
  }
  try {
    const t0 = performance.now();
    const hits = search(db, q, { jurisdiction, limit });
    const ms = Math.round(performance.now() - t0);
    return NextResponse.json({ query: q, elapsed_ms: ms, hits });
  } catch (e) {
    return toJsonError("api/search", e);
  } finally {
    db.close();
  }
}
