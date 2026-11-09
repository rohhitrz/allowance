/**
 * Transaction service: owns the purchase state machine.
 * This is the ONLY app module that calls PayPal write APIs (authorize, capture, void, refund).
 *
 * Order of operations (docs/02-system-design.md §4.2):
 *   1. lock mandate row, compute spend, run the policy engine, insert the purchase  (one DB transaction)
 *   2. BLOCK  -> done. PayPal is never called.
 *   3. otherwise authorize on PayPal, then
 *        APPROVE -> re-check (full engine, mandate locked) -> capture
 *        HOLD    -> create approval; a human decides later
 * Every status change is compare-and-set: UPDATE ... WHERE status IN (expected).
 *
 * PayPal is the source of truth for money. Two rules follow from that:
 *   - once PayPal confirms a capture, the purchase is never marked FAILED; we keep retrying the DB write
 *   - a void that fails leaves the purchase AUTHORIZED/HELD with "void failed: ..." and reconcile() retries it
 *   - when a capture or void call fails, we ask PayPal what the authorization's state really is
 *     (settleFromPayPal) before deciding anything: a lost response is not a refusal
 */
import { and, eq, gt, inArray, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import { db, type Conn } from "../db";
import { agentRuns, approvals, mandates, paypalVaults, products, purchases, type PurchaseRow } from "../db/schema";
import { AppError, assertHuman } from "../errors";
import { inTransaction, recordEvent } from "../events/bus";
import { id, newToken, sha256 } from "../ids";
import { evaluate, failedRules } from "../policy/engine";
import type { PolicyOutput } from "../policy/types";
import { toPolicyMandate } from "../mandates/rules";
import { getSpend } from "../mandates/spend";
import { approvalPrompt } from "../approvals/prompt";
import { PayPalError } from "../paypal/client";
import { gateway } from "./gateway";

const APPROVAL_TTL_MS = 10 * 60_000;
/** A no-vault purchase waiting for the buyer's PayPal popup is released after this. */
const POPUP_TTL_MS = 10 * 60_000;
/** A vault authorization still RESERVED after this means the process died mid-call. */
const STUCK_RESERVATION_MS = 2 * 60_000;
const VOID_FAILED = "void failed:";
const CAPTURE_PENDING = "capture PENDING";

type Status = PurchaseRow["status"];

export type PublicApproval = { id: string; prompt: string; expiresAt: Date; status: string };
export type PurchaseResult = { purchase: PurchaseRow; approval?: PublicApproval };

// ---------- helpers ----------

async function loadPurchase(conn: Conn, purchaseId: string): Promise<PurchaseRow> {
  const [p] = await conn.select().from(purchases).where(eq(purchases.id, purchaseId));
  if (!p) throw new AppError("NOT_FOUND", `Unknown purchase ${purchaseId}`);
  return p;
}

/** Compare-and-set transition. Returns the row, or null if someone else moved it first. */
async function transition(
  conn: Conn,
  purchaseId: string,
  from: Status[],
  to: Status,
  set: Partial<PurchaseRow> = {},
): Promise<PurchaseRow | null> {
  const [row] = await conn
    .update(purchases)
    .set({ ...set, status: to, updatedAt: new Date() })
    .where(and(eq(purchases.id, purchaseId), inArray(purchases.status, from)))
    .returning();
  return row ?? null;
}

function paypalFailure(e: unknown) {
  if (e instanceof PayPalError) return { reason: e.message, debugId: e.debugId ?? null };
  return { reason: e instanceof Error ? e.message : String(e), debugId: null };
}

/** Retry a DB write a few times; used after PayPal has already moved money. */
async function persistently<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw last;
}

async function publicApproval(purchaseId: string): Promise<PublicApproval | undefined> {
  const [a] = await db().select().from(approvals).where(eq(approvals.purchaseId, purchaseId));
  return a ? { id: a.id, prompt: a.prompt, expiresAt: a.expiresAt, status: a.status } : undefined;
}

async function result(purchaseId: string): Promise<PurchaseResult> {
  const purchase = await loadPurchase(db(), purchaseId);
  return { purchase, approval: await publicApproval(purchaseId) };
}

/**
 * Re-run the full policy engine against the mandate as it is NOW, with the mandate row
 * locked and this purchase excluded from spend. Soft rules are ignored (approve path
 * already accepted them); hard rules and the mandate version must still hold.
 */
async function recheck(conn: Conn, p: PurchaseRow, expectedVersion: number, now: Date) {
  const [m] = await conn.select().from(mandates).where(eq(mandates.id, p.mandateId)).for("update");
  const { spend } = await getSpend(conn, m, now, p.id);
  const out = evaluate({
    mandate: toPolicyMandate(m),
    spend,
    request: { productId: p.productId, quantity: p.quantity },
    product: { priceCents: p.unitPriceCents, category: p.productCategory },
    now,
  });
  const hardFailed = failedRules(out.results, "hard");
  const versionChanged = m.version !== expectedVersion;
  const problem = versionChanged ? "mandate changed since the check" : hardFailed.map((r) => r.detail).join("; ") || null;
  return { ok: problem === null, problem, results: out.results, versionChanged };
}

