/**
 * G3 demo UI — thin client around POST /api/run.
 * Every sentence is gated by the G2 Verifier; unverified is struck-through,
 * never dropped (§3, §11). Banner is code-applied (draft.ts).
 */
"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

interface VerifiedSentence {
  index: number;
  tag: "RECORD" | "LAW" | "INFERRED";
  text: string;
  pin_cite?: string;
  verified: boolean;
  detail: string[];
  inferred: boolean;
}

interface HitCard {
  case_name: string | null;
  case_name_short?: string | null;
  court_id: string | null;
  date_filed?: string | null;
  precedential_status?: string | null;
  scores: { bm25: number; authority_multiplier: number; final: number; parenthetical_hits: number };
  treatment_flags: number;
  cited_by_recent?: number;
  passages: Array<{ text: string; start: number; end: number }>;
  via_parenthetical_recall?: boolean;
}

interface RunResponse {
  case_id: number;
  run_id: number;
  intake: any;
  research: {
    queries: Array<{ q: string; why: string }>;
    top_picks: Array<{ q: string; hit: HitCard | null }>;
    hits: HitCard[];
  };
  irac: { issue: string; rule: string; application: string; conclusion: string };
  element_checklist: Array<{ element: string; status: string; basis: string }>;
  adversary: { counter_argument: string; treatment_caveats: string[]; counter_authority: HitCard[] };
  draft: { overall: "pass" | "fail"; sentences: VerifiedSentence[]; report: any };
  drafted: {
    banner: string;
    title: string;
    caption: string;
    authority_appendix: Array<{ citation: string; case_name: string | null; verified: boolean; inferred_treatment: string[] }>;
    verification: { overall: string; summary: Record<string, number> };
    generated_at: string;
  };
  audit: Array<{ ts: string; kind: string; payload: string }>;
  ms: number;
}

const SAMPLE = `A 67-year-old Black man checked into a motel in Atlanta. The motel
manager called police and reported him as a 'suspicious person' after seeing
him in the lobby. Officers arrived, asked him to leave, and when he refused,
arrested him for trespass. He was held for 9 hours and released without
charges. He sues the motel under 42 U.S.C. § 1983.`;

const TREATMENT_BITS: Array<{ bit: number; label: string }> = [
  { bit: 1, label: "overruled" },
  { bit: 2, label: "abrogated" },
  { bit: 4, label: "distinguished" },
  { bit: 8, label: "but_see" },
  { bit: 16, label: "declined_to_follow" },
];

function treatmentLabels(flags: number): string[] {
  if (!flags) return [];
  return TREATMENT_BITS.filter((t) => flags & t.bit).map((t) => t.label);
}

interface CaseSummary {
  id: number;
  title: string;
  created_at: string;
  status: string | null;
  run_id: number | null;
  ms: number | null;
  overall: string | null;
}

