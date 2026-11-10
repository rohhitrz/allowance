/** Decision receipt = the purchase + the rules it was judged on + every event. */
import { asc, and, eq } from "drizzle-orm";
import { db } from "./db";
import { events, mandateVersions, purchases, type PurchaseRow } from "./db/schema";
import { AppError } from "./errors";
import { fmt } from "./money";
import { failedRules } from "./policy/engine";

export function receiptSummary(p: PurchaseRow): string {
  const hard = failedRules(p.ruleResults, "hard");
  const soft = failedRules(p.ruleResults, "soft");
  const what = `${p.quantity} × ${p.productName} (${fmt(p.totalCents)})`;
  if (p.recovery === "needs_review") {
    return `${p.status === "FAILED" ? "Released" : "Recorded"} ${what}, but PayPal's state couldn't be confirmed: ${p.recoveryNote ?? "check it in PayPal"}.`;
  }
  switch (p.status) {
    case "BLOCKED":
      return `Blocked by ${hard.length} hard rule${hard.length === 1 ? "" : "s"}: ${hard.map((r) => r.detail).join("; ")}. PayPal was never called.`;
    case "HELD":
      if (p.recovery === "void_retry") {
        return `Not approved: releasing ${what} is pending. PayPal hasn't confirmed the void of authorization ${p.paypalAuthorizationId} yet; it is retried until it lands, and nothing will be charged.`;
      }
      return `Held for your approval: ${soft.map((r) => r.detail).join("; ")}. PayPal authorization ${p.paypalAuthorizationId} is on hold.`;
    case "CAPTURED":
      if (p.recovery === "refund_pending") {
        return p.paypalRefundId
          ? `Refund requested for ${what}. PayPal refund ${p.paypalRefundId} is still PENDING; it counts as spent until it completes.`
          : `Refund requested for ${what}, but PayPal's answer was lost. It is being checked (never refunded twice); it counts as spent until confirmed.`;
      }
      if (p.recovery === "capture_pending") {
        return `Approved ${what}. PayPal capture ${p.paypalCaptureId} is still PENDING and can still be declined.`;
      }
      return `Approved ${what}${soft.length ? ` after your approval (${soft.map((r) => r.detail).join("; ")})` : `: passed all ${p.ruleResults.length} rules`}. PayPal captured ${p.paypalCaptureId}.`;
    case "VOIDED":
      return `Voided ${what}: ${p.failureReason ?? "authorization released"}. PayPal authorization ${p.paypalAuthorizationId} voided; no money moved.`;
    case "FAILED":
      return `PayPal failed for ${what}: ${p.failureReason}. No money moved.`;
    case "REFUNDED":
      return `Refunded ${what}. PayPal refund ${p.paypalRefundId}.`;
    case "AUTHORIZED":
      if (p.recovery === "capture_retry") return `Approved ${what}. PayPal couldn't take the capture yet; retrying (${p.recoveryNote}).`;
      if (p.recovery === "void_retry") return `Releasing ${what}. PayPal hasn't confirmed the void yet; retrying (${p.recoveryNote}).`;
      return `Authorized ${what} on PayPal (${p.paypalAuthorizationId}).`;
    case "RESERVED":
      return p.paypalApproveUrl
        ? `Reserved ${what}; waiting for the buyer to approve in PayPal.`
        : p.recoveryNote
          ? `Reserved ${what}; PayPal hasn't confirmed the authorization (${p.recoveryNote}). It is being checked; the budget stays reserved until then.`
          : `Reserved ${what}; authorizing with PayPal.`;
    default:
      return `${p.status}: ${what}`;
  }
}

export async function getReceipt(purchaseId: string) {
  const [p] = await db().select().from(purchases).where(eq(purchases.id, purchaseId));
  if (!p) throw new AppError("NOT_FOUND", `Unknown purchase ${purchaseId}`);
  const [v] = await db()
    .select()
    .from(mandateVersions)
    .where(and(eq(mandateVersions.mandateId, p.mandateId), eq(mandateVersions.version, p.mandateVersion)));
  const timeline = await db().select().from(events).where(eq(events.purchaseId, p.id)).orderBy(asc(events.id));
  return {
    purchase: p,
    mandateSnapshot: { version: v.version, rules: v.rules },
    ruleResults: p.ruleResults,
    timeline,
    summary: receiptSummary(p),
  };
}