// ---------- request a purchase (the one money entry point) ----------

export async function requestPurchase(args: {
  mandateId: string;
  productId: string;
  quantity: number;
  reason: string;
  actor: string;
  runId?: string;
  idempotencyKey?: string;
  now?: Date;
}): Promise<PurchaseResult> {
  if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 1000) {
    throw new AppError("VALIDATION_ERROR", "quantity must be a whole number from 1 to 1000");
  }
  const existingByKey = async () => {
    if (!args.idempotencyKey) return null;
    const [existing] = await db().select().from(purchases).where(eq(purchases.idempotencyKey, args.idempotencyKey));
    return existing ? result(existing.id) : null;
  };
  const fast = await existingByKey();
  if (fast) return fast;
  const now = args.now ?? new Date();

  // 1. Decide and reserve atomically. The row lock serialises parallel requests on one mandate.
  const created = await inTransaction(async (tx) => {
    const [m] = await tx.select().from(mandates).where(eq(mandates.id, args.mandateId)).for("update");
    if (!m) throw new AppError("NOT_FOUND", `Unknown mandate ${args.mandateId}`);
    // Price and category come from our catalog, never from the caller.
    const [p] = await tx.select().from(products).where(eq(products.id, args.productId));
    if (!p || !p.active) throw new AppError("NOT_FOUND", `Unknown product ${args.productId}`);

    const { spend, periodStart } = await getSpend(tx, m, now);
    const out = evaluate({
      mandate: toPolicyMandate(m),
      spend,
      request: { productId: p.id, quantity: args.quantity },
      product: { priceCents: p.priceCents, category: p.category },
      now,
    });

    const pid = id("pur");
    // A concurrent retry with the same idempotency key loses here, inside the transaction.
    const [row] = await tx
      .insert(purchases)
      .values({
        id: pid,
        mandateId: m.id,
        mandateVersion: m.version,
        runId: args.runId ?? null,
        requestedBy: args.actor,
        idempotencyKey: args.idempotencyKey ?? null,
        productId: p.id,
        productName: p.name,
        productCategory: p.category,
        unitPriceCents: p.priceCents,
        quantity: args.quantity,
        totalCents: p.priceCents * args.quantity,
        reason: args.reason.slice(0, 500),
        periodStart,
        decision: out.decision,
        ruleResults: out.results,
        status: out.decision === "BLOCK" ? "BLOCKED" : "RESERVED",
      })
      .onConflictDoNothing({ target: purchases.idempotencyKey })
      .returning();
    if (!row) return null;

    const base = { actor: args.actor, mandateId: m.id, purchaseId: pid };
    await recordEvent(tx, {
      ...base,
      type: "purchase.proposed",
      data: { productId: p.id, productName: p.name, quantity: args.quantity, totalCents: row.totalCents, reason: row.reason },
    });
    if (out.decision === "BLOCK") {
      await recordEvent(tx, {
        ...base,
        type: "purchase.blocked",
        data: { failed: failedRules(out.results), paypalCalled: false },
      });
    } else {
      await recordEvent(tx, { ...base, type: "purchase.reserved", data: { decision: out.decision } });
    }
    return { row, out, spentBefore: spend.amountCents, mandate: m };
  });

  if (!created) {
    const dup = await existingByKey();
    if (dup) return dup;
    throw new AppError("INVALID_STATE", "Duplicate idempotency key");
  }
  if (created.row.status === "BLOCKED") return result(created.row.id);

  // 2. Authorize on PayPal (outside the DB transaction; the reservation already counts toward spend).
  const outcome = await authorize(created.row, created.mandate.userId);
  if (outcome !== "authorized") return result(created.row.id); // FAILED / VOIDED, or waiting for the buyer popup

  // 3. Approve -> capture; Hold -> ask a human.
  const after = await loadPurchase(db(), created.row.id);
  if (created.out.decision === "APPROVE") {
    await captureAfterRecheck(after, "system");
  } else {
    await createHold(after, created.out, created.spentBefore, created.mandate);
  }
  return result(after.id);
}

type AuthorizeOutcome = "authorized" | "awaiting_buyer" | "failed" | "voided";

