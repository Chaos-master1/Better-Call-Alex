/**
 * Result dashboard — every information element of the old Result panel,
 * restructured: verdict → draft → research → adversary → appendix.
 * Verification states are border + icon + label, never color alone.
 */
"use client";

import { useState } from "react";
import type { HitCard, RunResponse, VerifiedSentence } from "./types";
import { draftToText, treatmentLabels } from "./types";

export function CopyDraftButton({ out }: { out: RunResponse }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ax-btn ax-btn-ghost ax-btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(draftToText(out));
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied ✓" : "Copy draft"}
    </button>
  );
}

export function ExportDocxButton({ caseId }: { caseId: number }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <button
        className="ax-btn ax-btn-ghost ax-btn-sm"
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
              } catch {
                /* keep raw text */
              }
              setRefused(`${r.status}: ${detail.slice(0, 200)}`);
              return;
            }
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
          } catch (e: unknown) {
            setRefused(`export failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Exporting…" : "Export .docx"}
      </button>
      {refused && (
        <span className="ax-refused" role="alert">
          {refused}
        </span>
      )}
    </span>
  );
}

function SentenceItem({ s }: { s: VerifiedSentence }) {
  const state = !s.verified ? "unverified" : "verified";
  const mark = !s.verified ? "✗" : s.inferred ? "≈" : "✓";
  const markLabel = !s.verified ? "failed verification" : s.inferred ? "inferred" : "verified";
  return (
    <li className={`ax-sentence ${state}`}>
      <span className="ax-s-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="ax-s-tag">[{s.tag}]</span>
      <span className="sr-only">{markLabel}: </span>
      <span className={!s.verified ? "s-text-unverified" : s.inferred ? "s-text-inferred" : undefined}>
        {s.text}
      </span>
      {s.pin_cite && <span className="ax-s-pin">({s.pin_cite})</span>}
      {!s.verified && <span className="ax-s-flag">UNVERIFIED</span>}
      {s.verified && s.inferred && <span className="ax-s-flag inferred">INFERRED</span>}
      {s.detail.length > 0 && <div className="ax-s-detail">{s.detail.join(" · ")}</div>}
    </li>
  );
}

function IracBlock({
  label,
  text,
  verified,
}: {
  label: string;
  text: string;
  verified?: boolean;
}) {
  return (
    <div className="ax-irac">
      <h4>
        {label}{" "}
        <span className="ax-note">
          {verified === undefined
            ? "· analyst output, not sentence-verified"
            : verified
            ? "· verified — quotes checked"
            : "· FAILED quote verification"}
        </span>
      </h4>
      <p className={verified === false ? "s-text-unverified" : undefined}>
        {text}
      </p>
      {verified === false && <span className="ax-s-flag">UNVERIFIED</span>}
    </div>
  );
}

function AuthorityCard({ h }: { h: HitCard }) {
  return (
    <div className="ax-auth">
      <div className="ax-auth-head">
        {h.case_name ?? "(unnamed)"}{" "}
        <span className="ax-dim">
          · {h.court_id} · {h.date_filed} · {h.precedential_status}
        </span>{" "}
        {h.via_parenthetical_recall && (
          <span className="ax-chip info">via parenthetical recall</span>
        )}
      </div>
      <div className="ax-auth-scores">
        BM25 {h.scores.bm25.toFixed(1)} · authority ×
        {h.scores.authority_multiplier.toFixed(2)} · final{" "}
        {h.scores.final.toFixed(1)} · recent cites 2y {h.cited_by_recent} ·
        treatment{" "}
        {h.treatment_flags ? (
          <span className="ax-treat-bad">
            {treatmentLabels(h.treatment_flags).join(", ")} (inferred)
          </span>
        ) : (
          "—"
        )}
        {h.scores.parenthetical_hits > 0 && (
          <> · paren {h.scores.parenthetical_hits}</>
        )}
      </div>
      {h.passages[0] && (
        <div className="ax-passage">
          {h.passages[0].text}
          <span className="ax-off">
            [{h.passages[0].start}—{h.passages[0].end}]
          </span>
        </div>
      )}
    </div>
  );
}

export function ResultDashboard({ out }: { out: RunResponse }) {
  const verified = out.draft.sentences.filter((s) => s.verified).length;
  const total = out.draft.sentences.length;
  const pass = out.draft.overall === "pass";
  return (
    <section aria-label="Result">
      <div className="ax-verdict">
        <h2>Research memo</h2>
        <span className={`ax-chip ${pass ? "pass" : "fail"}`}>
          {pass ? "✓" : "✗"} {out.draft.overall.toUpperCase()} · {verified}/
          {total} verified
        </span>
        {out.drafted.verification.verdict && (
          <span className="ax-meta">
            citations{" "}
            {out.drafted.verification.verdict.citations_verified}/
            {out.drafted.verification.verdict.citations_extracted} resolved ·
            quotes {out.drafted.verification.verdict.quotes_verified}/
            {out.drafted.verification.verdict.quotes_checked} matched
            {out.drafted.verification.verdict.failures.length > 0 && (
              <>
                {" "}· {out.drafted.verification.verdict.failures.length}{" "}
                struck:{" "}
                {out.drafted.verification.verdict.failures
                  .map((f) => `#${f.index} ${f.reason.split("→")[0].trim()}`)
                  .join("; ")}
              </>
            )}
          </span>
        )}
        <span className="ax-meta">
          {(out.ms / 1000).toFixed(1)}s · run {out.run_id} ·{" "}
          {out.drafted.generated_at}
        </span>
        <CopyDraftButton out={out} />
        <ExportDocxButton caseId={out.case_id} />
      </div>

      {out.engines && out.engines.length > 0 && (
        <div className="ax-card">
          <h3>Engines (ADR-004)</h3>
          <p className="ax-card-sub">
            Which engine produced each stage. The verifier gates every engine
            identically — it reads citations and quotes, not models.
          </p>
          <ul className="ax-appendix">
            {out.engines.map((e) => (
              <li key={e.stage}>
                <span aria-hidden="true">◇</span>
                <code>{e.stage}</code>
                <span>
                  <span className={`ax-chip ${e.engine === "cloud" ? "info" : "pass"}`}>
                    {e.engine}
                  </span>{" "}
                  {e.model}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="ax-card">
        <div className="ax-banner" role="note">
          {out.drafted.banner}
        </div>
        <p className="ax-doctitle">{out.drafted.title}</p>
        <p className="ax-caption">{out.drafted.caption}</p>
        <p className="ax-card-sub">
          verification: {JSON.stringify(out.drafted.verification.summary)} ·
          overall {out.drafted.verification.overall}
        </p>
      </div>

      <div className="ax-card">
        <h3>Verified draft</h3>
        <p className="ax-card-sub">
          Every sentence gated by the verifier. ✗ struck-through sentences
          failed verification — shown, never hidden. ≈ marks inference (§5.5).
        </p>
        <ul className="ax-sentences">
          {out.draft.sentences.map((s) => (
            <SentenceItem key={s.index} s={s} />
          ))}
        </ul>
      </div>

      <div className="ax-card">
        <h3>IRAC analysis</h3>
        <p className="ax-card-sub">
          Structured analyst reasoning. Fields ride the verifier gate when the
          pipeline tagged them — struck-through text failed quote verification.
        </p>
        <div className="ax-irac-grid">
          {(["issue", "rule", "application", "conclusion"] as const).map((k) => {
            const gated = out.drafted_irac_verified?.[k];
            const label = k.charAt(0).toUpperCase() + k.slice(1);
            return gated ? (
              <IracBlock key={k} label={label} text={gated.text} verified={gated.verified} />
            ) : (
              <IracBlock key={k} label={label} text={out.irac?.[k] ?? ""} />
            );
          })}
        </div>
        <h4 className="ax-section-label">Element checklist</h4>
        <div style={{ overflow: "auto" }}>
          <table className="ax-table">
            <thead>
              <tr>
                <th scope="col">Element</th>
                <th scope="col">Status</th>
                <th scope="col">Basis</th>
              </tr>
            </thead>
            <tbody>
              {out.element_checklist.map((r, i) => (
                <tr key={i}>
                  <td>{r.element}</td>
                  <td>
                    <span className={`ax-status ${r.status}`}>{r.status}</span>
                  </td>
                  <td>{r.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="ax-card">
        <h3>Research trail</h3>
        <p className="ax-card-sub">
          Three retrieval frames → BM25 × authority × parentheticals. Passages
          carry char offsets for pin cites.
        </p>
        <div className="ax-auth-grid">
          {out.research.queries.map((q, i) => (
            <div key={i} className="ax-query">
              <span className="ax-q">Q{i + 1}:</span> {q.q}{" "}
              <span style={{ color: "var(--txt-3)" }}>— {q.why}</span>
              {out.research.top_picks[i]?.hit && (
                <div className="ax-top">
                  top: <em>{out.research.top_picks[i]!.hit!.case_name}</em> (
                  {out.research.top_picks[i]!.hit!.court_id} · BM25{" "}
                  {out.research.top_picks[i]!.hit!.scores.bm25.toFixed(1)} · ×
                  {out.research.top_picks[i]!.hit!.scores.authority_multiplier.toFixed(2)}{" "}
                  · paren{" "}
                  {out.research.top_picks[i]!.hit!.scores.parenthetical_hits})
                </div>
              )}
            </div>
          ))}
        </div>
        <h4 className="ax-section-label">Authority (top hits, 1 per cluster)</h4>
        <div className="ax-auth-grid">
          {out.research.hits.slice(0, 10).map((h, i) => (
            <AuthorityCard key={i} h={h} />
          ))}
        </div>
      </div>

      <div className="ax-card ax-adversary">
        <h3>Opposing counsel — the best case against you</h3>
        <p className="ax-card-sub">
          Retrieved counter-argument, not invented. Read this before you file.
        </p>
        {out.drafted_counter_argument_verified ? (
          <p
            className={`ax-counter ${
              out.drafted_counter_argument_verified.verified ? "" : "s-text-unverified"
            }`}
          >
            {out.drafted_counter_argument_verified.text}
            {!out.drafted_counter_argument_verified.verified && (
              <span className="ax-s-flag"> — UNVERIFIED</span>
            )}
          </p>
        ) : (
          <p className="ax-counter">{out.adversary.counter_argument}</p>
        )}
        {out.adversary.treatment_caveats.length > 0 && (
          <ul className="ax-caveats">
            {out.adversary.treatment_caveats.map((t, i) => (
              <li key={i}>
                <em>inferred:</em> {t}
              </li>
            ))}
          </ul>
        )}
        {out.adversary.counter_authority.length > 0 && (
          <>
            <h4 className="ax-section-label">Counter-authority (retrieved)</h4>
            <ul className="ax-counter-auth">
              {out.adversary.counter_authority.map((h, i) => (
                <li key={i}>
                  <em>{h.case_name ?? "(unnamed)"}</em>{" "}
                  <span style={{ color: "var(--txt-3)" }}>· {h.court_id}</span>
                  {h.passages?.[0]?.text && (
                    <div className="ax-passage">
                      {h.passages[0].text.slice(0, 260)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="ax-card">
        <h3>Authority appendix</h3>
        <p className="ax-card-sub">
          {out.drafted.banner} · {out.drafted.caption}
        </p>
        <ul className="ax-appendix">
          {out.drafted.authority_appendix.map((a, i) => (
            <li key={i}>
              <span aria-hidden="true">{a.verified ? "✓" : "✗"}</span>
              <code>{a.citation}</code>
              <span>
                {a.case_name ?? "—"}{" "}
                {!a.verified && <span className="unres">unresolved</span>}
                {a.ambiguous && <span className="unres"> · AMBIGUOUS</span>}
                {a.inferred_treatment.length > 0 && (
                  <span className="unres">
                    {" "}
                    · inferred: {a.inferred_treatment.join(", ")}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {out.drafted.certificate && (
        <div className="ax-card">
          <h3>Verification certificate</h3>
          <p className="ax-card-sub">{out.drafted.certificate.statement}</p>
          <ul className="ax-appendix">
            <li>
              <span aria-hidden="true">№</span>
              <code>{out.drafted.certificate.schema}</code>
              <span>overall {out.drafted.certificate.overall.toUpperCase()}</span>
            </li>
            <li>
              <span aria-hidden="true">#</span>
              <code>SHA-256</code>
              <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                {out.drafted.certificate.draft_sha256}
              </span>
            </li>
            <li>
              <span aria-hidden="true">⚓</span>
              <code>audit anchor</code>
              <span>
                audit_log row {out.drafted.certificate.audit_row_id ?? "—"} · run{" "}
                {out.drafted.certificate.run_id ?? "—"} (append-only, trigger-enforced)
              </span>
            </li>
          </ul>
        </div>
      )}

      <details className="ax-details">
        <summary>
          Intake (structured, unknowns = UNVERIFIED)
        </summary>
        <pre className="ax-pre">{JSON.stringify(out.intake, null, 2)}</pre>
      </details>

      <p className="ax-footnote">
        Nothing reaches the UI without resolving through{" "}
        <code>citation_strings</code> and matching quoted text against the
        cited opinion (§5.1–5.2). Inferred treatment is never asserted as
        fact (§5.5). The system says “no authority found in the corpus” —
        never “no authority exists” (§11).
      </p>
    </section>
  );
}
