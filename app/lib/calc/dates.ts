/**
 * Deterministic date calculators (CLAUDE.md §5.7).
 * Pure code — never an LLM call. Used for SOL, deadlines, tolling.
 */

/** YYYY-MM-DD → Date (UTC). Returns null on bad format. */
export function parseISO(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  // guard overflow (e.g. 2023-02-30 → Mar 2)
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add calendar days, UTC. */
export function addDays(iso: string, days: number): string | null {
  const d = parseISO(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d);
}

/** Days between a and b (b - a), signed. */
export function daysBetween(aISO: string, bISO: string): number | null {
  const a = parseISO(aISO);
  const b = parseISO(bISO);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
// NOTE: signed on purpose — callers compute "days until deadline" as
// daysBetween(deadline, today) and want negative to mean "past due".

/** US federal holidays for a year, as ISO date strings (the actual day, plus the
 *  observed day when a fixed-date holiday lands on a weekend: Saturday → Friday
 *  before, Sunday → Monday after — 5 U.S.C. § 6103(b)). Computed, not stored:
 *  the rules are arithmetic (nth-weekday / last-weekday / fixed), so no data
 *  source and no staleness. Juneteenth included from 2021 onward. */
export function federalHolidays(year: number): Set<string> {
  const nthWeekday = (month: number, weekday: number, n: number) => {
    const d = new Date(Date.UTC(year, month, 1));
    while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCDate(d.getUTCDate() + 7 * (n - 1));
    return new Date(d);
  };
  const lastWeekday = (month: number, weekday: number) => {
    const d = new Date(Date.UTC(year, month + 1, 0));
    while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
    return new Date(d);
  };
  const fixed = (month: number, day: number) => new Date(Date.UTC(year, month, day));

  const actual: Date[] = [
    fixed(0, 1),          // New Year's Day
    nthWeekday(0, 1, 3),   // MLK Day — 3rd Monday of January
    nthWeekday(1, 1, 3),   // Washington's Birthday — 3rd Monday of February
    lastWeekday(4, 1),     // Memorial Day — last Monday of May
    fixed(6, 4),           // Independence Day
    nthWeekday(8, 1, 1),   // Labor Day — 1st Monday of September
    nthWeekday(9, 1, 2),   // Columbus Day — 2nd Monday of October
    fixed(10, 11),         // Veterans Day
    nthWeekday(10, 4, 4),  // Thanksgiving — 4th Thursday of November
    fixed(11, 25),         // Christmas
  ];
  if (year >= 2021) actual.push(fixed(5, 19)); // Juneteenth — federal from 2021

  const out = new Set<string>();
  for (const d0 of actual) {
    const d = new Date(d0);
    const dow = d.getUTCDay();
    out.add(toISO(d));
    if (dow === 6) {
      d.setUTCDate(d.getUTCDate() - 1);
      out.add(toISO(d));
    } else if (dow === 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      out.add(toISO(d));
    }
  }
  return out;
}

/** Roll forward to next business day: skips weekends and US federal holidays
 *  (G4 gate: "weekend/holiday rolls"). Deterministic. */
export function nextBusinessDay(iso: string): string | null {
  const d = parseISO(iso);
  if (!d) return null;
  const cache = new Map<number, Set<string>>();
  const holidays = (y: number) => {
    if (!cache.has(y)) cache.set(y, federalHolidays(y));
    return cache.get(y)!;
  };
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (
    d.getUTCDay() === 0 ||
    d.getUTCDay() === 6 ||
    holidays(d.getUTCFullYear()).has(toISO(d))
  );
  return toISO(d);
}

/** Is the interval [start, cutoff) expired as of `asOf`? The deadline is the
 *  anniversary of `start` + `years` years; when the anniversary day does not
 *  exist (Feb 29 → non-leap year), the deadline is the LAST day of the
 *  anniversary month (Feb 28), not the JS-default overflow to Mar 1 — the
 *  common anniversary convention, and the stricter SOL reading. */
export function isExpired(startISO: string, years: number, asOfISO: string): boolean | null {
  const start = parseISO(startISO);
  const asOf = parseISO(asOfISO);
  if (!start || !asOf) return null;
  const y = start.getUTCFullYear() + years;
  const m = start.getUTCMonth();
  const day = start.getUTCDate();
  const deadline = new Date(start);
  deadline.setUTCFullYear(y);
  if (deadline.getUTCMonth() !== m) {
    // JS overflowed the month (Feb 29 → Mar 1): clamp to month end.
    deadline.setUTCFullYear(y, m + 1, 0);
  }
  return asOf.getTime() > deadline.getTime();
}
