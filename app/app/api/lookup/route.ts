import { NextResponse } from "next/server";
import { openCorpus, resolveCluster } from "../../../lib/db";
import { parseCitation } from "../../../lib/citation";
import {
  parseStatuteCites,
  resolveStatute,
  statuteTableExists,
  toStatuteLookup,
} from "../../../lib/statute";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cite = searchParams.get("cite") ?? "";
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
    const parsed = parseCitation(cite);
    if (parsed) {
      const result = resolveCluster(db, parsed.volume, parsed.reporter, parsed.page);
      if (result) return NextResponse.json(result);
    }
    // G4: statutory cites resolve against the statutes table when loaded.
    if (statuteTableExists(db)) {
      for (const s of parseStatuteCites(cite)) {
        const row = resolveStatute(db, s.source, s.title, s.section);
        if (row) return NextResponse.json(toStatuteLookup(row));
      }
    }
    return NextResponse.json(
      { error: `NO AUTHORITY FOUND IN CORPUS for "${cite}"` },
      { status: 404 }
    );
  } finally {
    db.close();
  }
}
