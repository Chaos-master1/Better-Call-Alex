/**
 * G2 fixture gate (CLAUDE.md §8): every adversarial fixture MUST be
 * rejected; every control MUST pass with its expected annotations.
 * 100% fabrication catch rate is the release gate.
 *
 *   pnpm g2
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { openCorpus } from "../app/lib/db.js";
import { verifyText } from "../app/lib/verify/verify.js";

const REPO = path.resolve(import.meta.dirname, "..");
const GOLDEN = path.join(REPO, "verifier", "fixtures", "golden.json");

interface Fixture {
  id: string;
  category: string;
  text: string;
  expect_overall: "pass" | "fail";
  expect_contains: string[];
}

function main() {
  const spec = JSON.parse(readFileSync(GOLDEN, "utf-8")) as { cases: Fixture[] };
  const db = openCorpus();
  let caught = 0;
  let adversarial = 0;
  const failures: string[] = [];

  try {
    console.log("case".padEnd(26), "expect", "got  ", "checks");
    for (const f of spec.cases) {
      const report = verifyText(db, f.text);
      const serialized = JSON.stringify(report);

      if (f.expect_overall === "fail") adversarial++;
      if (report.overall === "fail") caught++;

      const missingChecks = f.expect_contains.filter((s) => !serialized.includes(s));
      const ok =
        report.overall === f.expect_overall && missingChecks.length === 0;

      if (!ok) {
        failures.push(
          `${f.id}: expected overall=${f.expect_overall}, got ${report.overall}` +
            (missingChecks.length
              ? `; missing [${missingChecks.join(", ")}]`
              : "")
        );
      }

      console.log(
        f.id.padEnd(26),
        f.expect_overall.padEnd(6),
        report.overall.padEnd(6),
        ok ? "ok" : `MISSING ${missingChecks.join(",")}`
      );
      if (!ok) {
        console.log("    citations:",
          report.citations.map((c) => `${c.form}:${c.status}`).join(" ") || "-");
        console.log("    quotes:",
          report.quotes.map((q) => q.status).join(" ") || "-");
      }
    }

    const rate = adversarial ? ((caught / adversarial) * 100).toFixed(1) : "n/a";
    console.log(
      `\nfabrication catch rate: ${caught}/${adversarial} (${rate}%) — gate requires 100%`
    );
    if (failures.length) {
      console.error("\nFAILURES:");
      for (const f of failures) console.error("  " + f);
      process.exit(1);
    }
    if (adversarial > 0 && caught !== adversarial) process.exit(1);
    console.log("G2 FIXTURE GATE: PASS");
  } finally {
    db.close();
  }
}

main();