async function authorize(p: PurchaseRow, userId: string): Promise<AuthorizeOutcome> {
  const [vault] = await db()
    .select()
    .from(paypalVaults)
    .where(and(eq(paypalVaults.userId, userId), eq(paypalVaults.status, "ACTIVE")));
  // Mark first, so a crash mid-call can never leave a "PayPal never called" claim that isn't true.
  await db().update(purchases).set({ paypalCalled: true }).where(eq(purchases.id, p.id));

  let r;
  try {
    if (!vault?.paymentTokenId) {
      // No-vault fallback: the buyer approves in a popup, then completeFallbackAuthorization() runs.
      // If they never do, reconcile() releases the reservation after POPUP_TTL_MS.
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
      const o = await gateway().createOrderForApproval({
        amountCents: p.totalCents,
        description: p.productName,
        customId: p.id,
        returnUrl: `${base}/paypal/return?purchase=${p.id}`,
        cancelUrl: `${base}/paypal/cancel?purchase=${p.id}`,
        requestId: `${p.id}:order`,
      });
      await db()
        .update(purchases)
        .set({ paypalOrderId: o.orderId, paypalApproveUrl: o.approveUrl ?? null, updatedAt: new Date() })
        .where(eq(purchases.id, p.id));
      return "awaiting_buyer";
    }
    r = await gateway().authorizeWithVault({
      amountCents: p.totalCents,
      vaultId: vault.paymentTokenId,
      description: p.productName,
      customId: p.id,
      requestId: `${p.id}:authorize`,
    });
  } catch (e) {
    await fail(p, e);
    return "failed";
  }
  if (!r.authorizationId) {
    await fail(p, new Error(`No authorization returned (order ${r.orderStatus})`));
    return "failed";
  }
  if (!(await markAuthorized(p, r.orderId, r.authorizationId))) return "failed";
  if (r.authorizationStatus !== "CREATED") {
    // PayPal made an authorization we can't use (e.g. PENDING review, DENIED). Release it.
    const v = await voidPurchase(p.id, "system", `PayPal authorization was ${r.authorizationStatus ?? "unknown"}`).catch(
      () => null, // recorded as "void failed"; reconcile() retries
    );
    return v?.status === "VOIDED" ? "voided" : "failed";
  }
  return "authorized";
}

/** RESERVED -> AUTHORIZED. If the reservation was already released, void the stray authorization. */
async function markAuthorized(p: PurchaseRow, orderId: string, authorizationId: string): Promise<boolean> {
  const row = await transition(db(), p.id, ["RESERVED"], "AUTHORIZED", {
    paypalOrderId: orderId,
    paypalAuthorizationId: authorizationId,
  });
  if (!row) {
    await gateway()
      .voidAuthorization({ authorizationId, requestId: `${p.id}:void` })
      .catch(() => {});
    await db()
      .update(purchases)
      .set({ paypalOrderId: orderId, paypalAuthorizationId: authorizationId })
      .where(eq(purchases.id, p.id));
    return false;
  }
  await recordEvent(db(), {
    actor: "system",
    type: "purchase.authorized",
    mandateId: p.mandateId,
    purchaseId: p.id,
    data: { orderId, authorizationId },
  });
  return true;
}

async function fail(p: PurchaseRow, e: unknown, from: Status[] = ["RESERVED", "AUTHORIZED", "HELD"]) {
  const f = paypalFailure(e);
  const row = await transition(db(), p.id, from, "FAILED", {
    failureReason: f.reason,
    paypalDebugId: f.debugId,
  });
  if (row) {
    await recordEvent(db(), {
      actor: "system",
      type: "purchase.failed",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { reason: f.reason, paypalDebugId: f.debugId },
    });
  }
}

/** No-vault fallback: called after the buyer approved the PayPal popup. */
export async function completeFallbackAuthorization(purchaseId: string, actor: string): Promise<PurchaseResult> {
  assertHuman(actor);
  const p = await loadPurchase(db(), purchaseId);
  if (p.status !== "RESERVED" || !p.paypalOrderId) throw new AppError("INVALID_STATE", `Purchase is ${p.status}`);
  let r;
  try {
    r = await gateway().authorizeOrder({ orderId: p.paypalOrderId, requestId: `${p.id}:authorize` });
    if (!r.authorizationId) throw new Error("No authorization returned");
  } catch (e) {
    await fail(p, e, ["RESERVED"]);
    return result(p.id);
  }
  if (!(await markAuthorized(p, p.paypalOrderId, r.authorizationId))) return result(p.id);
  if (r.authorizationStatus && r.authorizationStatus !== "CREATED") {
    await voidPurchase(p.id, "system", `PayPal authorization was ${r.authorizationStatus}`).catch(() => {});
    return result(p.id);
  }
  const after = await loadPurchase(db(), p.id);
  if (p.decision === "APPROVE") {
    await captureAfterRecheck(after, "system");
  } else {
    const [m] = await db().select().from(mandates).where(eq(mandates.id, p.mandateId));
    const { spend } = await getSpend(db(), m, new Date(), p.id);
    await createHold(after, { decision: p.decision, results: p.ruleResults }, spend.amountCents, m);
  }
  return result(p.id);
}

/** No-vault fallback: the buyer closed or cancelled the PayPal popup. Releases the reservation. */
export async function cancelFallbackPurchase(purchaseId: string, actor: string): Promise<PurchaseRow> {
  const p = await loadPurchase(db(), purchaseId);
  if (p.status !== "RESERVED" || !p.paypalApproveUrl) return p;
  const row = await transition(db(), p.id, ["RESERVED"], "FAILED", { failureReason: "buyer cancelled in PayPal" });
  if (row) {
    await recordEvent(db(), { actor, type: "purchase.failed", mandateId: p.mandateId, purchaseId: p.id, data: { reason: row.failureReason } });
  }
  return row ?? (await loadPurchase(db(), p.id));
}

// ---------- capture / void / refund ----------

