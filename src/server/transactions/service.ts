/**
 * Transaction service: owns the purchase state machine.
 * This is the ONLY module that calls PayPal write APIs (authorize, capture, void, refund).
 *
 * Order of operations (docs/02-system-design.md §4.2):
 *   1. lock mandate row, compute spend, run the policy engine, insert the purchase  (one DB transaction)
 *   2. BLOCK  -> done. PayPal is never called.
 *   3. otherwise authorize on PayPal, then
 *        APPROVE -> re-check mandate -> capture
 *        HOLD    -> create approval; a human decides later
 * Every status change is compare-and-set: UPDATE ... WHERE status IN (expected).
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db, type Conn } from "../db";
import { agentRuns, approvals, mandates, paypalVaults, products, purchases, type PurchaseRow } from "../db/schema";
import { AppError, assertHuman } from "../errors";
import { bus, recordEvent } from "../events/bus";
import { id, newToken, sha256 } from "../ids";
import { evaluate, failedRules } from "../policy/engine";
import type { PolicyOutput } from "../policy/types";
import { toPolicyMandate } from "../mandates/rules";
import { getSpend } from "../mandates/spend";
import { approvalPrompt } from "../approvals/prompt";
import { PayPalError } from "../paypal/client";
import { gateway } from "./gateway";

const APPROVAL_TTL_MS = 10 * 60_000;
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

async function publicApproval(purchaseId: string): Promise<PublicApproval | undefined> {
  const [a] = await db().select().from(approvals).where(eq(approvals.purchaseId, purchaseId));
  return a ? { id: a.id, prompt: a.prompt, expiresAt: a.expiresAt, status: a.status } : undefined;
}

async function result(purchaseId: string): Promise<PurchaseResult> {
  const purchase = await loadPurchase(db(), purchaseId);
  return { purchase, approval: await publicApproval(purchaseId) };
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
  if (args.idempotencyKey) {
    const [existing] = await db().select().from(purchases).where(eq(purchases.idempotencyKey, args.idempotencyKey));
    if (existing) return result(existing.id);
  }
  const now = args.now ?? new Date();

  // 1. Decide and reserve atomically. The row lock serialises parallel requests on one mandate.
  const created = await db().transaction(async (tx) => {
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
      .returning();

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

  if (created.row.status === "BLOCKED") return result(created.row.id);

  // 2. Authorize on PayPal (outside the DB transaction; the reservation already counts toward spend).
  await authorize(created.row, created.mandate.userId);
  const after = await loadPurchase(db(), created.row.id);
  if (after.status !== "AUTHORIZED") return result(after.id); // FAILED, or RESERVED awaiting buyer popup (fallback)

  // 3. Approve -> capture; Hold -> ask a human.
  if (created.out.decision === "APPROVE") {
    await captureAfterRecheck(after, "system");
  } else {
    await createHold(after, created.out, created.spentBefore, created.mandate);
  }
  return result(after.id);
}

async function authorize(p: PurchaseRow, userId: string) {
  const [vault] = await db()
    .select()
    .from(paypalVaults)
    .where(and(eq(paypalVaults.userId, userId), eq(paypalVaults.status, "ACTIVE")));
  // Mark first, so a crash mid-call can never leave a "PayPal never called" claim that isn't true.
  await db().update(purchases).set({ paypalCalled: true }).where(eq(purchases.id, p.id));

  try {
    if (!vault?.paymentTokenId) {
      // No-vault fallback: the buyer approves in a popup, then completeFallbackAuthorization() runs.
      const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
      const r = await gateway().createOrderForApproval({
        amountCents: p.totalCents,
        description: p.productName,
        customId: p.id,
        returnUrl: `${base}/paypal/return?purchase=${p.id}`,
        cancelUrl: `${base}/paypal/cancel?purchase=${p.id}`,
        requestId: `${p.id}:order`,
      });
      await db()
        .update(purchases)
        .set({ paypalOrderId: r.orderId, paypalApproveUrl: r.approveUrl ?? null, updatedAt: new Date() })
        .where(eq(purchases.id, p.id));
      return;
    }
    const r = await gateway().authorizeWithVault({
      amountCents: p.totalCents,
      vaultId: vault.paymentTokenId,
      description: p.productName,
      customId: p.id,
      requestId: `${p.id}:authorize`,
    });
    if (!r.authorizationId || r.authorizationStatus !== "CREATED") {
      throw new Error(`Authorization not created (order ${r.orderStatus}, auth ${r.authorizationStatus ?? "none"})`);
    }
    await markAuthorized(p, r.orderId, r.authorizationId);
  } catch (e) {
    await fail(p, e);
  }
}

async function markAuthorized(p: PurchaseRow, orderId: string, authorizationId: string) {
  const row = await transition(db(), p.id, ["RESERVED"], "AUTHORIZED", {
    paypalOrderId: orderId,
    paypalAuthorizationId: authorizationId,
  });
  if (row) {
    await recordEvent(db(), {
      actor: "system",
      type: "purchase.authorized",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { orderId, authorizationId },
    });
  }
}

async function fail(p: PurchaseRow, e: unknown) {
  const f = paypalFailure(e);
  const row = await transition(db(), p.id, ["RESERVED", "AUTHORIZED", "HELD"], "FAILED", {
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
  try {
    const r = await gateway().authorizeOrder({ orderId: p.paypalOrderId, requestId: `${p.id}:authorize` });
    if (!r.authorizationId) throw new Error("No authorization returned");
    await markAuthorized(p, p.paypalOrderId, r.authorizationId);
  } catch (e) {
    await fail(p, e);
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

// ---------- capture / void / refund ----------

/** Final re-check before capture on the auto-approve path: mandate still ACTIVE, same version, not expired. */
async function captureAfterRecheck(p: PurchaseRow, actor: string) {
  const [m] = await db().select().from(mandates).where(eq(mandates.id, p.mandateId));
  const now = new Date();
  const problem =
    m.status !== "ACTIVE"
      ? `mandate is ${m.status}`
      : m.version !== p.mandateVersion
        ? "mandate changed since the check"
        : m.expiresAt && now > m.expiresAt
          ? "mandate expired"
          : null;
  if (problem) return voidPurchase(p.id, actor, `re-check failed: ${problem}`);
  return capture(p.id, actor);
}

