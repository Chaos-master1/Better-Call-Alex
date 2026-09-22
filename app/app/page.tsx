/**
 * Better Call Alex — run wiring around POST /api/run + /api/cases.
 * Presentation lives in components/; the G2 verifier gate, banner rule,
 * and audit trail are unchanged (§3, §5.6, §11).
 */
"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Brand, Composer, HistoryRail } from "../components/chrome";
import { Inspector } from "../components/inspector";
import { ResultDashboard } from "../components/result";
import { SAMPLE, type CaseSummary, type RunResponse } from "../components/types";

/** The server's message, not its envelope: parse JSON error bodies
 *  ({error: string}), fall back to `status: raw` for non-JSON. */
function serverMsg(status: number, raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: string };
    if (j.error) return j.error;
  } catch { /* non-JSON — keep raw */ }
  return `${status}: ${raw.slice(0, 300)}`;
}

export default function Home() {
  const [facts, setFacts] = useState(SAMPLE);
  const [forum, setForum] = useState("");
  // ADR-004 per-run engine choice. The default follows the server's env
  // mode once /api/engine answers (the toggle only widens choice when a
  // key is configured).
  const [engineMode, setEngineMode] = useState("local");
  const [engineInfo, setEngineInfo] = useState<{
    env_mode: string;
    cloud_available: boolean;
    cloud_model: string | null;
    auto_route: Record<string, string>;
  } | null>(null);
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
    fetch("/api/engine")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setEngineInfo(j);
        // Default the toggle to the server's env mode; a cloud-only env
        // with no key falls back to local in the option list.
        setEngineMode(j.env_mode ?? "local");
      })
      .catch(() => {
        /* engine status is advisory; local remains the default */
      });
  }, [loadCases]);

  const run = () => {
    setErr(null);
    setOut(null);
    // One flight at a time: a new submit aborts the previous request so a
    // stale run can never clobber a fresh one (the server queue still
    // serializes model work).
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const gen = ++genRef.current;
    // Forum rides the same channel the G3 harness uses: the intake agent
    // extracts it from the facts text, and the researcher filters on it
    // when it resolves (ADR-002). No API change.
    const payload =
      forum.trim() === "" ? facts : `[Jurisdiction: ${forum.trim()}] ${facts}`;
    startTransition(async () => {
      try {
        const r = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ facts: payload, engineMode }),
          signal: ac.signal,
        });
        if (gen !== genRef.current) return; // superseded — drop stale result
        if (!r.ok) {
          const t = await r.text();
          setErr(serverMsg(r.status, t));
          return;
        }
        const j = (await r.json()) as RunResponse;
        setOut(j);
        loadCases();
      } catch (e: unknown) {
        if ((e as Error)?.name === "AbortError") return; // cancelled by a newer submit
        if (gen !== genRef.current) return;
        setErr(String((e as Error)?.message ?? e));
      }
    });
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const openCase = (id: number) => {
    setErr(null);
    // History loads are cheap reads: they work while a model run is in
    // flight and never clobber a newer selection (generation guard).
    const gen = ++genRef.current;
    startTransition(async () => {
      try {
        const r = await fetch(`/api/cases/${id}`);
        if (gen !== genRef.current) return;
        if (!r.ok) {
          const t = await r.text();
          setErr(serverMsg(r.status, t));
          return;
        }
        setOut((await r.json()) as RunResponse);
      } catch (e: unknown) {
        if (gen !== genRef.current) return;
        setErr(String((e as Error)?.message ?? e));
      }
    });
  };

  return (
    <div className="ax-shell">
      <div className="ax-rail">
        <Brand />
        <HistoryRail
          cases={cases}
          activeId={out?.case_id ?? null}
          historyError={historyError}
          onOpen={openCase}
        />
      </div>
      <main className="ax-main">
        <Composer
          facts={facts}
          setFacts={setFacts}
          forum={forum}
          setForum={setForum}
          engineMode={engineMode}
          setEngineMode={setEngineMode}
          engineInfo={engineInfo}
          pending={pending}
          err={err}
          onRun={run}
          onCancel={cancel}
        />
        {pending && !out && (
          <p className="ax-run-note" aria-live="polite" style={{ marginTop: 14 }}>
            Pipeline running — local models take minutes per pass. History
            stays usable while you wait.
          </p>
        )}
        {out && <ResultDashboard out={out} />}
      </main>
      <div className="ax-inspector">
        <Inspector out={out} />
      </div>
      <nav className="ax-citeguard-nav" aria-label="Tools">
        <Link href="/citeguard" className="ax-btn ax-btn-ghost ax-btn-sm">
          CiteGuard — verify any AI draft →
        </Link>
      </nav>
    </div>
  );
}