/** Final re-check before capture on the auto-approve path (full engine, mandate locked). */
async function captureAfterRecheck(p: PurchaseRow, actor: string) {
  const check = await inTransaction((tx) => recheck(tx, p, p.mandateVersion, new Date()));
  if (!check.ok) return voidPurchase(p.id, actor, `re-check failed: ${check.problem}`).catch(() => null);
  return capture(p.id, actor);
}

/**
 * What PayPal says happened to this purchase's authorization. Reads only.
 *   captured -> money moved (captureId is missing only if the order lookup failed)
 *   released -> VOIDED or DENIED: nothing is held on the buyer's account
 *   open     -> still authorized
 *   unknown  -> PayPal couldn't be reached
 */
type PayPalState =
  | { kind: "captured"; captureId?: string; captureStatus?: string }
  | { kind: "released"; status: string }
  | { kind: "open" }
  | { kind: "unknown" };

async function paypalState(p: PurchaseRow): Promise<PayPalState> {
  if (!p.paypalAuthorizationId) return { kind: "unknown" };
  let status: string;
  try {
    status = (await gateway().getAuthorization(p.paypalAuthorizationId)).status;
  } catch {
    return { kind: "unknown" };
  }
  if (status === "CAPTURED" || status === "PARTIALLY_CAPTURED") {
    const captures = p.paypalOrderId ? await gateway().getOrderCaptures(p.paypalOrderId).catch(() => []) : [];
    const c = captures.find((x) => x.status === "COMPLETED" || x.status === "PENDING") ?? captures[0];
    return { kind: "captured", captureId: c?.captureId, captureStatus: c?.status };
  }
  if (status === "VOIDED" || status === "DENIED") return { kind: "released", status };
  return { kind: "open" };
}

/**
 * Bring our record in line with PayPal after a call whose outcome we can't trust.
 * Returns the purchase if PayPal shows the authorization is finished (captured or
 * released); null if it is still open, unreachable, or captured without a capture id yet.
 */
async function settleFromPayPal(p: PurchaseRow, actor: string, reason: string, known?: PayPalState): Promise<PurchaseRow | null> {
  const state = known ?? (await paypalState(p));
  if (state.kind === "captured" && state.captureId) {
    await recordCapture(p, { captureId: state.captureId, status: state.captureStatus ?? "COMPLETED" }, actor);
    return loadPurchase(db(), p.id);
  }
  if (state.kind === "released") {
    const note = `${reason} (PayPal already shows the authorization ${state.status})`;
    const row = await transition(db(), p.id, ["AUTHORIZED", "HELD"], "VOIDED", { failureReason: note });
    if (row) {
      await recordEvent(db(), {
        actor,
        type: "purchase.voided",
        mandateId: p.mandateId,
        purchaseId: p.id,
        data: { reason: note, authorizationId: p.paypalAuthorizationId },
      });
    }
    return row ?? (await loadPurchase(db(), p.id));
  }
  return null;
}

/** PayPal confirmed a capture: record it, whatever it takes. Never mark this purchase FAILED. */
async function recordCapture(p: PurchaseRow, r: { captureId: string; status: string }, actor: string) {
  await persistently(async () => {
    const note = r.status === "PENDING" ? `${CAPTURE_PENDING} at PayPal; it can still be declined` : null;
    const row = await transition(db(), p.id, ["AUTHORIZED", "HELD"], "CAPTURED", {
      paypalCaptureId: r.captureId,
      failureReason: note,
    });
    if (!row) {
      // Someone moved the row meanwhile, but PayPal is the truth: it's captured.
      await db()
        .update(purchases)
        .set({ status: "CAPTURED", paypalCaptureId: r.captureId, failureReason: note, updatedAt: new Date() })
        .where(eq(purchases.id, p.id));
    }
    await recordEvent(db(), {
      actor,
      type: "purchase.captured",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { captureId: r.captureId, captureStatus: r.status },
    });
  }).catch((e) => {
    // Last resort: the capture id is in the log so it can be refunded by hand.
    console.error(`[allowance] CAPTURED ${p.id} on PayPal (capture ${r.captureId}) but the DB write failed`, e);
    throw new AppError("INVALID_STATE", `Captured on PayPal (${r.captureId}) but not recorded; retry`, {
      purchaseId: p.id,
      captureId: r.captureId,
    });
  });
}

