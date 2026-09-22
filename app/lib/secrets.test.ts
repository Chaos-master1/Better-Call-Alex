/**
 * Secrets guard (Phase A) — the cloud API key must never enter code or
 * git. Two tiers:
 *
 *   1. No tracked file may contain a CREDENTIAL-SHAPED literal (sk-…,
 *      long bearer tokens). This catches the actual leak: a pasted key
 *      value committed by accident.
 *   2. The variable NAME `ALEX_CLOUD_API_KEY` may appear only in
 *      `.env.example` (documentation, empty value) and in the two config
 *      seam modules that implement reading it (`app/lib/env.ts`,
 *      `app/lib/llm.ts`). A name appearing anywhere else (UI, tests,
 *      docs) signals the key is being handled outside the seam.
 *
 * Policy alone rots; a test does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Files allowed to mention the variable NAME: the config seam that reads
 *  it, the provider error text that tells the operator where to put it,
 *  its documentation, and the tests whose job is to exercise (or enforce)
 *  exactly that discipline. Test values are fakes below the credential
 *  shape threshold — no real secret ever rides on this allowance. */
const NAME_ALLOWLIST = [
  "app/lib/env.ts",
  "app/lib/llm.ts",
  ".env.example",
  "app/lib/env.test.ts",
  "app/lib/llm.test.ts",
  "app/lib/secrets.test.ts",
];

function gitGrep(args: string[]): { files: string[]; status: number } {
  try {
    const out = execFileSync("git", ["grep", "-l", "-I", ...args, "--", "."], {
      cwd: REPO,
      encoding: "utf-8",
    });
    return { files: out.split("\n").filter(Boolean), status: 0 };
  } catch (e: any) {
    // exit 1 = no matches (the passing case for tier 1)
    if (e?.status === 1) return { files: [], status: 1 };
    throw e;
  }
}

test("no credential-shaped literal is tracked in git", () => {
  const patterns = [
    "sk-[A-Za-z0-9]\\{20,\\}", // OpenAI-style keys
    "sk-proj-[A-Za-z0-9-]\\{10,\\}",
    "AQ\\.[A-Za-z0-9]\\{30,\\}", // Anthropic-style keys
    "ghp_[A-Za-z0-9]\\{20,\\}", // GitHub tokens
  ];
  const offenders: string[] = [];
  for (const p of patterns) {
    const { files } = gitGrep(["-e", p]);
    offenders.push(...files);
  }
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    `credential-shaped literals found in tracked files: ${[...new Set(offenders)].join(", ")}`
  );
});

test("ALEX_CLOUD_API_KEY is named only in the config seam + .env.example", () => {
  const { files } = gitGrep(["-F", "ALEX_CLOUD_API_KEY"]);
  const offenders = files.filter((f) => !NAME_ALLOWLIST.includes(f));
  assert.deepEqual(
    offenders,
    [],
    `key variable name found outside the config seam: ${offenders.join(", ")}`
  );
});
