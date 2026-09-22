# ADR-004: Hybrid inference — user-selectable local or cloud, verifier-gated either way

**Status:** Accepted (2026-09-22) — reverses the "Local inference only" locked decision in CLAUDE.md §1.

## Context

The canon locked "local inference only" (§1) for two reasons: privileged
client material never leaves the machine, and no cloud dependency. That
lock produced the world's most *trustworthy* legal research engine — the
G2 verifier's 100% fabrication catch is the moat — but it also capped
reasoning quality at 9B/14B, which §9.1 honestly records as the
product's weakest link. The goal ("the strongest AI lawyer ever built")
cannot be reached with that ceiling, and the target buyer (BigLaw/
enterprise) compares against frontier-model tools.

The market fact that forces the reversal: generation is becoming a
commodity (frontier reasoning rents for cents), while *verification* is
scarce — Stanford measured 17–33% hallucination in the market leaders,
and courts sanction AI-fabricated citations. The scarce thing is exactly
what this repo already owns. Buying generation wholesale and keeping
verification local is the highest-leverage move available.

## Decision

1. **Hybrid, user-selectable.** Engine modes `local | cloud | auto`,
   chosen per run in the UI (default follows `ALEX_ENGINE`, default
   `local`). Auto routes per stage via `ALEX_AUTO_ROUTE`; the default
   route sends Analyst+Adversary (reasoning-heavy) to the cloud and keeps
   Intake+Researcher local — the Researcher writes queries for OUR FTS
   dialect, where a frontier model's natural-language queries can
   retrieve *worse*. Route changes require A/B evidence
   (`evals/run_g3_ab.ts`), not intuition.
2. **The cloud is an OpenAI-compatible endpoint** (`ALEX_CLOUD_BASE_URL`),
   not a vendor SDK: self-hosted vLLM, a firm gateway, or a vendored API
   are the same config. No dependency added — one `fetch`.
3. **The verifier gates every engine identically.** §5.1–5.2 are
   engine-agnostic by construction: the gate reads citations and quotes,
   not engines. Cloud text additionally passes the normalizer
   (`app/lib/normalize.ts`) because frontier models wrap quotes in
   markdown the quote ladder would reject verbatim.
4. **Fail-loud defaults.** `ALEX_CLOUD_FALLBACK=abort` (default): a cloud
   failure fails the run honestly. `=local` falls back WITH a disclosure
   audit row (`engine.fallback`) and a UI badge. No silent degradation,
   no fail-open. Cloud model existence is checked at startup
   (`GET /models`) — the cloud twin of the `ollama list` check — but as
   an **advisory warn only**: the live Gemini endpoint shipped stale lists
   (it advertised ids its chat endpoint 404s, and omitted ones it serves —
   `gemini-3.6-flash`), so the list cannot be authoritative; the first
   chat call is the loud failure. Prefer aliases (`gemini-flash-latest`)
   over numeric ids: `gemini-2.0-flash` served a canary and 404'd a full
   run minutes later on 2026-09-22. Demand-shaped 429/503 get a patience
   ladder (6s/15s/30s) because those responses carry no Retry-After.
5. **Provenance is mandatory.** Every stage records
   `engine:model` in `messages.model`, the stage audit rows, and the run
   output; drafts carry a verification certificate with per-stage engine
   provenance (`app/lib/certificate.ts`).
6. **Secrets discipline.** The key lives only in `.env` (gitignored);
   audit rows carry a fingerprint, never the key; provider errors are
   scrubbed (`app/lib/env.ts`); a guard test fails the build if the key
   variable name appears anywhere but `.env.example`.

## The eval case that justifies the change (§2)

The G3 five-pattern harness is the measured evidence that analyst/
adversary reasoning depth on 9B/14B is the weak point; §9.1 names it.
`evals/run_g3_ab.ts` runs the same five patterns under both engines and
records objective verification metrics side by side into
`logs/g3-ab-report.json` — that report is the standing evidence for this
ADR and the routing table's ongoing justification.

## Consequences

- Local remains the privacy tier and the air-gapped SKU; cloud is opt-in
  per run and audited. The privileged material in a cloud-bound payload
  is the intake facts only (retrieval passages are public corpus text);
  a party-redaction option is the follow-up (not built in Phase A).
- `pnpm test` runs the cloud provider against mock fetch — no key, no
  network. Key-gated live checks exist only where marked.
- The "12 GB is the hard constraint" VRAM rules are unchanged for the
  local tier; `useModel()` no-ops while the cloud engine is pinned.
- Generation cost becomes a per-run operational fact (token counts in
  audit rows) — acceptable; it is the price of closing the reasoning gap
  without giving up the moat.
