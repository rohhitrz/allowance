/**
 * Pure helpers: defaults, row <-> rules mapping, read-back summary.
 * No I/O, so they're unit tested directly.
 */
import { fmt, usd } from "../money";
import type { MandateRow } from "../db/schema";
import { LOCKED_BLOCKED_CATEGORIES, type MandateRules, type Period, type PolicyMandate } from "../policy/types";

/** What the parser (or a seed / MCP client) supplies. Nulls mean "use the default". */
export type MandateDraftInput = {
  title: string;
  brief: string;
  budgetCents: number;
  hardLimitCents: number | null;
  perItemMaxCents: number | null;
  allowedCategories: string[] | null;
  extraBlockedCategories: string[];
  maxOrders: number | null;
  maxQuantity: number | null;
  noDuplicates: boolean | null;
  period: Period;
  expiresAt: string | null; // ISO
};

/** Fully resolved values ready for the mandates table. */
export type ResolvedMandate = {
  title: string;
  brief: string;
  budgetCents: number;
  hardLimitCents: number;
  perItemMaxCents: number | null;
  allowedCategories: string[] | null;
  blockedCategories: string[];
  maxOrders: number;
  maxQuantity: number;
  noDuplicates: boolean;
  period: Period;
  expiresAt: Date | null;
  timezone: string;
};

const DAY = 86_400_000;

/** docs/02-system-design.md §3.3 */
export function applyDefaults(d: MandateDraftInput, opts: { now: Date; timezone: string }): ResolvedMandate {
  if (!Number.isInteger(d.budgetCents) || d.budgetCents <= 0) throw new Error("Budget must be a positive amount");
  const hardLimit = d.hardLimitCents ?? Math.round(d.budgetCents * 1.2);
  if (hardLimit < d.budgetCents) throw new Error("Hard limit can't be below the budget");

  let expiresAt: Date | null = d.expiresAt ? new Date(d.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("Bad expiry date");
  if (d.period === "once" && !expiresAt) expiresAt = new Date(opts.now.getTime() + 7 * DAY);
  if (expiresAt && expiresAt.getTime() <= opts.now.getTime()) throw new Error("Expiry is in the past");

  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean))];
  const blocked = norm([...LOCKED_BLOCKED_CATEGORIES, ...d.extraBlockedCategories]);
  let allowed: string[] | null = null;
  if (d.allowedCategories && d.allowedCategories.length) {
    allowed = norm(d.allowedCategories).filter((c) => !blocked.includes(c));
    // Every allowed category is also blocked: refuse, rather than silently allowing anything.
    if (!allowed.length) throw new Error("Every allowed category is also blocked");
  }

  return {
    title: d.title.trim().slice(0, 120) || "Untitled mandate",
    brief: d.brief.trim() || d.title,
    budgetCents: d.budgetCents,
    hardLimitCents: hardLimit,
    perItemMaxCents: d.perItemMaxCents ?? null,
    allowedCategories: allowed,
    blockedCategories: blocked,
    maxOrders: d.maxOrders ?? (d.period === "once" ? 1 : 10),
    maxQuantity: d.maxQuantity ?? 1,
    noDuplicates: d.noDuplicates ?? true,
    period: d.period,
    expiresAt,
    timezone: opts.timezone,
  };
}

type RuleSource = Pick<
  MandateRow,
  | "budgetCents"
  | "hardLimitCents"
  | "perItemMaxCents"
  | "allowedCategories"
  | "blockedCategories"
  | "maxOrders"
  | "maxQuantity"
  | "noDuplicates"
  | "period"
  | "expiresAt"
  | "timezone"
>;

export function toRules(m: RuleSource): MandateRules {
  return {
    budget: usd(m.budgetCents),
    hardLimit: usd(m.hardLimitCents),
    ...(m.perItemMaxCents !== null ? { perItemMax: usd(m.perItemMaxCents) } : {}),
    ...(m.allowedCategories ? { allowedCategories: m.allowedCategories } : {}),
    blockedCategories: m.blockedCategories,
    maxOrders: m.maxOrders,
    maxQuantity: m.maxQuantity,
    noDuplicates: m.noDuplicates,
    period: m.period,
    ...(m.expiresAt ? { expiresAt: m.expiresAt.toISOString() } : {}),
    timezone: m.timezone,
  };
}

export function toPolicyMandate(m: RuleSource & Pick<MandateRow, "status">): PolicyMandate {
  return {
    status: m.status,
    budgetCents: m.budgetCents,
    hardLimitCents: m.hardLimitCents,
    perItemMaxCents: m.perItemMaxCents,
    allowedCategories: m.allowedCategories,
    blockedCategories: m.blockedCategories,
    maxOrders: m.maxOrders,
    maxQuantity: m.maxQuantity,
    noDuplicates: m.noDuplicates,
    expiresAt: m.expiresAt,
  };
}

const human = (c: string) => c.replace(/_/g, " ");

function listJoin(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;
}

/** The read-back sentence. Template text, never model text. */
export function summarize(m: ResolvedMandate | (RuleSource & { title: string })): string {
  const parts: string[] = [`aim for ${fmt(m.budgetCents)}`, `never more than ${fmt(m.hardLimitCents)}`];
  if (m.period === "once") {
    parts.push(m.maxOrders === 1 ? "one purchase" : `up to ${m.maxOrders} purchases`);
  } else {
    parts[0] = `${fmt(m.budgetCents)} a ${m.period === "weekly" ? "week" : "month"}`;
    parts.push(`up to ${m.maxOrders} orders a ${m.period === "weekly" ? "week" : "month"}`);
  }
  if (m.perItemMaxCents !== null) parts.push(`no single item over ${fmt(m.perItemMaxCents)}`);
  if (m.allowedCategories?.length) parts.push(`only ${listJoin(m.allowedCategories.map(human))}`);
  parts.push(`no ${listJoin(m.blockedCategories.map(human))}`);
  if (m.expiresAt) {
    const when = m.expiresAt.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: m.timezone,
    });
    parts.push(`until ${when}`);
  }
  return `${m.title}: ${parts.join(", ")}. Should I start?`;
}
