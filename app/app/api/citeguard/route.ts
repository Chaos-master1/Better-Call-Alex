/**
 * CiteGuard (Phase A — "genius move 1").
 *
 * POST /api/citeguard { text, tag? } → the G2 verifier's report over ANY
 * pasted text — including drafts written by other AI tools (ChatGPT,
 * Harvey, CoCounsel, Gemini). The verifier is model-agnostic by
 * construction: it reads citations and quotes, not engines, so the same
 * 100%-catch gate that guards Alex's own output grades everyone else's.
 *
 * Every competitor's output becomes a demonstration of the moat: firms do
 * not switch research tools, but they DO check their work — and the check
 * runs on our architecture.
 *
 * Honesty rules (inherited from §5 / docs/verifier.md):
 *   - Unresolved citations FAIL. WL/Lexis-style out-of-corpus reporters
 *     annotate `out_of_corpus` (the corpus cannot carry Westlaw numbers by
 *     construction — probe01 measured the resolution ceiling at 89.4%);
 *     everything else that fails to resolve still fails.
 *   - Unmatched quotes FAIL with best-effort true-source identification.
 *   - The corpus is a June 2026 snapshot: "fails resolution" means "not in
 *     the local corpus", never "does not exist". The response says so.
 *   - No text is persisted: nothing about the pasted draft touches the
 *     database (a firm's counterparty work product stays in RAM).
 *   - Size cap: 64,000 chars — the same bound the CourtListener citation
 *     API uses (~50 pages of text).
 */
import { NextResponse } from "next/server";
import { openCorpus } from "../../../lib/db";
import { verifyTextAsync } from "../../../lib/verify/verify_async";

export const runtime = "nodejs";
export const maxDuration = 120; // bridge spawn + bounded true-source probes

const MAX_TEXT_CHARS = 64_000;

export async function POST(req: Request) {
  let body: { text?: unknown; tag?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json(
      { error: "text is required and must be a non-empty string" },
      { status: 400 }
    );
  }
  const text = body.text;
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json(
      { error: `text exceeds the ${MAX_TEXT_CHARS}-character limit`, code: 413 },
      { status: 413 }
    );
  }

  let corpus;
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
    const report = await verifyTextAsync(corpus, text);
    const citations = report.citations.map((c) => ({
      citation: c.corrected || c.citation_text,
      raw: c.citation_text,
      start: c.cite_start,
      end: c.cite_end,
      form: c.form,
      status: c.status,
      case_name: c.case_name ?? null,
      inferred_treatment: c.inferred_treatment ?? [],
      ambiguous_cluster_ids: c.ambiguous_cluster_ids ?? [],
    }));
    const quotes = report.quotes.map((q) => ({
      quote: q.quote,
      start: q.start,
      end: q.end,
      status: q.status,
      attributed_citation:
        q.attributed_to_citation_index != null
          ? report.citations[q.attributed_to_citation_index]?.corrected ??
            report.citations[q.attributed_to_citation_index]?.citation_text ??
            null
          : null,
      true_source: q.true_source ? { case_name: q.true_source.case_name } : null,
    }));
    return NextResponse.json({
      overall: report.overall,
      summary: report.summary,
      citations,
      quotes,
      meta: {
        chars: text.length,
        corpus_note:
          "Verdicts are against the local corpus snapshot. A citation that fails resolution is not found in the corpus — the system never claims it does not exist.",
        stored: false,
      },
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.error("[api/citeguard] verification failed:", e);
    return NextResponse.json(
      { error: `verification failed: ${msg.slice(0, 300)}` },
      { status: 500 }
    );
  } finally {
    corpus.close();
  }
}
