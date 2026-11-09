/**
 * Independent audit of a mandate: recompute, straight from the purchases table, whether any
 * money moved (or is held) outside the mandate's hard rules. It shares no code with the
 * policy engine on purpose, so it can catch the engine being wrong, bypassed or raced.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { approvals, mandates, purchases } from "./db/schema";
import { AppError } from "./errors";
import { fmt } from "./money";

export type AuditCheck = { name: string; ok: boolean; detail: string };
export type Audit = { mandateId: string; checkedAt: string; purchases: number; violations: number; checks: AuditCheck[] };

/** Money is committed while a purchase is in one of these states. */
const LIVE = new Set(["RESERVED", "AUTHORIZED", "HELD", "CAPTURED"]);

export async function auditMandate(mandateId: string): Promise<Audit> {
  const [m] = await db().select().from(mandates).where(eq(mandates.id, mandateId));
  if (!m) throw new AppError("NOT_FOUND", `Unknown mandate ${mandateId}`);
  const rows = await db().select().from(purchases).where(eq(purchases.mandateId, mandateId));
  const decided = rows.length
    ? await db().select().from(approvals).where(inArray(approvals.purchaseId, rows.map((r) => r.id)))
    : [];
  const approvalFor = new Map(decided.map((a) => [a.purchaseId, a]));
  const live = rows.filter((r) => LIVE.has(r.status));

  // Spend and order count per period window (a recurring mandate resets each window).
  const windows = new Map<number, { cents: number; orders: number }>();
  for (const r of live) {
    const k = r.periodStart.getTime();
    const w = windows.get(k) ?? { cents: 0, orders: 0 };
    windows.set(k, { cents: w.cents + r.totalCents, orders: w.orders + 1 });
  }
  const worst = [...windows.values()].reduce((a, w) => ({ cents: Math.max(a.cents, w.cents), orders: Math.max(a.orders, w.orders) }), { cents: 0, orders: 0 });

  const blocked = new Set(m.blockedCategories);
  const inBlocked = live.filter((r) => blocked.has(r.productCategory));
  const overQty = live.filter((r) => r.quantity > m.maxQuantity);
  const overItem = m.perItemMaxCents === null ? [] : live.filter((r) => r.unitPriceCents > m.perItemMaxCents!);
  const blockedButPaid = rows.filter((r) => r.status === "BLOCKED" && (r.paypalCalled || r.paypalOrderId || r.paypalAuthorizationId || r.paypalCaptureId));
  // A purchase the rules sent to a human must not be captured without a human's "approve".
  const capturedWithoutConsent = rows.filter((r) => {
    if (r.decision !== "HOLD" || !["CAPTURED", "REFUNDED"].includes(r.status)) return false;
    const a = approvalFor.get(r.id);
    return !(a?.status === "APPROVED" && a.decidedBy?.startsWith("user:"));
  });
  const names = (list: typeof rows) => list.map((r) => `${r.quantity} × ${r.productName}`).join(", ");

  const checks: AuditCheck[] = [
    {
      name: "Never over the hard limit",
      ok: worst.cents <= m.hardLimitCents,
      detail: `${fmt(worst.cents)} committed at most, limit ${fmt(m.hardLimitCents)}`,
    },
    {
      name: "Nothing from a blocked category",
      ok: inBlocked.length === 0,
      detail: inBlocked.length ? names(inBlocked) : `none of: ${m.blockedCategories.join(", ")}`,
    },
    {
      name: "Never more orders than allowed",
      ok: worst.orders <= m.maxOrders,
      detail: `${worst.orders} at most, ${m.maxOrders} allowed per ${m.period === "once" ? "mandate" : m.period === "weekly" ? "week" : "month"}`,
    },
    { name: "Never more than the allowed quantity", ok: overQty.length === 0, detail: overQty.length ? names(overQty) : `at most ${m.maxQuantity} per order` },
    ...(m.perItemMaxCents === null
      ? []
      : [{ name: "No item over the per-item maximum", ok: overItem.length === 0, detail: overItem.length ? names(overItem) : `at most ${fmt(m.perItemMaxCents)} each` }]),
    {
      name: "Blocked attempts never reached PayPal",
      ok: blockedButPaid.length === 0,
      detail: `${rows.filter((r) => r.status === "BLOCKED").length} blocked, ${blockedButPaid.length} of them touched PayPal`,
    },
    {
      name: "Nothing over budget was paid without your approval",
      ok: capturedWithoutConsent.length === 0,
      detail: capturedWithoutConsent.length ? names(capturedWithoutConsent) : "every held purchase that was paid has a human approval on record",
    },
  ];
  return { mandateId, checkedAt: new Date().toISOString(), purchases: rows.length, violations: checks.filter((c) => !c.ok).length, checks };
}