async function capture(purchaseId: string, actor: string) {
  const p = await loadPurchase(db(), purchaseId);
  if (!["AUTHORIZED", "HELD"].includes(p.status) || !p.paypalAuthorizationId) {
    throw new AppError("INVALID_STATE", `Can't capture a ${p.status} purchase`);
  }
  const authorizationId = p.paypalAuthorizationId;

  // Step 1: ask PayPal. Retry once with the same request id: if the first call actually
  // captured but the response was lost, PayPal returns that same capture.
  let r: { captureId: string; status: string };
  try {
    r = await gateway()
      .captureAuthorization({ authorizationId, requestId: `${p.id}:capture` })
      .catch(() => gateway().captureAuthorization({ authorizationId, requestId: `${p.id}:capture` }));
    // A 2xx isn't enough: PayPal reports the capture's own status.
    //   COMPLETED -> money moved.  PENDING -> committed but not settled (e.g. review); recorded, flagged,
    //   and re-checked by reconcile().  DECLINED / FAILED / anything else -> no money moved.
    if (r.status !== "COMPLETED" && r.status !== "PENDING") {
      throw new Error(`PayPal capture ${r.captureId} was ${r.status}`);
    }
  } catch (e) {
    // The capture call failed, which is not the same as "not captured": both responses may
    // have been lost after PayPal took the money. Ask PayPal before releasing anything.
    const f = paypalFailure(e);
    const state = await paypalState(p);
    if (await settleFromPayPal(p, actor, `capture failed (${f.reason})`, state)) return;
    const keepOpen = (why: string) =>
      db()
        .update(purchases)
        .set({ failureReason: `${VOID_FAILED} capture failed (${f.reason}); ${why}`, paypalDebugId: f.debugId })
        .where(eq(purchases.id, p.id));
    if (state.kind !== "open") {
      // Unreachable, or captured but the capture id isn't known yet: don't guess. reconcile() retries.
      await keepOpen(state.kind === "captured" ? "PayPal shows it captured; looking up the capture id" : "PayPal state unknown");
      return;
    }
    // PayPal really did refuse. Don't leave money authorized: void, then mark FAILED.
    try {
      await gateway().voidAuthorization({ authorizationId, requestId: `${p.id}:void` });
    } catch (ve) {
      await keepOpen(paypalFailure(ve).reason); // reconcile() retries the void
      return;
    }
    await fail(p, e, ["AUTHORIZED", "HELD"]);
    return;
  }

  // Step 2: money has moved.
  await recordCapture(p, r, actor);
}

/**
 * Void an open authorization (reject, expiry, re-check failed, kill switch).
 * On a PayPal error we first ask PayPal for the authorization's real state: if it is already
 * voided (the earlier response was lost) or already captured, we record that. Otherwise the
 * purchase stays AUTHORIZED/HELD with "void failed: ..." and reconcile() retries it; the error
 * is rethrown so callers can report it.
 */
export async function voidPurchase(purchaseId: string, actor: string, reason: string) {
  const p = await loadPurchase(db(), purchaseId);
  if (!["AUTHORIZED", "HELD"].includes(p.status)) return p;
  if (!p.paypalAuthorizationId) {
    return (await transition(db(), p.id, ["AUTHORIZED", "HELD"], "VOIDED", { failureReason: reason })) ?? p;
  }
  try {
    await gateway().voidAuthorization({ authorizationId: p.paypalAuthorizationId, requestId: `${p.id}:void` });
  } catch (e) {
    const settled = await settleFromPayPal(p, actor, reason);
    if (settled) return settled;
    const f = paypalFailure(e);
    await db()
      .update(purchases)
      .set({ failureReason: `${VOID_FAILED} ${reason}; ${f.reason}`, paypalDebugId: f.debugId })
      .where(eq(purchases.id, p.id));
    throw new AppError("PAYPAL_ERROR", `Void failed: ${f.reason}`, { paypalDebugId: f.debugId });
  }
  const row = await transition(db(), p.id, ["AUTHORIZED", "HELD"], "VOIDED", { failureReason: reason });
  if (row) {
    await recordEvent(db(), {
      actor,
      type: "purchase.voided",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { reason, authorizationId: p.paypalAuthorizationId },
    });
  }
  return row ?? (await loadPurchase(db(), p.id));
}

export async function refundPurchase(purchaseId: string, actor: string, reason?: string): Promise<PurchaseRow> {
  assertHuman(actor);
  const p = await loadPurchase(db(), purchaseId);
  if (p.status !== "CAPTURED" || !p.paypalCaptureId) throw new AppError("INVALID_STATE", `Can't refund a ${p.status} purchase`);
  let refund;
  try {
    refund = await gateway().refundCapture({ captureId: p.paypalCaptureId, requestId: `${p.id}:refund`, note: reason });
  } catch (e) {
    const f = paypalFailure(e);
    throw new AppError("PAYPAL_ERROR", `Refund failed: ${f.reason}`, { paypalDebugId: f.debugId });
  }
  const refundId = refund.refundId;
  const row = await persistently(() => transition(db(), p.id, ["CAPTURED"], "REFUNDED", { paypalRefundId: refundId }));
  if (row) {
    await recordEvent(db(), {
      actor,
      type: "purchase.refunded",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { refundId, reason: reason ?? null },
    });
  }
  return row ?? (await loadPurchase(db(), p.id));
}

// ---------- holds and approvals ----------

