/**
 * Unit tests for the deterministic date calculators (CLAUDE.md §5.7).
 * The G4 gate names the exact cases: leap years, weekend/holiday rolls, tolling.
 * Pure code, no LLM — these functions feed SOL/deadline math that a lawyer
 * would rely on, so edge behavior is asserted, not assumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseISO,
  toISO,
  addDays,
  daysBetween,
  nextBusinessDay,
  isBusinessDay,
  filingDate,
  isExpired,
  federalHolidays,
  solDeadline,
} from "./dates.js";

// ——— parseISO: format + overflow guards ———

test("parseISO accepts a real date", () => {
  const d = parseISO("2026-08-30");
  assert.ok(d);
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 7);
  assert.equal(d.getUTCDate(), 30);
});

test("parseISO rejects garbage", () => {
  for (const bad of ["", "not-a-date", "2026/08/30", "26-08-30", "2026-8-30", "2026-08-30T00:00:00Z"]) {
    assert.equal(parseISO(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("parseISO rejects impossible dates (overflow guard)", () => {
  assert.equal(parseISO("2023-02-30"), null);
  assert.equal(parseISO("2026-13-01"), null);
  assert.equal(parseISO("2026-00-10"), null);
  assert.equal(parseISO("2026-08-32"), null);
});

test("parseISO rejects bad LEAP inputs: Feb 29 in a non-leap year", () => {
  // 2100 is divisible by 100 but not 400 → NOT a leap year (the classic trap)
  assert.equal(parseISO("2100-02-29"), null);
  // 2000 is divisible by 400 → leap
  assert.ok(parseISO("2000-02-29"));
  // 2023 is a common year
  assert.equal(parseISO("2023-02-29"), null);
  // 2024 is a normal leap year
  assert.ok(parseISO("2024-02-29"));
});

// ——— toISO round-trip ———

test("toISO formats UTC midnight", () => {
  assert.equal(toISO(new Date(Date.UTC(2026, 7, 30))), "2026-08-30");
});

// ——— addDays: month/year boundaries ———

test("addDays crosses month end", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
});

test("addDays crosses year end", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("addDays handles February correctly in leap vs non-leap years", () => {
  // +1 day from Feb 28 in a leap year lands on Feb 29
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  // in a non-leap year it lands on Mar 1
  assert.equal(addDays("2023-02-28", 1), "2023-03-01");
  // 400-year leap (2000) and 100-year non-leap (2100)
  assert.equal(addDays("2000-02-28", 1), "2000-02-29");
  assert.equal(addDays("2100-02-28", 1), "2100-03-01");
});

test("addDays counts SOL spans: 2 years back from an incident", () => {
  assert.equal(addDays("2026-08-30", -730), "2024-08-30");
});

test("addDays rejects bad input", () => {
  assert.equal(addDays("garbage", 5), null);
});

// ——— daysBetween ———

test("daysBetween is signed (b - a)", () => {
  assert.equal(daysBetween("2026-08-01", "2026-08-31"), 30);
  assert.equal(daysBetween("2026-08-31", "2026-08-01"), -30);
});

test("daysBetween rejects bad input", () => {
  assert.equal(daysBetween("bad", "2026-01-01"), null);
  assert.equal(daysBetween("2026-01-01", "bad"), null);
});

// ——— nextBusinessDay: weekend and holiday rolls ———

test("nextBusinessDay rolls Friday → Monday (skips the weekend)", () => {
  // 2026-08-28 is a Friday; next business day must skip Sat/Sun
  assert.equal(nextBusinessDay("2026-08-28"), "2026-08-31");
});

test("nextBusinessDay rolls Saturday and Sunday → Monday", () => {
  assert.equal(nextBusinessDay("2026-08-29"), "2026-08-31"); // Sat
  assert.equal(nextBusinessDay("2026-08-30"), "2026-08-31"); // Sun
});

test("nextBusinessDay is Tuesday when Monday is a holiday", () => {
  // 2026-09-07 is Labor Day (first Monday of September). 2026-09-04 is a Friday;
  // next business day must skip the weekend AND the holiday → 09-08 (Tue).
  assert.equal(nextBusinessDay("2026-09-04"), "2026-09-08");
});

test("nextBusinessDay skips a mid-week holiday (July 4 on a Friday, observed)", () => {
  // 2026-07-03 is Friday; 2026-07-04 (Saturday) is observed on Friday 07-03.
  // From 07-02 (Thursday), the next business day is Monday 07-06.
  assert.equal(nextBusinessDay("2026-07-02"), "2026-07-06");
});

test("federalHolidays computes the observed day when a fixed holiday lands on Sunday", () => {
  // 2027-07-04 is a Sunday → observed Monday 2027-07-05.
  const h = federalHolidays(2027);
  assert.ok(h.has("2027-07-05"));
});

test("nextBusinessDay handles year-boundary weekends", () => {
  // 2027-01-01 is a Friday; 2027-01-02/03 weekend → Monday 2027-01-04
  assert.equal(nextBusinessDay("2027-01-01"), "2027-01-04");
});

test("nextBusinessDay skips the cross-year observed New Year's Day", () => {
  // Jan 1 2022 is a Saturday → observed Friday 2021-12-31 (5 U.S.C. § 6103(b)).
  // Rolling from Thursday 2021-12-30 must NOT land on the closed 12-31:
  // 12-31 (observed holiday) → 01-01 Sat → 01-02 Sun → Monday 01-03.
  assert.equal(nextBusinessDay("2021-12-30"), "2022-01-03");
  // The observed day must live in the year it FALLS in, not the holiday's year.
  assert.ok(federalHolidays(2021).has("2021-12-31"));
  assert.ok(!federalHolidays(2022).has("2021-12-31"));
});

test("nextBusinessDay runs the Christmas-observed weekend chain", () => {
  // Dec 25 2021 is a Saturday → observed Friday 12-24. From Thursday 12-23:
  // 12-24 (observed) → 12-25 Sat → 12-26 Sun → Monday 12-27.
  assert.equal(nextBusinessDay("2021-12-23"), "2021-12-27");
});

test("nextBusinessDay skips Juneteenth observed on Friday", () => {
  // Juneteenth 2021-06-19 is a Saturday → observed Friday 06-18.
  // From Thursday 06-17: 06-18 (observed) → 06-19 Sat → 06-20 Sun → Mon 06-21.
  assert.equal(nextBusinessDay("2021-06-17"), "2021-06-21");
});

test("nextBusinessDay skips Veterans Day observed on Monday", () => {
  // Veterans Day 2018-11-11 is a Sunday → observed Monday 11-12.
  // From Friday 11-09: 11-10 Sat → 11-11 Sun → 11-12 (observed) → Tue 11-13.
  assert.equal(nextBusinessDay("2018-11-09"), "2018-11-13");
});

// ——— isExpired: SOL with optional tolling ———

test("isExpired: before the SOL window → not expired", () => {
  assert.equal(isExpired("2024-08-30", 2, "2026-08-29"), false);
});

test("isExpired: last day inside the window → not expired", () => {
  assert.equal(isExpired("2024-08-30", 2, "2026-08-30"), false);
});

test("isExpired: first day past the window → expired", () => {
  assert.equal(isExpired("2024-08-30", 2, "2026-08-31"), true);
});

test("isExpired is exact across a leap-year boundary", () => {
  // 2-year SOL from 2024-02-29 (leap): 2025-02-28 is inside, 2025-03-01 out
  assert.equal(isExpired("2024-02-29", 1, "2025-02-28"), false);
  assert.equal(isExpired("2024-02-29", 1, "2025-03-01"), true);
});

test("isExpired rejects bad input", () => {
  assert.equal(isExpired("bad", 2, "2026-01-01"), null);
});

// ——— solDeadline: SOL with tolling ———

test("solDeadline with no tolling equals the anniversary", () => {
  // 2-year SOL from 2024-01-01 → 2026-01-01 (unrolled)
  assert.equal(solDeadline("2024-01-01", 2), "2026-01-01");
});

test("solDeadline clamps Feb 29 starts to the month end", () => {
  assert.equal(solDeadline("2024-02-29", 1), "2025-02-28");
});

test("solDeadline rejects fractional years and bad input", () => {
  assert.equal(solDeadline("2024-01-01", 1.5), null);
  assert.equal(solDeadline("bad", 2), null);
});

test("solDeadline extends day-for-day by a tolling window inside the period", () => {
  // 2-year SOL from 2024-01-01 → 2026-01-01. Defendant outside the forum
  // from 2024-06-01 to 2024-08-31 = 92 days → deadline 2026-01-01 + 92d.
  assert.equal(
    solDeadline("2024-01-01", 2, [{ start: "2024-06-01", end: "2024-08-31" }]),
    "2026-04-03"
  );
});

test("solDeadline converges when a window straddles the original deadline", () => {
  // Window 2025-12-01..2026-01-15 (46 days). First pass counts only the
  // December part (31d); the extension pulls January back inside the
  // period; second pass counts the full 46 → 2026-01-01 + 46d = 2026-02-16.
  assert.equal(
    solDeadline("2024-01-01", 2, [{ start: "2025-12-01", end: "2026-01-15" }]),
    "2026-02-16"
  );
});

test("solDeadline counts overlapping windows once (union)", () => {
  // Two windows sharing 2024-06-15..2024-07-14: union = 2024-06-01..2024-07-31 = 61 days.
  assert.equal(
    solDeadline("2024-01-01", 2, [
      { start: "2024-06-01", end: "2024-07-14" },
      { start: "2024-06-15", end: "2024-07-31" },
    ]),
    "2026-03-03"
  );
});

test("solDeadline ignores windows entirely outside the period", () => {
  // Tolling before accrual or after the deadline has no effect.
  assert.equal(
    solDeadline("2024-01-01", 2, [
      { start: "2023-01-01", end: "2023-12-31" },
      { start: "2027-01-01", end: "2027-12-31" },
    ]),
    "2026-01-01"
  );
});

test("solDeadline skips malformed windows", () => {
  assert.equal(
    solDeadline("2024-01-01", 2, [
      { start: "bad", end: "2024-08-31" },
      { start: "2024-08-31", end: "2024-06-01" }, // reversed
      { start: "2024-06-01", end: "2024-08-31" }, // the real one (92d)
    ]),
    "2026-04-03"
  );
});

test("solDeadline composes with nextBusinessDay for the filing date", () => {
  // 2026-01-01 is a federal holiday (New Year's Day, Thursday): the filing
  // deadline rolls to Friday 2026-01-02.
  assert.equal(nextBusinessDay(solDeadline("2024-01-01", 2) ?? ""), "2026-01-02");
});

// ——— Phase 3 hardening: null-never-throw, open-deadline composition ———

test("parseISO/addDays return null on non-string and non-finite input", () => {
  assert.equal(parseISO(null as unknown as string), null);
  assert.equal(parseISO(20240101 as unknown as string), null);
  assert.equal(addDays("2024-01-01", NaN), null);
  assert.equal(addDays("2024-01-01", Infinity), null);
  assert.equal(addDays("bad", 5), null);
});

test("federalHolidays rejects non-integer years loudly", () => {
  assert.throws(() => federalHolidays(NaN), RangeError);
  assert.throws(() => federalHolidays(2024.5), RangeError);
});

test("solDeadline ignores non-array tolling instead of throwing", () => {
  assert.equal(
    solDeadline("2024-01-01", 2, "2024-06-01" as unknown as []),
    "2026-01-01"
  );
});

test("solDeadline converges past 8 disjoint windows (old silent cap)", () => {
  const windows = [];
  for (let m = 0; m < 10; m++) {
    const mm = String(m + 1).padStart(2, "0");
    windows.push({ start: `2024-${mm}-01`, end: `2024-${mm}-10` });
  }
  // 10 × 10-day windows = 100 days past the 2026-01-01 anniversary.
  assert.equal(solDeadline("2024-01-01", 2, windows), "2026-04-11");
});

test("filingDate keeps an open deadline, rolls a closed one", () => {
  assert.equal(filingDate("2026-01-02"), "2026-01-02"); // Friday, open
  assert.equal(filingDate("2026-01-01"), "2026-01-02"); // holiday → Friday
  assert.equal(filingDate("2026-01-03"), "2026-01-05"); // Saturday → Monday
  assert.equal(filingDate("bad"), null);
  assert.equal(isBusinessDay("2026-01-01"), false);
  assert.equal(isBusinessDay("2026-01-02"), true);
  assert.equal(isBusinessDay("bad"), null);
});
