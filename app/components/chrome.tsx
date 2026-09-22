/**
 * Shell chrome: brand, case-history rail, fact-pattern composer.
 * Data fetching lives in page.tsx; these components render props.
 */
"use client";

import { useEffect, useState } from "react";
import type { CaseSummary } from "./types";

export function Brand() {
  return (
    <header>
      <p className="ax-brand">
        Better <em>Call Alex</em>
      </p>
      <p className="ax-tagline">
        US case-law research. Local. Verifiable. Every claim is gated.
      </p>
    </header>
  );
}

export function HistoryRail({
  cases,
  activeId,
  historyError,
  onOpen,
}: {
  cases: CaseSummary[];
  activeId: number | null;
  historyError: string | null;
  onOpen: (id: number) => void;
}) {
  return (
    <nav aria-label="Case history">
      <h2 className="ax-section-label">Case history</h2>
      {historyError && <p className="ax-empty">{historyError}</p>}
      {!historyError && cases.length === 0 && (
        <p className="ax-empty">No cases yet — run the pipeline.</p>
      )}
      <ul className="ax-case-list">
        {cases.map((c) => (
          <li key={c.id}>
            <button
              className="ax-case"
              onClick={() => onOpen(c.id)}
              aria-current={activeId === c.id}
              aria-label={`Open case ${c.id}: ${c.title}`}
              title={c.title}
            >
              <div className="ax-case-title">{c.title}</div>
              <div className="ax-case-meta">
                <span>{c.created_at?.slice(0, 16)}</span>
                {c.status && <span>· {c.status}</span>}
                {c.overall && (
                  <span
                    className={`ax-dot ${c.overall === "pass" ? "ok" : "bad"}`}
                    aria-label={c.overall === "pass" ? "verified" : "unverified claims present"}
                  >
                    {c.overall === "pass" ? "●" : "◐"}
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// History loads are cheap reads that must work mid-run; the generation
// guard in page.tsx makes last-click win, so no disabled state here.
const STAGES: Array<[string, string]> = [
  ["Intake", "facts → structured claims"],
  ["Research", "3 retrieval frames × BM25"],
  ["Analysis", "IRAC with pin cites"],
  ["Adversary", "retrieved counter-argument"],
  ["Verifier", "gate every cite + quote"],
];

export type { StageEngine } from "./types";

function useElapsed(running: boolean): number {
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (running) {
      setStarted(Date.now());
      const t = setInterval(() => setNow(Date.now()), 500);
      return () => clearInterval(t);
    }
    setStarted(null);
  }, [running]);
  return started == null ? 0 : Math.max(0, Math.floor((now - started) / 1000));
}

export function Composer({
  facts,
  setFacts,
  forum,
  setForum,
  engineMode,
  setEngineMode,
  engineInfo,
  pending,
  err,
  onRun,
  onCancel,
}: {
  facts: string;
  setFacts: (v: string) => void;
  forum: string;
  setForum: (v: string) => void;
  /** ADR-004 per-run engine choice. */
  engineMode: string;
  setEngineMode: (v: string) => void;
  /** Non-secret engine status from GET /api/engine. */
  engineInfo: {
    env_mode: string;
    cloud_available: boolean;
    cloud_model: string | null;
    auto_route: Record<string, string>;
  } | null;
  pending: boolean;
  err: string | null;
  onRun: () => void;
  onCancel: () => void;
}) {
  const elapsed = useElapsed(pending);
  const stageDesc = (s: string): string => {
    const stage = engineInfo?.auto_route?.[s] ?? (s === "analyst" || s === "adversary" ? "cloud" : "local");
    if (engineMode === "local") return "local";
    if (engineMode === "cloud") return "cloud";
    return engineInfo?.cloud_available ? stage : "local";
  };
  return (
    <div className="ax-composer-block">
      <div className="ax-hero">
        <h1>
          Research the case law. <em>Prove every sentence.</em>
        </h1>
        <p>
          Describe the facts. Alex retrieves real opinions, drafts an IRAC
          analysis, argues against itself — and the verifier gates every
          citation and quote before anything reaches you.
        </p>
      </div>

      <div className="ax-banner" role="note">
        DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE
      </div>

      <div className="ax-field">
        <label htmlFor="ax-facts">Fact pattern</label>
        <textarea
          id="ax-facts"
          className="ax-textarea"
          rows={6}
          value={facts}
          maxLength={16000}
          onChange={(e) => setFacts(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !pending && facts.trim()) onRun();
          }}
          placeholder="Free-text fact pattern…"
        />
      </div>

      <div className="ax-forum-row">
        <div className="ax-field">
          <label htmlFor="ax-forum">Forum / jurisdiction (optional)</label>
          <input
            id="ax-forum"
            className="ax-input"
            value={forum}
            maxLength={120}
            onChange={(e) => setForum(e.target.value)}
            placeholder="e.g. California, 9th Circuit, cal"
          />
          <p className="ax-hint">
            Narrows retrieval when it matches a real court; ignored when it
            doesn&apos;t — never silently empties results.
          </p>
        </div>
        <div className="ax-field">
          <label htmlFor="ax-engine">Engine (ADR-004)</label>
          <select
            id="ax-engine"
            className="ax-input"
            value={engineMode}
            disabled={pending}
            onChange={(e) => setEngineMode(e.target.value)}
          >
            <option value="local">Local — private, on this machine</option>
            <option value="cloud" disabled={!engineInfo?.cloud_available}>
              Cloud{engineInfo?.cloud_model ? ` — ${engineInfo.cloud_model}` : ""}
              {!engineInfo?.cloud_available ? " (no key configured)" : ""}
            </option>
            <option value="auto" disabled={!engineInfo?.cloud_available}>
              Auto — frontier reasons, local researches
            </option>
          </select>
          <p className="ax-hint">
            {engineMode === "auto"
              ? `Analyst+adversary ride ${stageDesc("analyst")}; intake+research stay ${stageDesc("intake")}.`
              : engineMode === "cloud"
              ? "Every stage on the configured cloud endpoint. The verifier gates cloud output exactly like local."
              : "Everything on this machine. Privileged material never leaves it."}
          </p>
        </div>
      </div>

      <div className="ax-actions">
        <button
          className="ax-btn ax-btn-primary"
          onClick={onRun}
          disabled={pending || !facts.trim()}
        >
          {pending ? "Running pipeline…" : "Run pipeline"}
        </button>
        {pending && (
          <button className="ax-btn ax-btn-danger" onClick={onCancel}>
            Cancel
          </button>
        )}
        <span className="ax-run-note">
          verifier gate runs on every engine · Ctrl/⌘+Enter to run
        </span>
      </div>

      {pending && (
        <div className="ax-stages" role="status" aria-label="Pipeline running">
          <div className="ax-stages-head">
            <span className="ax-pulse" aria-hidden="true" />
            <span className="ax-elapsed">{elapsed}s elapsed</span>
          </div>
          <ul className="ax-stage-list">
            {STAGES.map(([name, desc]) => {
              const stageKey =
                name === "Intake" ? "intake" : name === "Research" ? "researcher" : name === "Analysis" ? "analyst" : name === "Adversary" ? "adversary" : null;
              const eng = stageKey ? stageDesc(stageKey) : null;
              return (
                <li key={name} className="ax-stage">
                  <b>{name}</b>
                  <span>{desc}</span>
                  {eng && (
                    <span className="ax-chip info" style={{ marginLeft: 8 }}>
                      {eng}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="ax-stage-note">
            Order of operations, not live progress — local models take
            minutes per pass. Cancelling stops the client; the server
            finishes or cancels the run honestly in history.
          </p>
        </div>
      )}

      {err && (
        <p className="ax-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