async function createHold(
  p: PurchaseRow,
  out: PolicyOutput,
  spentBefore: number,
  m: { budgetCents: number; hardLimitCents: number },
) {
  const softFailed = failedRules(out.results, "soft");
  const prompt = approvalPrompt({
    productName: p.productName,
    totalCents: p.totalCents,
    spentBeforeCents: spentBefore,
    budgetCents: m.budgetCents,
    hardLimitCents: m.hardLimitCents,
    category: p.productCategory,
    softFailed,
  });
  const approvalId = id("apr");
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  await inTransaction(async (tx) => {
    const row = await transition(tx, p.id, ["AUTHORIZED"], "HELD");
    if (!row) return; // moved by someone else (e.g. kill switch): no hold
    await tx.insert(approvals).values({
      id: approvalId,
      purchaseId: p.id,
      // Humans decide by approval id, behind their channel's own auth (dashboard cookie, voice
      // secret). The raw token is never handed out, so this hash matches nothing: the column is
      // kept for out-of-band approval links (email, P2).
      tokenHash: sha256(newToken()),
      amountCents: p.totalCents,
      mandateVersion: p.mandateVersion,
      softRulesFailed: softFailed,
      prompt,
      expiresAt,
    });
    await recordEvent(tx, { actor: "system", type: "purchase.held", mandateId: p.mandateId, purchaseId: p.id, data: { approvalId } });
    await recordEvent(tx, {
      actor: "system",
      type: "approval.created",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { approvalId, prompt, expiresAt: expiresAt.toISOString() },
    });
  });
}

export type DecisionOutcome = { approval: PublicApproval; purchase: PurchaseRow; alreadyDecided: boolean; note?: string };

/**
 * A human approves or rejects a hold. Anything other than exactly "approve" is a reject.
 * Approve re-runs the engine against the CURRENT mandate (same version, active, hard rules pass).
 * The approval row lock makes the decision single-use; a repeat call returns the same result.
 */
export async function decideApproval(args: {
  approvalId?: string;
  token?: string;
  decision: string;
  actor: string;
  now?: Date;
}): Promise<DecisionOutcome> {
  assertHuman(args.actor);
  const now = args.now ?? new Date();
  const approve = args.decision === "approve";

  const plan = await inTransaction(async (tx) => {
    const where = args.approvalId
      ? eq(approvals.id, args.approvalId)
      : args.token
        ? eq(approvals.tokenHash, sha256(args.token))
        : undefined;
    if (!where) throw new AppError("VALIDATION_ERROR", "approvalId or token required");
    const [a] = await tx.select().from(approvals).where(where).for("update");
    if (!a) throw new AppError("NOT_FOUND", "Unknown approval");
    if (a.status !== "PENDING") return { kind: "already" as const, a };

    const p = await loadPurchase(tx, a.purchaseId);
    const decided = (status: "APPROVED" | "REJECTED" | "EXPIRED", by: string) =>
      tx.update(approvals).set({ status, decidedBy: by, decidedAt: now }).where(eq(approvals.id, a.id));

    if (now > a.expiresAt) {
      await decided("EXPIRED", "system");
      await recordEvent(tx, { actor: "system", type: "approval.expired", mandateId: p.mandateId, purchaseId: p.id, data: { approvalId: a.id } });
      return { kind: "void" as const, a, reason: "approval expired" };
    }
    if (!approve) {
      await decided("REJECTED", args.actor);
      await recordEvent(tx, { actor: args.actor, type: "approval.decided", mandateId: p.mandateId, purchaseId: p.id, data: { approvalId: a.id, decision: "reject" } });
      return { kind: "void" as const, a, reason: "rejected by user" };
    }

    const check = await recheck(tx, p, a.mandateVersion, now);
    await decided("APPROVED", args.actor);
    await recordEvent(tx, {
      actor: args.actor,
      type: "approval.decided",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { approvalId: a.id, decision: "approve", recheck: check.results, versionChanged: check.versionChanged },
    });
    if (!check.ok) return { kind: "void" as const, a, reason: `re-check failed: ${check.problem}` };
    return { kind: "capture" as const, a };
  });

  let note: string | undefined;
  if (plan.kind === "already" && plan.a.status in CLOSED_APPROVAL_REASON) {
    // Repeating a decision finishes a void that PayPal didn't confirm the first time.
    await voidPurchase(plan.a.purchaseId, "system", CLOSED_APPROVAL_REASON[plan.a.status]).catch(() => {});
  }
  if (plan.kind === "capture") await capture(plan.a.purchaseId, args.actor);
  if (plan.kind === "void") {
    note = plan.reason;
    // A failed void is kept open and retried by reconcile(); the decision itself stands.
    await voidPurchase(plan.a.purchaseId, plan.reason === "approval expired" ? "system" : args.actor, plan.reason).catch(() => {});
  }
  const [a] = await db().select().from(approvals).where(eq(approvals.id, plan.a.id));
  return {
    approval: { id: a.id, prompt: a.prompt, expiresAt: a.expiresAt, status: a.status },
    purchase: await loadPurchase(db(), a.purchaseId),
    alreadyDecided: plan.kind === "already",
    note,
  };
}

