/**
 * Inspector rail — the verification ledger. Every sentence expandable to
 * its checks, plus the audit trail. This turns the gate from a badge into
 * the product: the user can see exactly why each sentence passed or failed.
 */
"use client";

import type { RunResponse } from "./types";

export function Inspector({ out }: { out: RunResponse | null }) {
  if (!out) {
    return (
      <aside aria-label="Verification inspector">
        <h2 className="ax-section-label">Verification ledger</h2>
        <p className="ax-empty">
          Run the pipeline or open a case — every sentence&apos;s checks will
          appear here.
        </p>
        <h2 className="ax-section-label">How verification works</h2>
        <p className="ax-empty">
          Citations resolve through <code>citation_strings</code>. Quotes must
          match the cited opinion&apos;s text. Failures render struck-through
          in the draft — shown, never hidden.
        </p>
      </aside>
    );
  }
  const verified = out.draft.sentences.filter((s) => s.verified).length;
  const total = out.draft.sentences.length;
  return (
    <aside aria-label="Verification inspector">
      <h2 className="ax-section-label">Verification ledger</h2>
      <p style={{ fontSize: 12, color: "var(--txt-2)", margin: "0 0 4px" }}>
        {verified}/{total} sentences verified · overall{" "}
        <strong
          style={{
            color:
              out.draft.overall === "pass"
                ? "var(--ok)"
                : "var(--bad)",
          }}
        >
          {out.draft.overall.toUpperCase()}
        </strong>
      </p>
      <p style={{ fontSize: 11, color: "var(--txt-3)", margin: "0 0 6px" }}>
        {JSON.stringify(out.drafted.verification.summary)}
      </p>
      <ul className="ax-ledger">
        {out.draft.sentences.map((s) => (
          <li key={s.index} className="ax-ledger-item">
            <details>
              <summary>
                <span aria-hidden="true">
                  {!s.verified ? "✗" : s.inferred ? "≈" : "✓"}
                </span>
                <span>
                  [{s.tag}] {s.text.slice(0, 64)}
                  {s.text.length > 64 ? "…" : ""}
                </span>
              </summary>
              <div className="ax-ledger-body">
                {s.pin_cite ? `pin: ${s.pin_cite}\n` : "pin: none\n"}
                {s.detail.length > 0
                  ? s.detail.join("\n")
                  : "no individual checks recorded"}
              </div>
            </details>
          </li>
        ))}
      </ul>

      <h2 className="ax-section-label">
        Audit log — {out.audit.length} rows
      </h2>
      <pre className="ax-pre" style={{ maxHeight: 320 }}>
        {out.audit.map((r) => `${r.ts}  ${r.kind}  ${r.payload.slice(0, 160)}`).join("\n")}
      </pre>
      <p className="ax-empty" style={{ marginTop: 8 }}>
        Append-only, trigger-enforced (§5.6).
      </p>
    </aside>
  );
}
