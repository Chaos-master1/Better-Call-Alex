/**
 * G3 demo-minimal UI: a single chat-style input that runs the four-agent
 * pipeline. The same `runCase` orchestrator the CLI uses — this page is
 * a thin client around the API route.
 *
 * The output is rendered per the render contract:
 *   ✓  [LAW]    verified
 *   ≈  [INFERRED]  rendered dim, never as fact (§5.5)
 *   ✗  [LAW]    unverified → struck through, never silently dropped (§3, §11)
 */
"use client";

import { useState, useTransition } from "react";

interface VerifiedSentence {
  index: number;
  tag: "RECORD" | "LAW" | "INFERRED";
  text: string;
  pin_cite?: string;
  verified: boolean;
  detail: string[];
  inferred: boolean;
}

interface RunResponse {
  case_id: number;
  intake: unknown;
  irac: { issue: string; rule: string; application: string; conclusion: string };
  element_checklist: Array<{ element: string; status: string; basis: string }>;
  adversary: { counter_argument: string; treatment_caveats: string[] };
  draft: { overall: "pass" | "fail"; sentences: VerifiedSentence[] };
  ms: number;
}

const SAMPLE = `A 67-year-old Black man checked into a motel in Atlanta. The motel
manager called police and reported him as a 'suspicious person' after seeing
him in the lobby. Officers arrived, asked him to leave, and when he refused,
arrested him for trespass. He was held for 9 hours and released without
charges. He sues the motel under 42 U.S.C. § 1983.`;

export default function Home() {
  const [facts, setFacts] = useState(SAMPLE);
  const [out, setOut] = useState<RunResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    setErr(null);
    setOut(null);
    startTransition(async () => {
      try {
        const r = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ facts }),
        });
        if (!r.ok) {
          const t = await r.text();
          setErr(`${r.status} ${r.statusText}: ${t.slice(0, 200)}`);
          return;
        }
        const j = (await r.json()) as RunResponse;
        setOut(j);
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
    });
  };

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "24px 16px" }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Better Call Alex</h1>
      <p style={{ color: "#a3a3a3", marginTop: 0, fontSize: 13 }}>
        US case-law research. Local. Verifiable.
      </p>
      <div
        style={{
          background: "#3a1f1f",
          color: "#fca5a5",
          padding: "8px 12px",
          borderRadius: 4,
          marginBottom: 12,
          fontSize: 13,
        }}
      >
        DRAFT — REQUIRES LICENSED REVIEW — NOT LEGAL ADVICE
      </div>
      <textarea
        value={facts}
        onChange={(e) => setFacts(e.target.value)}
        rows={6}
        style={{
          width: "100%",
          background: "#171717",
          color: "#e5e5e5",
          border: "1px solid #404040",
          padding: 12,
          borderRadius: 4,
          fontFamily: "inherit",
          fontSize: 13,
        }}
      />
      <button
        onClick={run}
        disabled={pending || !facts.trim()}
        style={{
          marginTop: 12,
          padding: "8px 16px",
          background: pending ? "#404040" : "#1d4ed8",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: pending ? "wait" : "pointer",
          fontSize: 14,
        }}
      >
        {pending ? "Running pipeline…" : "Run pipeline"}
      </button>
      {err && (
        <pre
          style={{
            marginTop: 16,
            padding: 12,
            background: "#1f1010",
            color: "#fca5a5",
            border: "1px solid #7f1d1d",
            borderRadius: 4,
            fontSize: 12,
            overflow: "auto",
          }}
        >
          {err}
        </pre>
      )}
      {out && <Result out={out} />}
    </main>
  );
}

function Result({ out }: { out: RunResponse }) {
  const verified = out.draft.sentences.filter((s) => s.verified).length;
  const total = out.draft.sentences.length;
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, color: "#a3a3a3" }}>
        IRAC
      </h2>
      <IracBlock label="Issue" text={out.irac.issue} />
      <IracBlock label="Rule" text={out.irac.rule} />
      <IracBlock label="Application" text={out.irac.application} />
      <IracBlock label="Conclusion" text={out.irac.conclusion} />

      <h2 style={{ fontSize: 16, color: "#a3a3a3", marginTop: 24 }}>
        Adversary
      </h2>
      <p style={{ fontSize: 13, lineHeight: 1.6 }}>{out.adversary.counter_argument}</p>
      {out.adversary.treatment_caveats.length > 0 && (
        <ul style={{ fontSize: 12, color: "#a3a3a3" }}>
          {out.adversary.treatment_caveats.map((t, i) => (
            <li key={i}><em>inferred:</em> {t}</li>
          ))}
        </ul>
      )}

      <h2 style={{ fontSize: 16, color: "#a3a3a3", marginTop: 24 }}>
        Draft sentences ({out.draft.overall.toUpperCase()})
      </h2>
      <ul style={{ listStyle: "none", padding: 0, fontSize: 13, lineHeight: 1.7 }}>
        {out.draft.sentences.map((s) => (
          <li key={s.index} style={{ marginBottom: 6 }}>
            <span
              style={{
                color: !s.verified ? "#ef4444" : s.inferred ? "#a3a3a3" : "#22c55e",
                marginRight: 6,
                fontFamily: "inherit",
              }}
            >
              {!s.verified ? "✗" : s.inferred ? "≈" : "✓"}
            </span>
            <span style={{ color: "#7dd3fc", marginRight: 6 }}>[{s.tag}]</span>
            <span style={!s.verified ? { textDecoration: "line-through" } : s.inferred ? { color: "#a3a3a3" } : {}}>
              {s.text}
            </span>
            {s.pin_cite && (
              <span style={{ color: "#737373", marginLeft: 4 }}>({s.pin_cite})</span>
            )}
            {!s.verified && s.detail.length > 0 && (
              <div style={{ color: "#fca5a5", fontSize: 11, marginTop: 2, marginLeft: 22 }}>
                {s.detail.join("; ")}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: 12, color: "#a3a3a3" }}>
        verified {verified}/{total} · total {(out.ms / 1000).toFixed(1)}s
      </p>
    </section>
  );
}

function IracBlock({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: "#a3a3a3", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>{text}</div>
    </div>
  );
}