export default function Home() {
  const [facts, setFacts] = useState(SAMPLE);
  const [out, setOut] = useState<RunResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Monotone generation: every run submit and every history open bumps it;
  // a response that arrives for an older generation is dropped. This is
  // what makes "last click wins" true regardless of finish order.
  const genRef = useRef(0);

  const loadCases = useCallback(async () => {
    try {
      const r = await fetch("/api/cases");
      if (!r.ok) return;
      const j = (await r.json()) as { cases: CaseSummary[] };
      setCases(j.cases ?? []);
      setHistoryError(null);
    } catch {
      setHistoryError("history unavailable");
    }
  }, []);

  useEffect(() => {
    loadCases();
  }, [loadCases]);

  const run = () => {
    setErr(null);
    setOut(null);
    // One flight at a time: a new submit aborts the previous request so a
    // stale run can never clobber a fresh one (the server queue still
    // serializes model work). The generation counter below extends the same
    // protection to history loads racing a run.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const gen = ++genRef.current;
    startTransition(async () => {
      try {
        const r = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ facts }),
          signal: ac.signal,
        });
        if (gen !== genRef.current) return; // superseded — drop stale result
        if (!r.ok) {
          const t = await r.text();
          setErr(`${r.status} ${r.statusText}: ${t.slice(0, 600)}`);
          return;
        }
        const j = (await r.json()) as RunResponse;
        setOut(j);
        loadCases();
      } catch (e: any) {
        if (e?.name === "AbortError") return; // cancelled by a newer submit
        if (gen !== genRef.current) return;
        setErr(String(e?.message ?? e));
      }
    });
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const openCase = (id: number) => {
    setErr(null);
    // History loads are cheap reads: they must work while a model run is in
    // flight (no `pending` gate) and must never clobber a newer selection —
    // last click wins via the generation counter, not last finish.
    const gen = ++genRef.current;
    startTransition(async () => {
      try {
        const r = await fetch(`/api/cases/${id}`);
        if (gen !== genRef.current) return;
        if (!r.ok) {
          const t = await r.text();
          setErr(`${r.status}: ${t.slice(0, 300)}`);
          return;
        }
        setOut((await r.json()) as RunResponse);
      } catch (e: any) {
        if (gen !== genRef.current) return;
        setErr(String(e?.message ?? e));
      }
    });
  };

  return (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-start", maxWidth: 1160, margin: "0 auto", padding: "24px 16px" }}>
      <aside style={{ width: 230, flexShrink: 0, position: "sticky", top: 24 }}>
        <h2 style={{ fontSize: 11, color: "#8a8a8a", textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 8px" }}>Case history</h2>
        {historyError && <p style={{ fontSize: 11, color: "#737373" }}>{historyError}</p>}
        {!historyError && cases.length === 0 && (
          <p style={{ fontSize: 11, color: "#737373" }}>No cases yet — run the pipeline.</p>
        )}
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {cases.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => openCase(c.id)}
                aria-label={`Open case ${c.id}: ${c.title}`}
                title={c.title}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: out?.case_id === c.id ? "#1f2937" : "#111",
                  border: "1px solid #262626",
                  borderRadius: 6,
                  padding: "8px 10px",
                  cursor: "pointer",
                  color: "#d4d4d4",
                }}
              >
                <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.title}
                </div>
                <div style={{ fontSize: 10, color: "#737373", marginTop: 2, display: "flex", gap: 6, alignItems: "center" }}>
                  <span>{c.created_at?.slice(0, 16)}</span>
                  {c.status && <span>· {c.status}</span>}
                  {c.overall && (
                    <span style={{ color: c.overall === "pass" ? "#4ade80" : "#fca5a5" }}>{c.overall === "pass" ? "✓" : "✗"}</span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main style={{ flex: 1, minWidth: 0 }}>
      <h1 style={{ fontSize: 26, marginBottom: 4, letterSpacing: -0.5 }}>Better Call Alex</h1>
      <p style={{ color: "#a3a3a3", marginTop: 0, fontSize: 13 }}>US case-law research. Local. Verifiable. Every claim is gated.</p>
      <div style={{ background: "#3a1f1f", color: "#fca5a5", padding: "8px 12px", borderRadius: 4, marginBottom: 12, fontSize: 13, border: "1px solid #7f1d1d" }}>
        DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE
        <span style={{ color: "#a3a3a3", marginLeft: 8, fontSize: 11 }}>applied in code, not by prompt (§11)</span>
      </div>
      <textarea
        value={facts}
        onChange={(e) => setFacts(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !pending && facts.trim()) {
            e.preventDefault();
            run();
          }
        }}
        rows={6}
        placeholder="Free-text fact pattern…"
        aria-label="Fact pattern"
        maxLength={16000}
        style={{
          width: "100%",
          background: "#171717",
          color: "#e5e5e5",
          border: "1px solid #404040",
          padding: 12,
          borderRadius: 6,
          fontFamily: "inherit",
          fontSize: 13,
          lineHeight: 1.5,
          boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={run}
          disabled={pending || !facts.trim()}
          style={{
            padding: "9px 18px",
            background: pending ? "#404040" : "#1d4ed8",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: pending ? "wait" : "pointer",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {pending ? "Running pipeline (up to a few minutes)…" : "Run pipeline"}
        </button>
        {pending && (
          <button
            onClick={cancel}
            style={{
              padding: "9px 14px",
              background: "#3f1010",
              color: "#fca5a5",
              border: "1px solid #7f1d1d",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
        )}
        <span style={{ fontSize: 11, color: "#8a8a8a" }}>
          qwen3.5:9b → qwen3:14b (batched, ≤2 swaps) → verifier gate · Ctrl/⌘+Enter to run
        </span>
      </div>
      {err && (
        <pre role="alert" style={{ marginTop: 16, padding: 12, background: "#1f1010", color: "#fca5a5", border: "1px solid #7f1d1d", borderRadius: 6, fontSize: 12, overflow: "auto", whiteSpace: "pre-wrap" }}>{err}</pre>
      )}
      {pending && !out && (
        <p aria-live="polite" style={{ color: "#8a8a8a", fontSize: 12, marginTop: 12 }}>
          Intake → researcher (BM25×authority) → analyst → adversary… runs can take several minutes on cold model loads.
        </p>
      )}
      {out && <Result out={out} />}
      </main>
    </div>
  );
}

function draftToText(out: RunResponse): string {
  const lines: string[] = [];
  lines.push(out.drafted.banner);
  lines.push("");
  lines.push(out.drafted.title);
  lines.push(out.drafted.caption);
  lines.push("");
  lines.push("— IRAC —");
  for (const [k, v] of Object.entries(out.irac ?? {})) {
    lines.push(`${k.toUpperCase()}: ${String(v)}`);
  }
  lines.push("");
  lines.push("— DRAFT (sentences) —");
  for (const s of out.draft.sentences) {
    const cite = s.pin_cite ? ` (${s.pin_cite})` : "";
    const mark = s.verified ? "" : " [UNVERIFIED]";
    lines.push(`[${s.tag}] ${s.text}${cite}${mark}`);
  }
  lines.push("");
  lines.push("— COUNTER-ARGUMENT —");
  lines.push(String(out.adversary?.counter_argument ?? ""));
  lines.push("");
  lines.push("— AUTHORITY APPENDIX —");
  for (const a of out.drafted.authority_appendix ?? []) {
    const treat = a.inferred_treatment?.length
      ? ` [inferred: ${a.inferred_treatment.join(", ")}]`
      : "";
    lines.push(`- ${a.citation} (${a.case_name ?? "—"})${a.verified ? "" : " UNVERIFIED"}${treat}`);
  }
  lines.push("");
  lines.push(
    `verification: ${out.draft.overall} · ${JSON.stringify(out.drafted.verification.summary)}`
  );
  return lines.join("\n");
}

function CopyDraftButton({ out }: { out: RunResponse }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(draftToText(out));
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
      style={{
        padding: "3px 10px",
        background: "#171717",
        color: "#d4d4d4",
        border: "1px solid #404040",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 11,
      }}
    >
      {copied ? "Copied ✓" : "Copy draft"}
    </button>
  );
}

function ExportDocxButton({ caseId }: { caseId: number }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setRefused(null);
          try {
            const r = await fetch(`/api/cases/${caseId}/export`);
            if (!r.ok) {
              let detail = await r.text();
              try {
                const j = JSON.parse(detail) as { error?: string; unresolvable?: string[] };
                detail = j.unresolvable?.length
                  ? `${j.error}: ${j.unresolvable.join("; ")}`
                  : (j.error ?? detail);
              } catch { /* keep raw text */ }
              setRefused(`${r.status}: ${detail.slice(0, 200)}`);
              return;
            }
            // Honor the server's slugged filename (it sanitizes the free-text
            // title); fall back to the bare id form.
            const disp = r.headers.get("content-disposition") ?? "";
            const m = disp.match(/filename="([^"]+)"/);
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = m?.[1] ?? `alex-case-${caseId}.docx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          } catch (e: any) {
            // Network failure (server down mid-click): previously silent.
            setRefused(`export failed: ${String(e?.message ?? e).slice(0, 160)}`);
          } finally {
            setBusy(false);
          }
        }}
        style={{
          padding: "3px 10px",
          background: "#052e16",
          color: "#4ade80",
          border: "1px solid #14532d",
          borderRadius: 6,
          cursor: busy ? "wait" : "pointer",
          fontSize: 11,
        }}
      >
        {busy ? "Exporting…" : "Export .docx"}
      </button>
      {refused && <span style={{ fontSize: 11, color: "#fca5a5" }}>{refused}</span>}
    </span>
  );
}

function Result({ out }: { out: RunResponse }) {
  const verified = out.draft.sentences.filter((s) => s.verified).length;
  const total = out.draft.sentences.length;
  return (
    <section style={{ marginTop: 24 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <h2 style={{ fontSize: 13, color: "#a3a3a3", margin: 0, textTransform: "uppercase", letterSpacing: 0.5 }}>Result</h2>
        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 999, background: out.draft.overall === "pass" ? "#052e16" : "#3f1010", color: out.draft.overall === "pass" ? "#4ade80" : "#fca5a5", border: `1px solid ${out.draft.overall === "pass" ? "#14532d" : "#7f1d1d"}` }}>
          {out.draft.overall.toUpperCase()} · {verified}/{total} verified · {(out.ms / 1000).toFixed(1)}s · run {out.run_id}
        </span>
        <CopyDraftButton out={out} />
        <ExportDocxButton caseId={out.case_id} />
        <span style={{ fontSize: 11, color: "#737373" }}>{out.drafted.generated_at}</span>
      </div>

      {/* Drafted header */}
      <div style={{ background: "#171717", border: "1px solid #262626", borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: "#737373", textTransform: "uppercase" }}>{out.drafted.banner}</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#e5e5e5", marginTop: 4 }}>{out.drafted.title}</div>
        <div style={{ fontSize: 13, color: "#a3a3a3" }}>{out.drafted.caption}</div>
        <div style={{ fontSize: 11, color: "#737373", marginTop: 6 }}>verification: {JSON.stringify(out.drafted.verification.summary)} · overall {out.drafted.verification.overall}</div>
      </div>

      {/* Intake */}
      <details style={{ background: "#111", border: "1px solid #262626", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, color: "#a3a3a3" }}>Intake (structured, unknowns = UNVERIFIED)</summary>
        <pre style={{ fontSize: 11, color: "#d4d4d4", overflow: "auto", marginTop: 8, whiteSpace: "pre-wrap" }}>{JSON.stringify(out.intake, null, 2)}</pre>
      </details>

      {/* Research */}
      <h3 style={{ fontSize: 14, color: "#e5e5e5", marginTop: 18 }}>Research</h3>
      <div style={{ fontSize: 12, color: "#a3a3a3", marginBottom: 8 }}>
        Queries (researcher, 3 frames) → <code>search BM25 × authority × parentheticals</code> — passages carry char offsets for pin cites.
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
        {out.research.queries.map((q, i) => (
          <li key={i} style={{ background: "#171717", border: "1px solid #262626", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>
            <span style={{ color: "#7dd3fc" }}>Q{i + 1}:</span> <span style={{ color: "#e5e5e5" }}>{q.q}</span> <span style={{ color: "#737373" }}>— {q.why}</span>
            {out.research.top_picks[i]?.hit && (
              <div style={{ color: "#a3a3a3", marginTop: 4, fontSize: 11 }}>
                top: <em>{out.research.top_picks[i]!.hit!.case_name}</em> <span style={{ color: "#737373" }}>({out.research.top_picks[i]!.hit!.court_id} · BM25 {out.research.top_picks[i]!.hit!.scores.bm25.toFixed(1)} · ×{out.research.top_picks[i]!.hit!.scores.authority_multiplier.toFixed(2)} · paren {out.research.top_picks[i]!.hit!.scores.parenthetical_hits})</span>
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Authority cards */}
      <h4 style={{ fontSize: 13, color: "#a3a3a3", marginTop: 14 }}>Authority (top hits, 1 per cluster, §3 step 4 re-score)</h4>
      <div style={{ display: "grid", gap: 8 }}>
        {out.research.hits.slice(0, 10).map((h, i) => (
          <div key={i} style={{ background: "#171717", border: "1px solid #262626", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 13, color: "#e5e5e5", fontWeight: 600 }}>
              {h.case_name ?? "(unnamed)"} <span style={{ color: "#737373", fontWeight: 400, fontSize: 11 }}>· {h.court_id} · {h.date_filed} · {h.precedential_status}</span>
              {h.via_parenthetical_recall && <span style={{ marginLeft: 6, fontSize: 10, background: "#1e3a5f", color: "#7dd3fc", padding: "2px 6px", borderRadius: 999 }}>via parenthetical recall</span>}
              {h.scores.parenthetical_hits > 0 && <span style={{ marginLeft: 6, fontSize: 10, color: "#a3a3a3" }}>paren {h.scores.parenthetical_hits}</span>}
            </div>
            <div style={{ fontSize: 11, color: "#737373", marginTop: 2 }}>
              BM25 {h.scores.bm25.toFixed(1)} · authority ×{h.scores.authority_multiplier.toFixed(2)} · final {h.scores.final.toFixed(1)} · recent cites 2y {h.cited_by_recent} · treatment <span style={{ color: h.treatment_flags ? "#fca5a5" : "#737373" }}>{h.treatment_flags ? treatmentLabels(h.treatment_flags).join(", ") + " (inferred)" : "—"}</span>
            </div>
            {h.passages[0] && (
              <div style={{ fontSize: 12, color: "#d4d4d4", marginTop: 6, background: "#0a0a0a", border: "1px solid #262626", borderRadius: 6, padding: "8px 10px", whiteSpace: "pre-wrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {h.passages[0].text}
                <span style={{ color: "#737373", fontSize: 10, marginLeft: 6 }}>[{h.passages[0].start}—{h.passages[0].end}]</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* IRAC */}
      <h3 style={{ fontSize: 14, color: "#e5e5e5", marginTop: 18 }}>IRAC <span style={{ fontSize: 11, color: "#737373", fontWeight: 400 }}>(analyst output — not sentence-verified; see Draft below)</span></h3>
      <IracBlock label="Issue" text={out.irac.issue} />
      <IracBlock label="Rule" text={out.irac.rule} />
      <IracBlock label="Application" text={out.irac.application} />
      <IracBlock label="Conclusion" text={out.irac.conclusion} />

      {/* Element checklist */}
      <h4 style={{ fontSize: 13, color: "#a3a3a3", marginTop: 14 }}>Element checklist (§3 — element checklist, honest. One “check” ≠ proof.)</h4>
      <div style={{ overflow: "auto" }}>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginTop: 6 }}>
          <thead>
            <tr style={{ color: "#737373", textAlign: "left", borderBottom: "1px solid #262626" }}>
              <th style={{ padding: "6px 8px" }}>Element</th><th style={{ padding: "6px 8px" }}>Status</th><th style={{ padding: "6px 8px" }}>Basis</th>
            </tr>
          </thead>
          <tbody>
            {out.element_checklist.map((r, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #1a1a1a" }}>
                <td style={{ padding: "6px 8px", color: "#e5e5e5" }}>{r.element}</td>
                <td style={{ padding: "6px 8px", color: r.status === "met" ? "#4ade80" : r.status === "unmet" ? "#fca5a5" : "#a3a3a3", fontWeight: 600 }}>{r.status}</td>
                <td style={{ padding: "6px 8px", color: "#a3a3a3" }}>{r.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Adversary */}
      <h3 style={{ fontSize: 14, color: "#e5e5e5", marginTop: 18 }}>Adversary — the best case against you (retrieved, not invented)</h3>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: "#e5e5e5", background: "#171717", border: "1px solid #262626", borderRadius: 8, padding: "10px 12px" }}>{out.adversary.counter_argument}</p>
      {out.adversary.treatment_caveats.length > 0 && (
        <ul style={{ fontSize: 12, color: "#fca5a5", marginTop: 8 }}>
          {out.adversary.treatment_caveats.map((t, i) => (
            <li key={i}><em>inferred:</em> {t}</li>
          ))}
        </ul>
      )}
      {out.adversary.counter_authority.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: "#a3a3a3", marginTop: 8 }}>Counter-authority (retrieved):</div>
          <ul style={{ fontSize: 12, color: "#d4d4d4", marginTop: 4 }}>
            {out.adversary.counter_authority.map((h: any, i: number) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <em>{h.case_name ?? "(unnamed)"}</em> <span style={{ color: "#737373" }}>· {h.court_id}</span>
                {h.passages?.[0]?.text && <div style={{ color: "#a3a3a3", fontSize: 11, marginTop: 2, whiteSpace: "pre-wrap" }}>{h.passages[0].text.slice(0, 260)}</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Draft sentences — the gate */}
      <h3 style={{ fontSize: 14, color: "#e5e5e5", marginTop: 18 }}>Draft sentences — verifier-gated <span style={{ fontSize: 11, color: "#737373", fontWeight: 400 }}>(✗ struck-through = failed verification, ≈ inferred per §5.5)</span></h3>
      <ul style={{ listStyle: "none", padding: 0, fontSize: 13, lineHeight: 1.7 }}>
        {out.draft.sentences.map((s) => (
          <li key={s.index} style={{ marginBottom: 8, background: s.verified ? "transparent" : "#1a1010", border: s.verified ? "none" : "1px solid #3a1f1f", borderRadius: 6, padding: s.verified ? "2px 0" : "8px 10px" }}>
            <span style={{ color: !s.verified ? "#ef4444" : s.inferred ? "#a3a3a3" : "#22c55e", marginRight: 6 }}>{!s.verified ? "✗" : s.inferred ? "≈" : "✓"}</span>
            <span style={{ color: "#7dd3fc", marginRight: 6, fontSize: 11 }}>[{s.tag}]</span>
            <span style={!s.verified ? { textDecoration: "line-through", textDecorationColor: "#ef4444" } : s.inferred ? { color: "#a3a3a3" } : {}}>{s.text}</span>
            {s.pin_cite && <span style={{ color: "#737373", marginLeft: 6, fontSize: 11 }}>({s.pin_cite})</span>}
            {s.detail.length > 0 && (
              <div style={{ color: !s.verified ? "#fca5a5" : "#737373", fontSize: 11, marginTop: 3, marginLeft: 22, whiteSpace: "pre-wrap" }}>{s.detail.join(" · ")}</div>
            )}
          </li>
        ))}
      </ul>

      {/* Authority appendix */}
      <h4 style={{ fontSize: 13, color: "#a3a3a3", marginTop: 14 }}>Authority appendix (drafter template, banner in code)</h4>
      <div style={{ fontSize: 12, color: "#a3a3a3", background: "#171717", border: "1px solid #262626", borderRadius: 8, padding: "10px 12px" }}>
        <div style={{ color: "#737373", fontSize: 11, marginBottom: 6 }}>{out.drafted.banner} · {out.drafted.caption}</div>
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {out.drafted.authority_appendix.map((a, i) => (
            <li key={i} style={{ marginBottom: 4, color: a.verified ? "#e5e5e5" : "#fca5a5" }}>
              <code>{a.citation}</code> — {a.case_name ?? "—"} {a.verified ? "✓" : "✗ unresolved"} {a.inferred_treatment.length > 0 && <span style={{ color: "#fca5a5" }}>· inferred: {a.inferred_treatment.join(", ")}</span>}
            </li>
          ))}
        </ul>
      </div>

      {/* Audit */}
      <details style={{ marginTop: 14, background: "#111", border: "1px solid #262626", borderRadius: 8, padding: "10px 14px" }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "#a3a3a3" }}>Audit log (append-only, trigger-enforced §5.6) — {out.audit.length} recent rows</summary>
        <pre style={{ fontSize: 11, color: "#a3a3a3", overflow: "auto", marginTop: 8, whiteSpace: "pre-wrap" }}>{out.audit.map((r) => `${r.ts}  ${r.kind.padEnd(18)}  ${r.payload.slice(0, 200)}`).join("\n")}</pre>
      </details>

      <p style={{ fontSize: 11, color: "#737373", marginTop: 12 }}>
        Nothing reaches the UI without resolving through <code>citation_strings</code> and matching quoted text against the cited opinion (§5.1-5.2). Inferred treatment is never asserted as fact (§5.5). System says “no authority found in the corpus” — never “no authority exists” (§11).
      </p>
    </section>
  );
}

function IracBlock({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ marginBottom: 10, background: "#171717", border: "1px solid #262626", borderRadius: 6, padding: "10px 12px" }}>
      <div style={{ fontSize: 11, color: "#737373", textTransform: "uppercase", letterSpacing: 0.5 }}>{label} <span style={{ color: "#525252" }}>· inferred</span></div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: "#d4d4d4", marginTop: 4, whiteSpace: "pre-wrap" }}>{text}</div>
    </div>
  );
}
