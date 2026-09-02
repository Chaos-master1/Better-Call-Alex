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
// NOTE: signed on purpose (b - a) — "days until deadline" is
// daysBetween(today, deadline), which goes negative once the deadline
// has passed.

/** US federal holidays for a year, as ISO date strings: the set of days
 *  federal offices are closed during that calendar year — each actual day,
 *  plus the observed day when a fixed-date holiday lands on a weekend:
 *  Saturday → Friday before, Sunday → Monday after (5 U.S.C. § 6103(b)).
 *  The observed day lives in the year it FALLS in, not the year of the
 *  holiday: New Year's Day of year+1 on a Saturday is observed Friday,
 *  Dec 31 of `year`, and closure checks consult only the date's own year's
 *  set. Computed, not stored: the rules are arithmetic (nth-weekday /
 *  last-weekday / fixed), so no data source and no staleness. Juneteenth
 *  included from 2021 onward. */
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
      const obs = new Date(d);
      obs.setUTCDate(obs.getUTCDate() - 1);
      // New Year's observed on Friday lands in the previous calendar year;
      // that year's set owns it (added by the year+1 rule below).
      if (obs.getUTCFullYear() === year) out.add(toISO(obs));
    } else if (dow === 0) {
      const obs = new Date(d);
      obs.setUTCDate(obs.getUTCDate() + 1);
      out.add(toISO(obs));
    }
  }
  // New Year's Day of year+1 on a Saturday → observed Friday, Dec 31 of
  // this year. Without this, a roll spanning the year boundary walks
  // straight onto a closed federal office.
  const jan1Next = new Date(Date.UTC(year + 1, 0, 1));
  if (jan1Next.getUTCDay() === 6) out.add(toISO(new Date(Date.UTC(year, 11, 31))));
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
  const deadline = anniversaryDate(startISO, years);
  const asOf = parseISO(asOfISO);
  if (!deadline || !asOf) return null;
  return asOf.getTime() > deadline.getTime();
}

/** Anniversary of `start` + `years` years, month-end clamped (Feb 29 →
 *  Feb 28). Shared by isExpired and solDeadline. */
function anniversaryDate(startISO: string, years: number): Date | null {
  const start = parseISO(startISO);
  if (!start) return null;
  if (!Number.isInteger(years)) return null; // fractional years would truncate silently
  const y = start.getUTCFullYear() + years;
  const m = start.getUTCMonth();
  const day = start.getUTCDate();
  const deadline = new Date(start);
  deadline.setUTCFullYear(y);
  if (deadline.getUTCMonth() !== m) {
    // JS overflowed the month (Feb 29 → Mar 1): clamp to month end.
    deadline.setUTCFullYear(y, m + 1, 0);
  }
  return deadline;
}

/** A period during which the limitations clock was stopped (e.g. defendant
 *  absent from the forum, statutory stay, minority of the plaintiff).
 *  INCLUSIVE of both endpoints, as a lawyer counts: "absent June 1 through
 *  August 31" is 92 days. */
export interface TollingWindow {
  start: string;
  end: string;
}

/** SOL deadline with day-for-day tolling. The base deadline is the
 *  anniversary of `start` + `years` (month-end clamped); every calendar day
 *  inside the union of `tolling` windows that falls within the running
 *  period [start, deadline) extends the deadline by one day. The extension
 *  is iterated to its fixed point: extending the deadline can pull more of
 *  a window into the period, which extends it further, until stable — so a
 *  window straddling the original deadline is fully counted, and
 *  overlapping windows are counted once (union, never double-counted).
 *
 *  Returns the UNROLLED anniversary deadline; callers that need a filing
 *  date roll it with nextBusinessDay(). Returns null on bad input. */
export function solDeadline(
  startISO: string,
  years: number,
  tolling: TollingWindow[] = []
): string | null {
  const start = parseISO(startISO);
  const base = anniversaryDate(startISO, years);
  if (!start || !base) return null;
  const DAY = 86_400_000;
  // Normalize windows: valid dates only, positive length, INCLUSIVE end
  // (the endpoint day counts), sorted for the sweep.
  const windows: Array<[number, number]> = [];
  for (const w of tolling ?? []) {
    const s = parseISO(w?.start ?? "");
    const e = parseISO(w?.end ?? "");
    if (!s || !e || e.getTime() < s.getTime()) continue;
    windows.push([s.getTime(), e.getTime() + DAY]);
  }
  windows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const unionDaysUntil = (limit: number): number => {
    // Days of the merged windows inside [start, limit).
    let days = 0;
    let cur = 0;
    for (const [s, e] of windows) {
      if (e <= cur) continue; // already merged
      const a = Math.max(s, Math.max(cur, start.getTime()));
      const b = Math.min(e, limit);
      if (b > a) days += Math.round((b - a) / DAY);
      cur = Math.max(cur, e);
      if (cur >= limit) break;
    }
    return days;
  };

  let deadline = base.getTime();
  for (let iter = 0; iter < 8; iter++) {
    const extended = base.getTime() + unionDaysUntil(deadline) * DAY;
    if (extended === deadline) break;
    deadline = extended;
  }
  return toISO(new Date(deadline));
}
