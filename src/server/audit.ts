/**
 * Independent audit of a mandate: recompute, straight from the purchases table, whether any
 * money moved (or is held) outside the mandate's hard rules. It shares no code with the
 * policy engine on purpose, so it can catch the engine being wrong, bypassed or raced.
 *
 * What it checks is exactly the list in `checks` below, and `notChecked` says what it doesn't.
 * Two kinds of check:
 *   - per purchase (category, quantity, per-item price, expiry): every purchase the engine let
 *     through, whatever happened to it later. A forbidden item that was charged and then
 *     refunded, or authorized and then voided, is still a broken rule.
 *   - per window (hard limit, order count, duplicates): purchases holding money right now,
 *     because voids and refunds legitimately free budget.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { approvals, mandates, purchases } from "./db/schema";
import { AppError } from "./errors";
import { fmt } from "./money";

/** `offenders`: the purchase ids that break this check. */
export type AuditCheck = { name: string; ok: boolean; detail: string; offenders: string[] };
export type Audit = { mandateId: string; checkedAt: string; purchases: number; violations: number; checks: AuditCheck[]; notChecked: string[] };

/** Money is committed while a purchase is in one of these states. */
const LIVE = new Set(["RESERVED", "AUTHORIZED", "HELD", "CAPTURED"]);
/** The engine stopped these before PayPal. Everything else got past the rules. */
const STOPPED = new Set(["BLOCKED", "PROPOSED"]);
/** The app's clock and the database's can differ a little; don't call that an expiry breach. */
const CLOCK_SLACK_MS = 60_000;

const NOT_CHECKED = [
  "whether spend or order count was over the limit at some earlier moment and later freed by a void or refund",
  "purchases made while the mandate was frozen (each unfreeze starts a new mandate version, which the capture re-check enforces)",
  "anything outside this app's purchase records, such as charges made directly in PayPal",
];

export async function auditMandate(mandateId: string): Promise<Audit> {
  const [m] = await db().select().from(mandates).where(eq(mandates.id, mandateId));
  if (!m) throw new AppError("NOT_FOUND", `Unknown mandate ${mandateId}`);
  const rows = await db().select().from(purchases).where(eq(purchases.mandateId, mandateId));
  const decided = rows.length
    ? await db().select().from(approvals).where(inArray(approvals.purchaseId, rows.map((r) => r.id)))
    : [];
  const approvalFor = new Map(decided.map((a) => [a.purchaseId, a]));
  const live = rows.filter((r) => LIVE.has(r.status));
  const passed = rows.filter((r) => !STOPPED.has(r.status));

  // Spend and order count per period window (a recurring mandate resets each window).
  const windows = new Map<number, { cents: number; orders: number }>();
  for (const r of live) {
    const k = r.periodStart.getTime();
    const w = windows.get(k) ?? { cents: 0, orders: 0 };
    windows.set(k, { cents: w.cents + r.totalCents, orders: w.orders + 1 });
  }
  const worst = [...windows.values()].reduce((a, w) => ({ cents: Math.max(a.cents, w.cents), orders: Math.max(a.orders, w.orders) }), { cents: 0, orders: 0 });
  const overLimit = live.filter((r) => (windows.get(r.periodStart.getTime())?.cents ?? 0) > m.hardLimitCents);
  const overOrders = live.filter((r) => (windows.get(r.periodStart.getTime())?.orders ?? 0) > m.maxOrders);

  const blocked = new Set(m.blockedCategories);
  const inBlocked = passed.filter((r) => blocked.has(r.productCategory));
  const overQty = passed.filter((r) => r.quantity > m.maxQuantity);
  const overItem = m.perItemMaxCents === null ? [] : passed.filter((r) => r.unitPriceCents > m.perItemMaxCents!);
  const afterExpiry = m.expiresAt === null ? [] : passed.filter((r) => r.createdAt.getTime() > m.expiresAt!.getTime() + CLOCK_SLACK_MS);
  // Same product held twice in one window.
  const seen = new Map<string, number>();
  for (const r of live) seen.set(`${r.periodStart.getTime()}|${r.productId}`, (seen.get(`${r.periodStart.getTime()}|${r.productId}`) ?? 0) + 1);
  const dupes = m.noDuplicates ? live.filter((r) => (seen.get(`${r.periodStart.getTime()}|${r.productId}`) ?? 0) > 1) : [];
  const blockedButPaid = rows.filter((r) => r.status === "BLOCKED" && (r.paypalCalled || r.paypalOrderId || r.paypalAuthorizationId || r.paypalCaptureId));
  // A purchase the rules sent to a human must not be captured without a human's "approve".
  const capturedWithoutConsent = rows.filter((r) => {
    if (r.decision !== "HOLD" || !["CAPTURED", "REFUNDED"].includes(r.status)) return false;
    const a = approvalFor.get(r.id);
    return !(a?.status === "APPROVED" && a.decidedBy?.startsWith("user:"));
  });
  const names = (list: typeof rows) => list.map((r) => `${r.quantity} × ${r.productName} (${r.status.toLowerCase()})`).join(", ");
  const ids = (list: typeof rows) => list.map((r) => r.id);
  const check = (name: string, bad: typeof rows, okDetail: string, badDetail = names(bad)): AuditCheck => ({
    name,
    ok: bad.length === 0,
    detail: bad.length ? badDetail : okDetail,
    offenders: ids(bad),
  });
  const per = m.period === "once" ? "mandate" : m.period === "weekly" ? "week" : "month";

  const checks: AuditCheck[] = [
    check("Never over the hard limit", overLimit, `${fmt(worst.cents)} committed at most, limit ${fmt(m.hardLimitCents)}`, `${fmt(worst.cents)} committed, limit ${fmt(m.hardLimitCents)}: ${names(overLimit)}`),
    check("Nothing from a blocked category", inBlocked, `none of: ${m.blockedCategories.join(", ")}, including refunded or voided purchases`),
    check("Never more orders than allowed", overOrders, `${worst.orders} at most, ${m.maxOrders} allowed per ${per}`, `${worst.orders} orders, ${m.maxOrders} allowed per ${per}`),
    check("Never more than the allowed quantity", overQty, `at most ${m.maxQuantity} per order, including refunded or voided purchases`),
    ...(m.perItemMaxCents === null ? [] : [check("No item over the per-item maximum", overItem, `at most ${fmt(m.perItemMaxCents)} each`)]),
    ...(m.noDuplicates ? [check("No product bought twice", dupes, `no product held twice in one ${per}`)] : []),
    ...(m.expiresAt === null ? [] : [check("Nothing bought after the mandate expired", afterExpiry, `all before ${m.expiresAt.toISOString()}`)]),
    check("Blocked attempts never reached PayPal", blockedButPaid, `${rows.filter((r) => r.status === "BLOCKED").length} blocked, none touched PayPal`, `${blockedButPaid.length} blocked purchase(s) touched PayPal: ${names(blockedButPaid)}`),
    check("Nothing over budget was paid without your approval", capturedWithoutConsent, "every held purchase that was paid has a human approval on record"),
  ];
  return { mandateId, checkedAt: new Date().toISOString(), purchases: rows.length, violations: checks.filter((c) => !c.ok).length, checks, notChecked: NOT_CHECKED };
}
