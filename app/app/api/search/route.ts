import { NextResponse } from "next/server";
import { openCorpus } from "../../../lib/db";
import { search } from "../../../lib/retrieval/search";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? "";
  const jurisdiction = searchParams.get("jurisdiction") ?? undefined;
  const limit = Number(searchParams.get("limit") ?? "10");
  if (!q.trim()) {
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }
  const db = openCorpus();
  try {
    const t0 = performance.now();
    const hits = search(db, q, { jurisdiction, limit });
    const ms = Math.round(performance.now() - t0);
    return NextResponse.json({ query: q, elapsed_ms: ms, hits });
  } finally {
    db.close();
  }
}
