/**
 * Integration tests: real Postgres (TEST_DATABASE_URL), fake PayPal gateway.
 * Covers every money path in the demo plus the parallel-request race.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDb, db } from "../db";
import { purchases } from "../db/schema";
import { CANDLE_SET_ID, GIFT_CARD_100_ID, HEADPHONES_ID, resetDemo } from "../db/seed";
import { confirmMandate, createDraft, unfreezeMandate } from "../mandates/service";
import { getReceipt } from "../receipts";
import { setGateway, type PaymentGateway } from "./gateway";
import { decideApproval, freezeAll, refundPurchase, requestPurchase } from "./service";

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
});