async function capture(purchaseId: string, actor: string) {
  const p = await loadPurchase(db(), purchaseId);
  if (!["AUTHORIZED", "HELD"].includes(p.status) || !p.paypalAuthorizationId) {
    throw new AppError("INVALID_STATE", `Can't capture a ${p.status} purchase`);
  }
  try {
    const r = await gateway().captureAuthorization({
      authorizationId: p.paypalAuthorizationId,
      requestId: `${p.id}:capture`,
    });
    const row = await transition(db(), p.id, ["AUTHORIZED", "HELD"], "CAPTURED", { paypalCaptureId: r.captureId });
    if (row) {
      await recordEvent(db(), {
        actor,
        type: "purchase.captured",
        mandateId: p.mandateId,
        purchaseId: p.id,
        data: { captureId: r.captureId, captureStatus: r.status },
      });
    }
  } catch (e) {
    // Don't leave money authorized after a failed capture.
    await gateway()
      .voidAuthorization({ authorizationId: p.paypalAuthorizationId, requestId: `${p.id}:void` })
      .catch(() => {});
    await fail(p, e);
  }
}

/** Void an open authorization (reject, expiry, re-check failed, kill switch). */
export async function voidPurchase(purchaseId: string, actor: string, reason: string) {
  const p = await loadPurchase(db(), purchaseId);
  if (!["AUTHORIZED", "HELD"].includes(p.status)) return p;
  if (!p.paypalAuthorizationId) {
    return (await transition(db(), p.id, ["AUTHORIZED", "HELD"], "VOIDED", { failureReason: reason })) ?? p;
  }
  try {
    await gateway().voidAuthorization({ authorizationId: p.paypalAuthorizationId, requestId: `${p.id}:void` });
  } catch (e) {
    const f = paypalFailure(e);
    await db()
      .update(purchases)
      .set({ failureReason: `void failed: ${f.reason}`, paypalDebugId: f.debugId })
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
  const row = await transition(db(), p.id, ["CAPTURED"], "REFUNDED", { paypalRefundId: refund.refundId });
  if (row) {
    await recordEvent(db(), {
      actor,
      type: "purchase.refunded",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { refundId: refund.refundId, reason: reason ?? null },
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
  const token = newToken();
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
  await db().transaction(async (tx) => {
    const row = await transition(tx, p.id, ["AUTHORIZED"], "HELD");
    if (!row) return; // moved by someone else (e.g. kill switch)
    await tx.insert(approvals).values({
      id: approvalId,
      purchaseId: p.id,
      tokenHash: sha256(token),
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
  // The raw token goes only to human channels (SSE / voice), never to the DB or the agent.
  bus.emit("approval.token", { approvalId, purchaseId: p.id, token });
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

  const plan = await db().transaction(async (tx) => {
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

    // Approve: re-check hard rules against the mandate as it is now.
    const [m] = await tx.select().from(mandates).where(eq(mandates.id, p.mandateId)).for("update");
    const { spend } = await getSpend(tx, m, now, p.id);
    const recheck = evaluate({
      mandate: toPolicyMandate(m),
      spend,
      request: { productId: p.productId, quantity: p.quantity },
      product: { priceCents: p.unitPriceCents, category: p.productCategory },
      now,
    });
    const hardFailed = failedRules(recheck.results, "hard");
    const versionChanged = m.version !== a.mandateVersion;
    await decided("APPROVED", args.actor);
    await recordEvent(tx, {
      actor: args.actor,
      type: "approval.decided",
      mandateId: p.mandateId,
      purchaseId: p.id,
      data: { approvalId: a.id, decision: "approve", recheck: recheck.results, versionChanged },
    });
    if (versionChanged || hardFailed.length) {
      const why = versionChanged ? "mandate changed since the hold" : hardFailed.map((r) => r.detail).join("; ");
      return { kind: "void" as const, a, reason: `re-check failed: ${why}` };
    }
    return { kind: "capture" as const, a };
  });

  let note: string | undefined;
  if (plan.kind === "capture") await capture(plan.a.purchaseId, args.actor);
  if (plan.kind === "void") {
    note = plan.reason;
    await voidPurchase(plan.a.purchaseId, plan.reason === "approval expired" ? "system" : args.actor, plan.reason);
  }
  const [a] = await db().select().from(approvals).where(eq(approvals.id, plan.a.id));
  return {
    approval: { id: a.id, prompt: a.prompt, expiresAt: a.expiresAt, status: a.status },
    purchase: await loadPurchase(db(), a.purchaseId),
    alreadyDecided: plan.kind === "already",
    note,
  };
}

/** Expire stale approvals and void them. Run every 60 s, and on read. */
export async function sweepExpiredApprovals(now = new Date()): Promise<number> {
  const expired = await db()
    .update(approvals)
    .set({ status: "EXPIRED", decidedBy: "system", decidedAt: now })
    .where(and(eq(approvals.status, "PENDING"), lt(approvals.expiresAt, now)))
    .returning({ id: approvals.id, purchaseId: approvals.purchaseId });
  for (const e of expired) {
    const p = await loadPurchase(db(), e.purchaseId);
    await recordEvent(db(), { actor: "system", type: "approval.expired", mandateId: p.mandateId, purchaseId: p.id, data: { approvalId: e.id } });
    await voidPurchase(p.id, "system", "approval expired").catch(() => {});
  }
  return expired.length;
}

// ---------- kill switch ----------

/**
 * Freeze every ACTIVE mandate, cancel pending approvals and stop agent runs in one
 * transaction; then void the open holds on PayPal. Freezing is always the safe
 * direction, so any actor (including MCP agents) may call it.
 */
export async function freezeAll(args: { actor: string; userId: string }): Promise<{ frozen: number; voided: number }> {
  const now = new Date();
  const { frozenIds, purchaseIds } = await db().transaction(async (tx) => {
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
    try {
      const p = await voidPurchase(pid, args.actor, "kill switch");
      if (p.status === "VOIDED") voided++;
    } catch {
      // Recorded on the purchase as failure_reason; the mandate is frozen regardless.
    }
  }
  return { frozen: frozenIds.length, voided };
}

/** Purchases still waiting on a human. */
export async function pendingApprovals() {
  await sweepExpiredApprovals();
  return db()
    .select({ approval: approvals, purchase: purchases })
    .from(approvals)
    .innerJoin(purchases, eq(purchases.id, approvals.purchaseId))
    .where(eq(approvals.status, "PENDING"))
    .orderBy(sql`${approvals.createdAt} DESC`);
}
