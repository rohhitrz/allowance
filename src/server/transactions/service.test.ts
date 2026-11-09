/**
 * Integration tests: real Postgres (TEST_DATABASE_URL), fake PayPal gateway.
 * Covers every money path in the demo plus the parallel-request race.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, db } from "../db";
import { events, paypalVaults, purchases } from "../db/schema";
import { bus, inTransaction, recordEvent } from "../events/bus";
import { listApprovals } from "../app";
import { runVoiceTool } from "../voice/tools";
import { runDemoStep } from "../demo/script";
import { POST as vapiTools } from "../../app/api/voice/tools/route";
import { PayPalError } from "../paypal/client";
import { CANDLE_SET_ID, GIFT_CARD_100_ID, HEADPHONES_ID, resetDemo } from "../db/seed";
import { confirmMandate, createDraft, unfreezeMandate } from "../mandates/service";
import { getReceipt } from "../receipts";
import { settleHold } from "../agent/runner";
import { approvals } from "../db/schema";
import { setGateway, type PaymentGateway } from "./gateway";
import {
  cancelFallbackPurchase,
  completeFallbackAuthorization,
  decideApproval,
  freezeAll,
  refundPurchase,
  recheckPendingCaptures,
  releaseStaleReservations,
  requestPurchase,
  retryOpenVoids,
} from "./service";

const TEST_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_URL ? describe : describe.skip;

type Call = { op: string; args: Record<string, unknown> };
let calls: Call[] = [];
let n = 0;
const fake: PaymentGateway = {
  async authorizeWithVault(args) {
    calls.push({ op: "authorize", args });
    return { orderId: `ORD${++n}`, orderStatus: "COMPLETED", authorizationId: `AUTH${n}`, authorizationStatus: "CREATED" };
  },
  async createOrderForApproval(args) {
    calls.push({ op: "order", args });
    return { orderId: `ORD${++n}`, approveUrl: "https://paypal.test/approve" };
  },
  async authorizeOrder(args) {
    calls.push({ op: "authorizeOrder", args });
    return { orderId: args.orderId, authorizationId: `AUTH${++n}`, authorizationStatus: "CREATED" };
  },
  async captureAuthorization(args) {
    calls.push({ op: "capture", args });
    return { captureId: `CAP${++n}`, status: "COMPLETED" };
  },
  async voidAuthorization(args) {
    calls.push({ op: "void", args });
    return { status: "VOIDED" };
  },
  async refundCapture(args) {
    calls.push({ op: "refund", args });
    return { refundId: `REF${++n}`, status: "COMPLETED" };
  },
  // Reads: by default PayPal agrees with the simplest story (authorization still open).
  async getAuthorization(authorizationId) {
    return { id: authorizationId, status: "CREATED", amount: { value: "0.00" } };
  },
  async getOrderCaptures() {
    return [];
  },
  async getCapture(captureId) {
    return { captureId, status: "COMPLETED" };
  },
};

const ops = () => calls.map((c) => c.op);

async function giftMandate(over: Partial<{ maxOrders: number; hardLimitCents: number }> = {}) {
  const { mandate } = await createDraft({
    text: "Birthday gift for my sister, around $150, never more than $200, no gift cards, one purchase",
    actor: "user:dashboard",
    draft: {
      title: "Birthday gift for sister",
      brief: "A thoughtful birthday gift for my sister",
      budgetCents: 15000,
      hardLimitCents: over.hardLimitCents ?? 20000,
      perItemMaxCents: null,
      allowedCategories: ["gifts", "electronics", "books", "home"],
      extraBlockedCategories: [],
      maxOrders: over.maxOrders ?? 1,
      maxQuantity: 1,
      noDuplicates: true,
      period: "once",
      expiresAt: null,
    },
  });
  return confirmMandate(mandate.id, "user:dashboard");
}

const buy = (mandateId: string, productId: string, quantity = 1) =>
  requestPurchase({ mandateId, productId, quantity, reason: "test", actor: "agent:allowance" });

suite("transaction service", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    await migrate(db(), { migrationsFolder: "./drizzle" });
    setGateway(fake);
  });
  afterAll(async () => {
    setGateway(null);
    await closeDb();
  });
  beforeEach(async () => {
    await resetDemo({ vault: { vaultId: "VAULT_TEST", payerEmail: "buyer@example.com" } });
    calls = [];
  });

  it("the full demo story: hold -> reject -> void, then approve -> capture, then injection blocked", async () => {
    const m = await giftMandate();

    // $170 headphones: over budget, under hard limit -> held
    const held = await buy(m.id, HEADPHONES_ID);
    expect(held.purchase.status).toBe("HELD");
    expect(held.approval?.prompt).toBe(
      "Premium Noise-Cancelling Headphones, $170.00. That's $20.00 over your $150.00 budget but under your $200.00 limit. Approve or reject?",
    );
    expect(ops()).toEqual(["authorize"]);

    // The agent can't approve its own hold
    await expect(decideApproval({ approvalId: held.approval!.id, decision: "approve", actor: "agent:allowance" })).rejects.toThrow(
      /cannot do this/,
    );

    const rejected = await decideApproval({ approvalId: held.approval!.id, decision: "reject", actor: "user:voice" });
    expect(rejected.purchase.status).toBe("VOIDED");
    expect(ops()).toEqual(["authorize", "void"]);

    // Rejection released the one allowed order, so the $89.99 gift goes through
    const ok = await buy(m.id, CANDLE_SET_ID);
    expect(ok.purchase.status).toBe("CAPTURED");
    expect(ops()).toEqual(["authorize", "void", "authorize", "capture"]);

    // Prompt injection: 5 x $100 gift cards. Blocked, PayPal never called.
    calls = [];
    const attack = await buy(m.id, GIFT_CARD_100_ID, 5);
    expect(attack.purchase.status).toBe("BLOCKED");
    expect(attack.purchase.paypalCalled).toBe(false);
    expect(calls).toEqual([]);
    const receipt = await getReceipt(attack.purchase.id);
    expect(receipt.summary).toMatch(/^Blocked by 4 hard rules: .*PayPal was never called\.$/);
    expect(receipt.mandateSnapshot.version).toBe(1);
    expect(receipt.timeline.map((e) => e.type)).toEqual(["purchase.proposed", "purchase.blocked"]);
  });

  it("approve after hold captures; a second decision is a no-op", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    const first = await decideApproval({ approvalId: held.approval!.id, decision: "approve", actor: "user:voice" });
    expect(first.purchase.status).toBe("CAPTURED");
    const again = await decideApproval({ approvalId: held.approval!.id, decision: "reject", actor: "user:voice" });
    expect(again.alreadyDecided).toBe(true);
    expect(again.purchase.status).toBe("CAPTURED");
    expect(ops()).toEqual(["authorize", "capture"]);
  });

  it("unclear answers count as reject", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    const out = await decideApproval({ approvalId: held.approval!.id, decision: "sure, why not", actor: "user:voice" });
    expect(out.purchase.status).toBe("VOIDED");
  });

  it("expired approvals void instead of capturing", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    const out = await decideApproval({
      approvalId: held.approval!.id,
      decision: "approve",
      actor: "user:voice",
      now: new Date(Date.now() + 11 * 60_000),
    });
    expect(out.approval.status).toBe("EXPIRED");
    expect(out.purchase.status).toBe("VOIDED");
  });

  it("kill switch freezes, voids the open hold, and blocks the next attempt", async () => {
    const m = await giftMandate();
    await buy(m.id, HEADPHONES_ID);
    const res = await freezeAll({ actor: "user:voice", userId: "usr_demo" });
    expect(res).toEqual({ frozen: 2, voided: 1 }); // gift + seeded grocery mandate
    calls = [];
    const retry = await buy(m.id, CANDLE_SET_ID);
    expect(retry.purchase.status).toBe("BLOCKED");
    expect(retry.purchase.ruleResults.find((r) => r.rule === "mandate_active")!.passed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("unfreeze bumps the version, so a pre-freeze approval can't capture", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    // Freeze and unfreeze without the kill switch voiding (simulate a stale token surviving)
    await db().execute(sql`UPDATE mandates SET status = 'FROZEN' WHERE id = ${m.id}`);
    const un = await unfreezeMandate(m.id, "user:dashboard");
    expect(un.version).toBe(2);
    const out = await decideApproval({ approvalId: held.approval!.id, decision: "approve", actor: "user:voice" });
    expect(out.purchase.status).toBe("VOIDED");
    expect(out.note).toMatch(/mandate changed/);
  });

  it("parallel requests can't exceed the hard limit", async () => {
    // Two $120-ish items each fit alone; together they break the $200 hard limit.
    const m = await giftMandate({ maxOrders: 5 });
    const results = await Promise.all([buy(m.id, "prd_jewelry_box"), buy(m.id, "prd_ereader")]);
    const statuses = results.map((r) => r.purchase.status).sort();
    expect(statuses).toEqual(["BLOCKED", "CAPTURED"]);
    const live = await db().select().from(purchases).where(eq(purchases.status, "CAPTURED"));
    expect(live.reduce((s, p) => s + p.totalCents, 0)).toBeLessThanOrEqual(20000);
  });

  it("refund frees the budget", async () => {
    const m = await giftMandate();
    const ok = await buy(m.id, CANDLE_SET_ID);
    await expect(refundPurchase(ok.purchase.id, "mcp:claude-desktop")).rejects.toThrow(/cannot do this/);
    const r = await refundPurchase(ok.purchase.id, "user:dashboard", "changed my mind");
    expect(r.status).toBe("REFUNDED");
    const again = await buy(m.id, "prd_spa_set");
    expect(again.purchase.status).toBe("CAPTURED");
  });

  it("Postgres refuses a BLOCKED purchase that claims PayPal was called", async () => {
    const m = await giftMandate();
    const attack = await buy(m.id, GIFT_CARD_100_ID, 5);
    await expect(db().execute(sql`UPDATE purchases SET paypal_called = true WHERE id = ${attack.purchase.id}`)).rejects.toThrow();
  });

  it("Postgres refuses to drop the locked blocked categories", async () => {
    const m = await giftMandate();
    await expect(db().execute(sql`UPDATE mandates SET blocked_categories = ARRAY['crypto'] WHERE id = ${m.id}`)).rejects.toThrow();
  });

  it("PayPal failure marks FAILED and releases the reservation", async () => {
    const m = await giftMandate();
    setGateway({ ...fake, authorizeWithVault: async () => Promise.reject(new Error("sandbox down")) });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("FAILED");
      expect(r.purchase.failureReason).toBe("sandbox down");
    } finally {
      setGateway(fake);
    }
    const retry = await buy(m.id, CANDLE_SET_ID);
    expect(retry.purchase.status).toBe("CAPTURED");
  });

  // ---------- code review fixes ----------

  it("a capture PayPal confirmed is never recorded as FAILED, even if the row moved meanwhile", async () => {
    const m = await giftMandate();
    setGateway({
      ...fake,
      async captureAuthorization(args) {
        // Simulate the purchase row changing under us right after PayPal captured.
        await db().execute(sql`UPDATE purchases SET status = 'VOIDED' WHERE paypal_authorization_id = ${args.authorizationId}`);
        return fake.captureAuthorization(args);
      },
    });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("CAPTURED");
      expect(r.purchase.paypalCaptureId).toMatch(/^CAP/);
    } finally {
      setGateway(fake);
    }
  });

  it("a lost capture response is retried with the same request id", async () => {
    const m = await giftMandate();
    let first = true;
    setGateway({
      ...fake,
      async captureAuthorization(args) {
        calls.push({ op: "capture", args });
        if (first) {
          first = false;
          throw new Error("socket hang up");
        }
        return { captureId: "CAP_RETRY", status: "COMPLETED" };
      },
    });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("CAPTURED");
      const caps = calls.filter((c) => c.op === "capture");
      expect(caps).toHaveLength(2);
      expect(caps[0].args.requestId).toBe(caps[1].args.requestId);
    } finally {
      setGateway(fake);
    }
  });

  it("a refused capture whose void also fails stays open and reconcile voids it", async () => {
    const m = await giftMandate();
    setGateway({
      ...fake,
      captureAuthorization: async () => Promise.reject(new Error("capture declined")),
      voidAuthorization: async () => Promise.reject(new Error("void timeout")),
    });
    let pid: string;
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      pid = r.purchase.id;
      expect(r.purchase.status).toBe("AUTHORIZED"); // money still held, so it must stay visible
      expect(r.purchase.failureReason).toMatch(/^void failed:/);
    } finally {
      setGateway(fake);
    }
    expect(await retryOpenVoids()).toBe(1);
    const [after] = await db().select().from(purchases).where(eq(purchases.id, pid!));
    expect(after.status).toBe("VOIDED");
  });

  it("kill-switch voids that fail are retried by the sweep", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    setGateway({ ...fake, voidAuthorization: async () => Promise.reject(new Error("PayPal 503")) });
    try {
      const f = await freezeAll({ actor: "user:voice", userId: "usr_demo" });
      expect(f.voided).toBe(0);
    } finally {
      setGateway(fake);
    }
    const [stuck] = await db().select().from(purchases).where(eq(purchases.id, held.purchase.id));
    expect(stuck.status).toBe("HELD");
    expect(await retryOpenVoids()).toBe(1);
    const [after] = await db().select().from(purchases).where(eq(purchases.id, held.purchase.id));
    expect(after.status).toBe("VOIDED");
  });

  it("an authorization PayPal creates as PENDING is voided, never captured", async () => {
    const m = await giftMandate();
    setGateway({
      ...fake,
      async authorizeWithVault(args) {
        calls.push({ op: "authorize", args });
        return { orderId: "ORD_P", orderStatus: "COMPLETED", authorizationId: "AUTH_P", authorizationStatus: "PENDING" };
      },
    });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("VOIDED");
      expect(r.purchase.failureReason).toBe("PayPal authorization was PENDING");
      expect(ops()).toEqual(["authorize", "void"]);
    } finally {
      setGateway(fake);
    }
  });

  it("an abandoned PayPal popup releases the reservation", async () => {
    await db().update(paypalVaults).set({ status: "REVOKED" });
    const m = await giftMandate();
    const r = await buy(m.id, CANDLE_SET_ID);
    expect(r.purchase.status).toBe("RESERVED");
    expect(r.purchase.paypalApproveUrl).toBeTruthy();

    // Still inside the window: nothing released, and the one order is taken.
    expect(await releaseStaleReservations(new Date(Date.now() + 5 * 60_000))).toBe(0);
    expect((await buy(m.id, "prd_spa_set")).purchase.status).toBe("BLOCKED");

    expect(await releaseStaleReservations(new Date(Date.now() + 11 * 60_000))).toBe(1);
    const [after] = await db().select().from(purchases).where(eq(purchases.id, r.purchase.id));
    expect(after.status).toBe("FAILED");
    expect(after.failureReason).toBe("buyer did not approve in PayPal in time");
    const again = await buy(m.id, "prd_spa_set");
    expect(again.purchase.ruleResults.find((x) => x.rule === "max_orders")!.passed).toBe(true);
  });

  it("a cancelled PayPal popup releases the reservation at once", async () => {
    await db().update(paypalVaults).set({ status: "REVOKED" });
    const m = await giftMandate();
    const r = await buy(m.id, CANDLE_SET_ID);
    const cancelled = await cancelFallbackPurchase(r.purchase.id, "user:dashboard");
    expect(cancelled.status).toBe("FAILED");
  });

  it("parallel retries with one idempotency key make one purchase", async () => {
    const m = await giftMandate();
    const req = () =>
      requestPurchase({ mandateId: m.id, productId: CANDLE_SET_ID, quantity: 1, reason: "t", actor: "agent:allowance", idempotencyKey: "key-1" });
    const [a, b] = await Promise.all([req(), req()]);
    expect(a.purchase.id).toBe(b.purchase.id);
    const rows = await db().select().from(purchases).where(eq(purchases.idempotencyKey, "key-1"));
    expect(rows).toHaveLength(1);
    expect(ops().filter((o) => o === "authorize")).toHaveLength(1);
  });

  it("events reach live listeners only after commit, and never after a rollback", async () => {
    const seen: string[] = [];
    const listener = (e: { type: string }) => seen.push(e.type);
    bus.on("event", listener);
    try {
      await expect(
        inTransaction(async (tx) => {
          await recordEvent(tx, { actor: "system", type: "run.step" });
          expect(seen).toEqual([]); // not yet: still inside the transaction
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(seen).toEqual([]);
      expect(await db().select().from(events).where(eq(events.type, "run.step"))).toHaveLength(0);

      await inTransaction((tx) => recordEvent(tx, { actor: "system", type: "run.step" }));
      expect(seen).toEqual(["run.step"]);
    } finally {
      bus.off("event", listener);
    }
  });

  it("the pre-capture re-check runs the full engine against the current mandate", async () => {
    const m = await giftMandate();
    setGateway({
      ...fake,
      async authorizeWithVault(args) {
        // The mandate is frozen while PayPal is authorizing.
        await db().execute(sql`UPDATE mandates SET status = 'FROZEN' WHERE id = ${m.id}`);
        return fake.authorizeWithVault(args);
      },
    });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("VOIDED");
      expect(r.purchase.failureReason).toBe("re-check failed: mandate is FROZEN");
      expect(ops()).toEqual(["authorize", "void"]);
    } finally {
      setGateway(fake);
    }
  });

  // ---------- second review (Cursor) ----------

  it.each(["DECLINED", "FAILED"])("a capture PayPal reports as %s is voided and marked FAILED, not CAPTURED", async (st) => {
    const m = await giftMandate();
    setGateway({
      ...fake,
      async captureAuthorization(args) {
        calls.push({ op: "capture", args });
        return { captureId: "CAP_BAD", status: st };
      },
    });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("FAILED");
      expect(r.purchase.failureReason).toBe(`PayPal capture CAP_BAD was ${st}`);
      expect(ops()).toEqual(["authorize", "capture", "void"]);
    } finally {
      setGateway(fake);
    }
  });

  it("a PENDING capture is recorded as captured and flagged on the receipt", async () => {
    const m = await giftMandate();
    setGateway({ ...fake, captureAuthorization: async () => ({ captureId: "CAP_PEND", status: "PENDING" }) });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("CAPTURED");
      expect((await getReceipt(r.purchase.id)).summary).toMatch(/still PENDING/);
    } finally {
      setGateway(fake);
    }
  });

  it("when the agent stops waiting on an expired hold, the hold is released without the server sweep", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    await db().update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, held.approval!.id));
    await settleHold(held.purchase.id);
    const [p] = await db().select().from(purchases).where(eq(purchases.id, held.purchase.id));
    const [a] = await db().select().from(approvals).where(eq(approvals.id, held.approval!.id));
    expect(a.status).toBe("EXPIRED");
    expect(p.status).toBe("VOIDED");
  });

  it("a decision whose void failed is finished by the next settle, not skipped", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    setGateway({ ...fake, voidAuthorization: async () => Promise.reject(new Error("PayPal 503")) });
    try {
      const d = await decideApproval({ approvalId: held.approval!.id, decision: "reject", actor: "user:voice" });
      expect(d.purchase.status).toBe("HELD"); // still held: PayPal didn't confirm the void
      const again = await decideApproval({ approvalId: held.approval!.id, decision: "reject", actor: "user:voice" });
      expect(again.alreadyDecided).toBe(true);
    } finally {
      setGateway(fake);
    }
    // PayPal is back: repeating the decision finishes the void.
    const third = await decideApproval({ approvalId: held.approval!.id, decision: "reject", actor: "user:voice" });
    expect(third.alreadyDecided).toBe(true);
    expect(third.purchase.status).toBe("VOIDED");
  });
  // ---------- third review ----------

  const row = async (purchaseId: string) => (await db().select().from(purchases).where(eq(purchases.id, purchaseId)))[0];

  it("a capture whose responses were both lost is recorded as CAPTURED, not voided", async () => {
    const m = await giftMandate();
    setGateway({
      ...fake,
      async captureAuthorization(args) {
        calls.push({ op: "capture", args });
        throw new Error("socket hang up"); // PayPal took the money; we never heard back
      },
      async voidAuthorization(args) {
        calls.push({ op: "void", args });
        throw new PayPalError("AUTHORIZATION_ALREADY_CAPTURED", 422);
      },
      getAuthorization: async (id) => ({ id, status: "CAPTURED", amount: { value: "89.99" } }),
      getOrderCaptures: async () => [{ captureId: "CAP_LOST", status: "COMPLETED" }],
    });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("CAPTURED");
      expect(r.purchase.paypalCaptureId).toBe("CAP_LOST"); // refundable
      expect(ops()).toEqual(["authorize", "capture", "capture"]); // never tried to void a charged authorization
      const refunded = await refundPurchase(r.purchase.id, "user:dashboard");
      expect(refunded.status).toBe("REFUNDED");
    } finally {
      setGateway(fake);
    }
  });

  it("captured at PayPal but the capture id can't be found yet: stays open, and the sweep records it", async () => {
    const m = await giftMandate();
    const lost: PaymentGateway = {
      ...fake,
      captureAuthorization: async () => Promise.reject(new Error("socket hang up")),
      voidAuthorization: async () => Promise.reject(new PayPalError("AUTHORIZATION_ALREADY_CAPTURED", 422)),
      getAuthorization: async (id) => ({ id, status: "CAPTURED", amount: { value: "89.99" } }),
      getOrderCaptures: async () => Promise.reject(new Error("timeout")),
    };
    setGateway(lost);
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      expect(r.purchase.status).toBe("AUTHORIZED"); // still counted as spend; not FAILED, not VOIDED
      setGateway({ ...lost, getOrderCaptures: async () => [{ captureId: "CAP_FOUND", status: "COMPLETED" }] });
      await retryOpenVoids();
      const after = await row(r.purchase.id);
      expect(after.status).toBe("CAPTURED");
      expect(after.paypalCaptureId).toBe("CAP_FOUND");
    } finally {
      setGateway(fake);
    }
  });

  it("a void PayPal already did (response lost) is recorded as VOIDED and frees the budget", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    setGateway({
      ...fake,
      voidAuthorization: async () => Promise.reject(new PayPalError("AUTHORIZATION_VOIDED", 422)),
      getAuthorization: async (id) => ({ id, status: "VOIDED", amount: { value: "170.00" } }),
    });
    try {
      const d = await decideApproval({ approvalId: held.approval!.id, decision: "reject", actor: "user:voice" });
      expect(d.purchase.status).toBe("VOIDED");
      expect(d.purchase.failureReason).toMatch(/already shows the authorization VOIDED/);
    } finally {
      setGateway(fake);
    }
    expect((await buy(m.id, CANDLE_SET_ID)).purchase.status).toBe("CAPTURED"); // the one order is free again
  });

  it("a reservation stuck mid-authorize is recovered from PayPal and voided, not just marked FAILED", async () => {
    const m = await giftMandate();
    // Simulate a crash after PayPal was called but before its answer was stored.
    setGateway({ ...fake, authorizeWithVault: async () => new Promise(() => {}) });
    void buy(m.id, CANDLE_SET_ID);
    await new Promise((r) => setTimeout(r, 300));
    setGateway(fake);
    const [stuck] = await db().select().from(purchases).where(eq(purchases.mandateId, m.id));
    expect(stuck.status).toBe("RESERVED");
    expect(stuck.paypalCalled).toBe(true);
    calls = [];

    expect(await releaseStaleReservations(new Date(Date.now() + 60_000))).toBe(0); // too soon
    expect(await releaseStaleReservations(new Date(Date.now() + 3 * 60_000))).toBe(1);
    const after = await row(stuck.id);
    expect(after.status).toBe("VOIDED");
    expect(after.paypalAuthorizationId).toMatch(/^AUTH/);
    expect(ops()).toEqual(["authorize", "void"]);
    expect(calls[0].args.requestId).toBe(`${stuck.id}:authorize`); // same request id: PayPal replays, never doubles
  });

  it("a stuck reservation PayPal refuses outright is FAILED; an unreachable PayPal leaves it for the next sweep", async () => {
    const m = await giftMandate();
    setGateway({ ...fake, authorizeWithVault: async () => new Promise(() => {}) });
    void buy(m.id, CANDLE_SET_ID);
    await new Promise((r) => setTimeout(r, 300));
    const [stuck] = await db().select().from(purchases).where(eq(purchases.mandateId, m.id));
    const later = new Date(Date.now() + 3 * 60_000);
    try {
      setGateway({ ...fake, authorizeWithVault: async () => Promise.reject(new Error("ECONNRESET")) });
      expect(await releaseStaleReservations(later)).toBe(0);
      expect((await row(stuck.id)).status).toBe("RESERVED");
      setGateway({ ...fake, authorizeWithVault: async () => Promise.reject(new PayPalError("INSTRUMENT_DECLINED", 422)) });
      expect(await releaseStaleReservations(later)).toBe(1);
      expect((await row(stuck.id)).status).toBe("FAILED");
    } finally {
      setGateway(fake);
    }
  });

  it("a PENDING capture is re-checked: COMPLETED clears the flag, DECLINED releases the budget", async () => {
    const m = await giftMandate({ maxOrders: 2 });
    setGateway({ ...fake, captureAuthorization: async () => ({ captureId: "CAP_PEND", status: "PENDING" }) });
    try {
      const r = await buy(m.id, CANDLE_SET_ID);
      setGateway({ ...fake, getCapture: async (captureId) => ({ captureId, status: "PENDING" }) });
      expect(await recheckPendingCaptures()).toBe(0);
      setGateway({ ...fake, getCapture: async (captureId) => ({ captureId, status: "DECLINED" }) });
      expect(await recheckPendingCaptures()).toBe(1);
      const after = await row(r.purchase.id);
      expect(after.status).toBe("FAILED");
      expect(after.failureReason).toMatch(/DECLINED after pending/);

      setGateway({ ...fake, captureAuthorization: async () => ({ captureId: "CAP_PEND2", status: "PENDING" }) });
      const r2 = await buy(m.id, CANDLE_SET_ID);
      setGateway(fake); // getCapture -> COMPLETED
      expect(await recheckPendingCaptures()).toBe(1);
      const ok = await row(r2.purchase.id);
      expect(ok.status).toBe("CAPTURED");
      expect(ok.failureReason).toBeNull();
    } finally {
      setGateway(fake);
    }
  });

  it("listing pending approvals makes no PayPal calls and hides expired holds", async () => {
    const m = await giftMandate();
    const held = await buy(m.id, HEADPHONES_ID);
    expect(await listApprovals("PENDING")).toHaveLength(1);
    await db().update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, held.approval!.id));
    calls = [];
    expect(await listApprovals("PENDING")).toHaveLength(0);
    expect(ops()).toEqual([]);
    expect((await row(held.purchase.id)).status).toBe("HELD"); // the sweep, not the read, voids it
  });

  it("the no-vault popup flow finishes: buyer approves -> authorize -> capture", async () => {
    await db().update(paypalVaults).set({ status: "REVOKED" });
    const m = await giftMandate();
    const r = await buy(m.id, CANDLE_SET_ID);
    expect(r.purchase.status).toBe("RESERVED");
    expect(r.purchase.paypalApproveUrl).toBe("https://paypal.test/approve");
    const done = await completeFallbackAuthorization(r.purchase.id, "user:dashboard");
    expect(done.purchase.status).toBe("CAPTURED");
    expect(ops()).toEqual(["order", "authorizeOrder", "capture"]);
  });
  it("voice never guesses which hold to decide: with two waiting and no id, nothing is decided", async () => {
    const a = await giftMandate();
    const b = await giftMandate();
    const first = await buy(a.id, HEADPHONES_ID);
    const second = await buy(b.id, HEADPHONES_ID);

    const blind = await runVoiceTool("decide_approval", { decision: "approve" }, "user:voice");
    expect(blind.status).toBe("AMBIGUOUS");
    expect((await row(first.purchase.id)).status).toBe("HELD");
    expect((await row(second.purchase.id)).status).toBe("HELD");

    // The prompt that is read out comes with its id (oldest first), and that id is what gets decided.
    const read = await runVoiceTool("get_pending_approval", {}, "user:voice");
    expect(read.approvalId).toBe(first.approval!.id);
    await runVoiceTool("decide_approval", { approvalId: read.approvalId, decision: "approve" }, "user:voice");
    expect((await row(first.purchase.id)).status).toBe("CAPTURED");
    expect((await row(second.purchase.id)).status).toBe("HELD");

    // One left: no id is now unambiguous.
    const last = await runVoiceTool("decide_approval", { decision: "reject" }, "user:voice");
    expect(last.status).toBe("VOIDED");
  });

  it("one malformed Vapi tool call gets an error result; the rest of the batch still runs", async () => {
    vi.stubEnv("VAPI_WEBHOOK_SECRET", "s3cret");
    try {
      const res = await vapiTools(
        new Request("http://x/api/voice/tools", {
          method: "POST",
          headers: { "x-vapi-secret": "s3cret" },
          body: JSON.stringify({
            message: {
              type: "tool-calls",
              toolCallList: [
                { id: "c1", function: { name: "decide_approval", arguments: "{not json" } },
                null,
                { id: "c3", function: { name: "get_pending_approval", arguments: "{}" } },
              ],
            },
          }),
        }),
        { params: Promise.resolve({}) },
      );
      expect(res.status).toBe(200);
      const { results } = (await res.json()) as { results: { toolCallId?: string; result: string }[] };
      expect(results).toHaveLength(3);
      expect(JSON.parse(results[0].result).error).toMatch(/not valid JSON/);
      expect(JSON.parse(results[1].result).error).toBeTruthy();
      expect(JSON.parse(results[2].result)).toEqual({ none: true, message: "Nothing is waiting for you." });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("running the demo's mandate step twice is a clear error, not a crash", async () => {
    await runDemoStep("mandate");
    await expect(runDemoStep("mandate")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it("coming back from PayPal before approving keeps the reservation; it can still be approved", async () => {
    await db().update(paypalVaults).set({ status: "REVOKED" });
    const m = await giftMandate();
    const r = await buy(m.id, CANDLE_SET_ID);
    setGateway({ ...fake, authorizeOrder: async () => Promise.reject(new PayPalError("POST /authorize failed (422): ORDER_NOT_APPROVED", 422)) });
    try {
      await expect(completeFallbackAuthorization(r.purchase.id, "user:dashboard")).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect((await row(r.purchase.id)).status).toBe("RESERVED");
    } finally {
      setGateway(fake);
    }
    expect((await completeFallbackAuthorization(r.purchase.id, "user:dashboard")).purchase.status).toBe("CAPTURED");
  });
});
