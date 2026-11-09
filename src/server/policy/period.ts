/**
 * Spend windows. Pure: callers pass `now`.
 *   once    -> the mandate's whole life (window starts at mandate creation)
 *   weekly  -> Monday 00:00 in the mandate's timezone
 *   monthly -> the 1st, 00:00 in the mandate's timezone
 */
import type { Period } from "./types";

/** Offset of `tz` from UTC at instant `at`, in minutes (Asia/Kolkata -> 330). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -mins : mins;
}

/** Wall-clock parts of `at` in `tz`. */
function localParts(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday };
}

/** UTC instant of local midnight on y-m-d in tz. */
function localMidnight(tz: string, year: number, month: number, day: number): Date {
  const guess = Date.UTC(year, month - 1, day);
  // Offset can differ across DST; resolve using the offset at the candidate instant.
  const first = guess - tzOffsetMinutes(tz, new Date(guess)) * 60_000;
  return new Date(guess - tzOffsetMinutes(tz, new Date(first)) * 60_000);
}

export function periodStart(args: { period: Period; timezone: string; mandateCreatedAt: Date; now: Date }): Date {
  const { period, timezone: tz, now } = args;
  if (period === "once") return args.mandateCreatedAt;
  const p = localParts(tz, now);
  if (period === "monthly") return localMidnight(tz, p.year, p.month, 1);
  const daysSinceMonday = (p.weekday + 6) % 7;
  return localMidnight(tz, p.year, p.month, p.day - daysSinceMonday);
}

/** End of the window (exclusive), or null for "once". */
export function periodEnd(args: { period: Period; timezone: string; start: Date }): Date | null {
  const { period, timezone: tz, start } = args;
  if (period === "once") return null;
  // start is local midnight; step forward in local calendar terms.
  const p = localParts(tz, start);
  if (period === "monthly") return localMidnight(tz, p.year, p.month + 1, 1);
  return localMidnight(tz, p.year, p.month, p.day + 7);
}
