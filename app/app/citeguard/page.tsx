/**
 * CiteGuard (Phase A) — verify ANY AI-written draft against the corpus.
 *
 * The strategic point: every other AI legal tool's output becomes a
 * demonstration of the moat. Firms don't switch research tools; they DO
 * check their work. The verifier is model-agnostic — it reads citations
 * and quotes, not engines — so the same gate that strikes Alex's own
 * failures grades ChatGPT/Harvey/CoCounsel output.
 *
 * Client-side: one fetch, no persistence (the server stores nothing), and
 * honest framing — a failed resolution means "not in the local corpus",
 * never "does not exist".
 */
"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";

interface CiteGuardCitation {
  citation: string;
  raw: string;
  start: number;
  end: number;
  form: string;
  status: string;
  case_name: string | null;
  inferred_treatment: string[];
  ambiguous_cluster_ids: number[];
}

interface CiteGuardQuote {
  quote: string;
  start: number;
  end: number;
  status: string;
  attributed_citation: string | null;
  true_source: { case_name?: string | null } | null;
}

interface CiteGuardResponse {
  overall: "pass" | "fail";
  summary: Record<string, number>;
  citations: CiteGuardCitation[];
  quotes: CiteGuardQuote[];
  meta: { chars: number; corpus_note: string; stored: false };
}

const STATUS_CHIP: Record<string, string> = {
  verified: "pass",
  unresolved_citation: "fail",
  quote_not_found: "fail",
  quote_wrong_case: "fail",
  out_of_corpus: "info",
  unsupported_form: "info",
  pin_unverified: "info",
};

export default function CiteGuardPage() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<CiteGuardResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await fetch("/api/citeguard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: ac.signal,
      });      const body = await r.text();
        if (!r.ok) {
          // Show the server's message, not its envelope: parse JSON bodies,
          // fall back to the raw text for non-JSON failures.
          let msg = body;
          try { msg = JSON.parse(body).error ?? body; } catch { /* keep raw */ }
          setErr(msg.slice(0, 300));
        return;
      }
      setRes(JSON.parse(body) as CiteGuardResponse);
    } catch (e: unknown) {
      if ((e as Error)?.name === "AbortError") return;
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [text]);

  const verifiedCites = res?.citations.filter((c) => c.status === "verified").length ?? 0;
  const failedCites = res?.citations.filter((c) => c.status === "unresolved_citation").length ?? 0;
  const failedQuotes = res?.quotes.filter((q) => q.status !== "verified" && q.status !== "out_of_corpus").length ?? 0;

  return (
    <main className="ax-citeguard">
      <header className="ax-hero" style={{ textAlign: "left", padding: "40px 0 8px" }}>
        <h1>
          CiteGuard — <em>prove someone else&apos;s sentences</em>
        </h1>
        <p>
          Paste any AI-written legal draft — from ChatGPT, Harvey, CoCounsel,
          or Alex itself. The same verifier that gates Alex&apos;s output checks
          every citation and every quote against the local corpus. Unverified
          content is struck through, never hidden. Nothing you paste is stored.
        </p>
      </header>

      <div className="ax-field">
        <label htmlFor="cg-text">Draft to verify (≤ 64,000 chars ≈ 50 pages)</label>
        <textarea
          id="cg-text"
          className="ax-textarea"
          rows={12}
          value={text}
          maxLength={64_000}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the draft…"
        />
      </div>

      <div className="ax-actions">
        <button
          className="ax-btn ax-btn-primary"
          onClick={run}
          disabled={busy || !text.trim()}
        >
          {busy ? "Verifying…" : "Verify citations & quotes"}
        </button>
        <Link href="/" className="ax-btn ax-btn-ghost">
          ← Back to research
        </Link>
      </div>

      {err && (
        <p className="ax-error" role="alert">
          {err}
        </p>
      )}

      {res && (
        <section aria-label="CiteGuard result">
          <div className="ax-verdict">
            <h2>Verification report</h2>
            <span className={`ax-chip ${res.overall === "pass" ? "pass" : "fail"}`}>
              {res.overall === "pass" ? "✓" : "✗"} {res.overall.toUpperCase()}
            </span>
            <span className="ax-meta">
              {res.citations.length} citations · {res.quotes.length} quotes ·{" "}
              {res.meta.chars.toLocaleString()} chars · not stored
            </span>
          </div>

          <div className="ax-card">
            <h3>Summary</h3>
            <p className="ax-card-sub">
              {verifiedCites} resolved · {failedCites} failed resolution ·{" "}
              {failedQuotes} quote checks failed ·{" "}
              {res.quotes.filter((q) => q.status === "out_of_corpus").length} out-of-corpus
              (annotated, not failed)
            </p>
            <p className="ax-card-sub" style={{ color: "var(--txt-2)" }}>
              {res.meta.corpus_note}
            </p>
          </div>

          <div className="ax-card">
            <h3>Citations</h3>
            {res.citations.length === 0 && <p className="ax-empty">No citations found in the text.</p>}
            <ul className="ax-appendix">
              {res.citations.map((c, i) => (
                <li key={i}>
                  <span aria-hidden="true">{c.status === "verified" ? "✓" : c.status === "out_of_corpus" ? "◇" : "✗"}</span>
                  <code>{c.citation}</code>
                  <span>
                    {c.case_name ?? "—"}
                    <span className={`ax-chip ${STATUS_CHIP[c.status] ?? "fail"}`}>{c.status}</span>
                    {c.ambiguous_cluster_ids.length > 1 && (
                      <span className="ax-chip fail">AMBIGUOUS ({c.ambiguous_cluster_ids.length})</span>
                    )}
                    {c.inferred_treatment.length > 0 && (
                      <span className="ax-chip info">inferred: {c.inferred_treatment.join(", ")}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="ax-card">
            <h3>Quotes</h3>
            {res.quotes.length === 0 && <p className="ax-empty">No quoted spans found in the text.</p>}
            <ul className="ax-appendix">
              {res.quotes.map((q, i) => (
                <li key={i}>
                  <span aria-hidden="true">{q.status === "verified" ? "✓" : "✗"}</span>
                  <span>
                    “{q.quote.length > 120 ? q.quote.slice(0, 117) + "…" : q.quote}”
                    {q.attributed_citation && (
                      <span style={{ color: "var(--txt-3)" }}> → {q.attributed_citation}</span>
                    )}
                    <span className={`ax-chip ${STATUS_CHIP[q.status] ?? "fail"}`}>{q.status}</span>
                    {q.true_source?.case_name && (
                      <span className="ax-chip info">true source: {q.true_source.case_name}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="ax-footnote">
            Verdicts are against the local corpus snapshot (§5.1–5.2). Out-of-corpus
            reporters (WL, Lexis) are annotated, not failed — the corpus cannot carry
            Westlaw numbers by construction. Inferred treatment is never asserted as
            fact (§5.5). Nothing you paste is persisted.
          </p>
        </section>
      )}
    </main>
  );
}
