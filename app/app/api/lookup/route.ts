import { NextResponse } from "next/server";
import { openCorpus, resolveCluster } from "../../../lib/db";
import { parseCitation } from "../../../lib/citation";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cite = searchParams.get("cite") ?? "";
  const parsed = parseCitation(cite);
  if (!parsed) {
    return NextResponse.json({ error: "could not parse citation" }, { status: 400 });
  }
  let db;
  try {
    db = openCorpus();
  } catch (e) {
    console.error("[api/lookup] corpus unavailable:", e);
    return NextResponse.json(
      { error: "corpus database unavailable — run the ETL (docs/data-pipeline.md)" },
      { status: 503 }
    );
  }
  try {
    const result = resolveCluster(db, parsed.volume, parsed.reporter, parsed.page);
    if (!result) {
      return NextResponse.json(
        { error: `NO AUTHORITY FOUND IN CORPUS for "${cite}"` },
        { status: 404 }
      );
    }
    return NextResponse.json(result);
  } finally {
    db.close();
  }
}
