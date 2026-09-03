import { NextResponse } from "next/server";
import type Database from "better-sqlite3";
import { audit, openApp } from "../../../../../lib/app_db";
import { openCorpus } from "../../../../../lib/db";
import { toJsonError } from "../../../../../lib/http";
import type { DraftDoc } from "../../../../../lib/draft";
import {
  buildMotionDocx,
  exportFilename,
  planMotionParagraphs,
} from "../../../../../lib/export_docx";
import {
  collectExportCandidates,
  resolvesCitation,
} from "../../../../../lib/resolve_cite";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * G5 motion export: GET /api/cases/[id]/export → .docx download.
 *
 * The G5 gate ("every citation in the exported file resolves") is enforced
 * HERE in code, not observed after the fact: appendix citations, sentence
 * pin cites, AND inline cites mined from the IRAC/counter-argument/caveat
 * free text are all re-resolved against the corpus before any bytes are
 * built. Anything unresolvable fails closed with 409 naming the offenders
 * — the file is never emitted with a bad cite inside it.
 * Unverified sentences that carry NO resolvable citation form (e.g. a bare
 * "§ 1983" short form, LAW-without-pin) are still exported struck-through
 * per §3 — the gate covers citations, the strike covers the rest.
 */
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
    console.error("[api/cases/:id/export] app database unavailable:", e);
    return NextResponse.json(
      { error: "app database unavailable" },
      { status: 503 }
    );
  }

  try {
    const row = app
      .prepare(
        `SELECT c.title,
                (SELECT r.draft_json FROM runs r WHERE r.case_id = c.id
                  ORDER BY r.id DESC LIMIT 1) AS draft_json
           FROM cases c WHERE c.id = ?`
      )
      .get(caseId) as
      | { title: string; draft_json: string | null }
      | undefined;
    if (!row?.draft_json) {
      return NextResponse.json(
        { error: "no drafted run for case" },
        { status: 404 }
      );
    }
    let drafted: DraftDoc;
    try {
      drafted = JSON.parse(row.draft_json) as DraftDoc;
    } catch {
      return NextResponse.json(
        { error: "stored draft is corrupt" },
        { status: 500 }
      );
    }

    // ——— resolve gate: every exported citation must resolve ———
    // Candidates cover the whole file (appendix + pins + IRAC/counter
    // inline cites) via the shared resolve_cite module — the same code
    // evals/run_g5.ts runs, so the gate cannot drift between the two.
    let corpus: Database.Database;
    try {
      corpus = openCorpus();
    } catch {
      return NextResponse.json(
        {
          error:
            "corpus database unavailable — run the ETL to build data/corpus.sqlite (docs/data-pipeline.md)",
        },
        { status: 503 }
      );
    }
    try {
      const candidates = collectExportCandidates(drafted);
      const unresolvable = candidates.filter((c) => !resolvesCitation(corpus, c));
      if (unresolvable.length > 0) {
        return NextResponse.json(
          {
            error: "export refused: citations do not resolve in the corpus",
            unresolvable,
          },
          { status: 409 }
        );
      }
    } finally {
      corpus.close();
    }

    // ——— build + persist + stream ———
    // documents + audit write atomically: a crash between them must never
    // leave a motion file with no drafter.export audit row (§5.6).
    const buf = await buildMotionDocx(drafted);
    const filename = exportFilename(caseId, row.title);
    const body = planMotionParagraphs(drafted)
      .map((b) =>
        b.kind === "sentence"
          ? `[${b.tag}] ${b.text}${b.pin_cite ? ` (${b.pin_cite})` : ""}${b.verified ? "" : " [UNVERIFIED]"}`
          : b.text
      )
      .join("\n\n");
    const persist = app.transaction(() => {
      app
        .prepare(
          `INSERT INTO documents (case_id, kind, title, body) VALUES (?, 'motion', ?, ?)`
        )
        .run(caseId, filename, body);
      audit(
        app,
        "drafter.export",
        { caseId, filename, bytes: buf.length },
        caseId
      );
    });
    persist();

    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buf.length),
      },
    });
  } catch (e) {
    return toJsonError("api/cases/[id]/export", e);
  } finally {
    app.close();
  }
}
