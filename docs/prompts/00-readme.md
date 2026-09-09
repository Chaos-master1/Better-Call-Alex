# Salvaged agent prompts

Source: the v1–v7 plan documents (June–August 2026), consolidated in
`better-call-alex-v5.1-consolidation.md` §09 ("Merged Production Prompts",
which itself merges v4.0 + v5.0 with per-agent "also present" notes).
Salvaged 2026-09-08 per canon §1 ("prompt text is salvaged into
`docs/prompts/`").

Each file holds one role's prompt verbatim, plus a *status* note describing
how the current system relates to it. These prompts are **reference, not
runtime**: the live system prompts live in `app/lib/agents/`.

Deliberate divergences (canon §2/§10 — do not "fix" without an eval case):
- Multi-shot / 3-pass synthesis, Council Mode, 7-stage loops: cut (§10).
- `turbovec` index, velocity scores, circuit-split reports: unbuilt; no
  failing eval demands them.
- Temperature/thinking settings: historical record only; runtime uses its
  own generation config.
- The Critic's `[CITATION NEEDED]` replacement policy is superseded: the
  verifier reports failures and the UI renders them struck-through, never
  replaced or dropped (§3, §11).
