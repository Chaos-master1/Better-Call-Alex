/**
 * Cloud payload protection (ADR-004 §2.4) — the single owner of the two
 * protections applied to cloud-bound prompts, registered per run by
 * runCase and applied inside the llm seam where the routed engine is
 * known. Local mode never sees these transforms.
 *
 *   1. Payload caps — token-estimated before send; retrieval passages are
 *      dropped lowest-ranked-first over budget. Truncation is DISCLOSED:
 *      the transform returns what it did, and the run records it in the
 *      certificate so a capped draft is never mistaken for a full one.
 *   2. Party redaction — user-supplied proper names become role
 *      placeholders ([PARTY 1], [PARTY 2], …) in the cloud payload and are
 *      rehydrated in the rendered draft. The raw names never leave the
 *      machine; the audit records COUNTS only, never names.
 */

/** ~4 chars per token: the estimation heuristic, disclosed as an estimate. */
const CHARS_PER_TOKEN = 4;

/** Cloud prompt budget in estimated tokens (ADR-004 §2.4). Leaves ample
 *  headroom under every surveyed provider's context window for the reply. */
export const CLOUD_PROMPT_TOKEN_BUDGET = 24_000;

export interface PayloadGuard {
  /** Apply both protections to a stage prompt. */
  transform(stage: string, prompt: string): string;
  /** Names in PLACEHOLDER-ASSIGNMENT order: the n-th name here is exactly
   *  the one [PARTY n] stood for in the cloud payloads. Rehydration uses
   *  this — occurrence order, not the caller's list order. */
  namesInAssignmentOrder(): string[];
  /** Disclosure for the certificate/audit: what the guards did this run. */
  disclosures(): {
    cappedStages: string[];
    droppedPassages: number;
    redactedPartyCount: number;
  };
}

/**
 * Build the run's payload guard.
 *
 * @param redactNames user-supplied party names to redact (trimmed, ≥3 chars)
 * @param tokenBudget cap in estimated tokens
 */
export function createPayloadGuard(
  redactNames: string[],
  tokenBudget = CLOUD_PROMPT_TOKEN_BUDGET
): PayloadGuard {
  // Dedup case-insensitively; longest-first so multi-word names replace
  // before a shorter fragment of the same name could.
  const names = [...new Set(redactNames.map((n) => n.trim()).filter((n) => n.length >= 3))].sort(
    (a, b) => b.length - a.length
  );
  /** lowercase name → placeholder; kept alongside the ORIGINAL spelling
   *  for rehydration (namesInAssignmentOrder returns what the user gave). */
  const placeholders = new Map<string, string>();
  const originalOf = new Map<string, string>();
  let redactionCounter = 0;
  let redactedHits = 0;
  const cappedStages: string[] = [];
  let droppedPassages = 0;

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function redact(text: string): string {
    if (names.length === 0) return text;
    return text.replace(new RegExp(names.map(esc).join("|"), "gi"), (m) => {
      redactedHits++;
      let ph = placeholders.get(m.toLowerCase());
      if (!ph) {
        redactionCounter++;
        ph = `[PARTY ${redactionCounter}]`;
        placeholders.set(m.toLowerCase(), ph);
        originalOf.set(m.toLowerCase(), m);
      }
      return ph;
    });
  }

  function capPassages(prompt: string): { text: string; dropped: number } {
    const estTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    if (estTokens <= tokenBudget) return { text: prompt, dropped: 0 };
    // Retrieval passages are the ranked, droppable bulk: JSON arrays of
    // {"case_name":…,"passages":[…]} entries produced by the agents.
    let working = prompt;
    let dropped = 0;
    const passageRe = /"passages":\[([^\]]*)\]/g;
    // Drop from the LAST (lowest-ranked) passage list backward; within a
    // list, drop the last (lowest-ranked) passages first.
    const lists = [...prompt.matchAll(passageRe)];
    for (let li = lists.length - 1; li >= 0 && dropped < 5000; li--) {
      const full = lists[li][0];
      const inner = lists[li][1];
      const items = inner.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
      while (items.length > 0 && Math.ceil(working.length / CHARS_PER_TOKEN) > tokenBudget) {
        items.pop();
        dropped++;
        working = prompt.slice(0, lists[li].index!) +
          `"passages":[${items.join(",")}]` +
          prompt.slice(lists[li].index! + full.length);
      }
      if (Math.ceil(working.length / CHARS_PER_TOKEN) <= tokenBudget) break;
    }
    if (Math.ceil(working.length / CHARS_PER_TOKEN) > tokenBudget) {
      // Structural caps exhausted: hard-truncate tail content — disclosed.
      const maxChars = tokenBudget * CHARS_PER_TOKEN;
      working = working.slice(0, maxChars);
    }
    return { text: working, dropped };
  }

  return {
    transform(stage, prompt) {
      let out = redact(prompt);
      const capped = capPassages(out);
      if (capped.dropped > 0) {
        cappedStages.push(stage);
        droppedPassages += capped.dropped;
      }
      // Live-run lesson (logs/redaction-live.json): a model left to its own
      // devices paraphrases around placeholders ("the guest"), and then the
      // local rehydration has no [PARTY n] marker to restore — the user's
      // draft comes home nameless. The instruction rides AFTER capping so
      // it can never be truncated away, and only when redaction is active.
      if (names.length > 0) {
        capped.text +=
          "\n\n[REDACTION] Party names appear as [PARTY 1], [PARTY 2], … " +
          "Refer to every party ONLY by its placeholder, exactly as written; " +
          "never invent, guess, or paraphrase a party name.";
      }
      return capped.text;
    },
    namesInAssignmentOrder() {
      const byIndex = [...placeholders.entries()].sort((a, b) => {
        const na = Number(a[1].match(/\d+/)![0]);
        const nb = Number(b[1].match(/\d+/)![0]);
        return na - nb;
      });
      return byIndex.map(([key]) => originalOf.get(key) ?? key);
    },
    disclosures() {
      return {
        cappedStages: [...cappedStages],
        droppedPassages,
        redactedPartyCount: redactionCounter,
      };
    },
  };
}