/** Expire stale approvals and void them. Also runs the rest of reconcile(). */
export async function sweepExpiredApprovals(now = new Date()): Promise<number> {
  const expired = await db()
    .update(approvals)
    .set({ status: "EXPIRED", decidedBy: "system", decidedAt: now })
    .where(and(eq(approvals.status, "PENDING"), lt(approvals.expiresAt, now)))
    .returning({ id: approvals.id, purchaseId: approvals.purchaseId });
  for (const e of expired) {
    const p = await loadPurchase(db(), e.purchaseId);
    await recordEvent(db(), { actor: "system", type: "approval.expired", mandateId: p.mandateId, purchaseId: p.id, data: { approvalId: e.id } });
    await voidPurchase(p.id, "system", "approval expired").catch(() => {}); // retried by retryOpenVoids
  }
  await retryOpenVoids();
  await releaseStaleReservations(now);
  await recheckPendingCaptures();
  return expired.length;
}

const CLOSED_APPROVAL_REASON: Record<string, string> = {
  REJECTED: "rejected by user",
  EXPIRED: "approval expired",
  CANCELLED: "kill switch or mandate cancelled",
};

/**
 * Retry every void that should have happened but didn't: purchases still HELD whose approval
 * is closed, and anything marked "void failed". Returns how many are now voided.
 */
export async function retryOpenVoids(): Promise<number> {
  const rows = await db()
    .select({ purchase: purchases, approvalStatus: approvals.status })
    .from(purchases)
    .leftJoin(approvals, eq(approvals.purchaseId, purchases.id))
    .where(
      and(
        inArray(purchases.status, ["AUTHORIZED", "HELD"]),
        or(
          like(purchases.failureReason, `${VOID_FAILED}%`),
          and(eq(purchases.status, "HELD"), inArray(approvals.status, ["REJECTED", "EXPIRED", "CANCELLED"])),
        ),
      ),
    );
  let voided = 0;
  for (const { purchase: p, approvalStatus } of rows) {
    const reason = (approvalStatus && CLOSED_APPROVAL_REASON[approvalStatus]) ?? "void retry";
    const after = await voidPurchase(p.id, "system", reason).catch(() => null);
    if (after?.status === "VOIDED") voided++;
  }
  return voided;
}

/**
 * Release reservations nobody will finish. FAILED / VOIDED no longer count toward spend,
 * orders or duplicates.
 *   - a no-vault order the buyer never approved (POPUP_TTL_MS): nothing is held, mark FAILED
 *   - a vault authorization interrupted mid-call (STUCK_RESERVATION_MS): PayPal may have
 *     created the authorization before we died, so recover it and void it (see below)
 */
export async function releaseStaleReservations(now = new Date()): Promise<number> {
  const popupCutoff = new Date(now.getTime() - POPUP_TTL_MS);
  const stuckCutoff = new Date(now.getTime() - STUCK_RESERVATION_MS);
  const abandoned = await db()
    .update(purchases)
    .set({ status: "FAILED", updatedAt: now, failureReason: "buyer did not approve in PayPal in time" })
    .where(and(eq(purchases.status, "RESERVED"), isNotNull(purchases.paypalApproveUrl), lt(purchases.updatedAt, popupCutoff)))
    .returning();
  for (const p of abandoned) {
    await recordEvent(db(), { actor: "system", type: "purchase.failed", mandateId: p.mandateId, purchaseId: p.id, data: { reason: p.failureReason } });
  }

  const stuck = await db()
    .select({ purchase: purchases, userId: mandates.userId })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(and(eq(purchases.status, "RESERVED"), isNull(purchases.paypalApproveUrl), lt(purchases.updatedAt, stuckCutoff)));
  let released = abandoned.length;
  for (const { purchase, userId } of stuck) {
    if (await releaseStuckAuthorization(purchase, userId)) released++;
  }
  return released;
}

/**
 * The process died between "reserve" and "PayPal answered", so we have no order id and
 * can't know whether PayPal created the authorization. PayPal has no lookup by our id, but
 * it does replay a request sent again with the same PayPal-Request-Id: so we re-send the
 * authorize call. Either it returns the authorization that already exists or it makes one;
 * both ways we now hold its id and void it. Never mark FAILED on a guess.
 * Returns true once the reservation is released.
 */
async function releaseStuckAuthorization(p: PurchaseRow, userId: string): Promise<boolean> {
  const reason = "authorization never completed";
  const [vault] = await db()
    .select()
    .from(paypalVaults)
    .where(and(eq(paypalVaults.userId, userId), eq(paypalVaults.status, "ACTIVE")));
  if (!p.paypalCalled || !vault?.paymentTokenId) {
    // PayPal was never asked (or can't be asked again): nothing can be held.
    await fail(p, new Error(reason), ["RESERVED"]);
    return true;
  }
  let r;
  try {
    r = await gateway().authorizeWithVault({
      amountCents: p.totalCents,
      vaultId: vault.paymentTokenId,
      description: p.productName,
      customId: p.id,
      requestId: `${p.id}:authorize`,
    });
  } catch (e) {
    // A 4xx is PayPal refusing the request: no authorization exists. Anything else means we
    // still don't know, so leave it RESERVED and try again on the next sweep.
    if (e instanceof PayPalError && e.status >= 400 && e.status < 500) {
      await fail(p, new Error(`${reason}: ${e.message}`), ["RESERVED"]);
      return true;
    }
    return false;
  }
  if (!r.authorizationId) {
    await fail(p, new Error(reason), ["RESERVED"]);
    return true;
  }
  if (!(await markAuthorized(p, r.orderId, r.authorizationId))) return true; // moved meanwhile; stray authorization voided
  const v = await voidPurchase(p.id, "system", reason).catch(() => null); // a failed void is retried by retryOpenVoids
  return v?.status === "VOIDED";
}

/**
 * A capture PayPal reported as PENDING is recorded as CAPTURED and flagged. Ask PayPal again:
 * COMPLETED clears the flag; DECLINED / FAILED means the money never moved, so the purchase
 * becomes FAILED and its budget is released.
 */
export async function recheckPendingCaptures(): Promise<number> {
  const rows = await db()
    .select()
    .from(purchases)
    .where(and(eq(purchases.status, "CAPTURED"), like(purchases.failureReason, `${CAPTURE_PENDING}%`), isNotNull(purchases.paypalCaptureId)));
  let settled = 0;
  for (const p of rows) {
    const c = await gateway().getCapture(p.paypalCaptureId!).catch(() => null);
    if (!c || c.status === "PENDING") continue;
    const stillPending = and(eq(purchases.id, p.id), eq(purchases.status, "CAPTURED"), like(purchases.failureReason, `${CAPTURE_PENDING}%`));
    if (c.status === "DECLINED" || c.status === "FAILED") {
      const reason = `PayPal capture ${c.captureId} was ${c.status} after pending; no money moved`;
      const [row] = await db().update(purchases).set({ status: "FAILED", failureReason: reason, updatedAt: new Date() }).where(stillPending).returning();
      if (row) await recordEvent(db(), { actor: "system", type: "purchase.failed", mandateId: p.mandateId, purchaseId: p.id, data: { reason } });
    } else {
      const [row] = await db().update(purchases).set({ failureReason: null, updatedAt: new Date() }).where(stillPending).returning();
      if (row) {
        await recordEvent(db(), {
          actor: "system",
          type: "purchase.captured",
          mandateId: p.mandateId,
          purchaseId: p.id,
          data: { captureId: c.captureId, captureStatus: c.status, wasPending: true },
        });
      }
    }
    settled++;
  }
  return settled;
}

/** Everything the 60-second sweep does (src/instrumentation.ts calls sweepExpiredApprovals). */
export const reconcile = (now = new Date()) => sweepExpiredApprovals(now);

// ---------- kill switch ----------

/**
 * Freeze every ACTIVE mandate, cancel pending approvals and stop agent runs in one
 * transaction; then void the open holds on PayPal. Freezing is always the safe
 * direction, so any actor (including MCP agents) may call it. A void that fails here
 * is retried by reconcile().
 */
export async function freezeAll(args: { actor: string; userId: string }): Promise<{ frozen: number; voided: number }> {
  const now = new Date();
  const { frozenIds, purchaseIds } = await inTransaction(async (tx) => {
    const frozen = await tx
      .update(mandates)
      .set({ status: "FROZEN", frozenAt: now, updatedAt: now })
      .where(and(eq(mandates.userId, args.userId), eq(mandates.status, "ACTIVE")))
      .returning({ id: mandates.id });
    const frozenIds = frozen.map((f) => f.id);
    for (const f of frozenIds) await recordEvent(tx, { actor: args.actor, type: "mandate.frozen", mandateId: f });
    if (!frozenIds.length) return { frozenIds, purchaseIds: [] as string[] };

    const cancelled = await tx
      .update(approvals)
      .set({ status: "CANCELLED", decidedBy: args.actor, decidedAt: now })
      .where(
        and(
          eq(approvals.status, "PENDING"),
          inArray(
            approvals.purchaseId,
            tx.select({ id: purchases.id }).from(purchases).where(inArray(purchases.mandateId, frozenIds)),
          ),
        ),
      )
      .returning({ purchaseId: approvals.purchaseId });
    await tx
      .update(agentRuns)
      .set({ status: "STOPPED", endedAt: now })
      .where(and(inArray(agentRuns.mandateId, frozenIds), inArray(agentRuns.status, ["RUNNING", "WAITING_APPROVAL"])));
    return { frozenIds, purchaseIds: cancelled.map((c) => c.purchaseId) };
  });

  let voided = 0;
  for (const pid of purchaseIds) {
    const p = await voidPurchase(pid, args.actor, "kill switch").catch(() => null);
    if (p?.status === "VOIDED") voided++;
  }
  return { frozen: frozenIds.length, voided };
}

/**
 * Purchases still waiting on a human. A plain read: holds past their expiry are left out
 * here and voided by the 60-second sweep (or by settleHold / decideApproval, whichever
 * comes first), so listing approvals never makes PayPal calls.
 */
export async function pendingApprovals(now = new Date()) {
  return db()
    .select({ approval: approvals, purchase: purchases })
    .from(approvals)
    .innerJoin(purchases, eq(purchases.id, approvals.purchaseId))
    .where(and(eq(approvals.status, "PENDING"), gt(approvals.expiresAt, now)))
    .orderBy(sql`${approvals.createdAt} DESC`);
}
