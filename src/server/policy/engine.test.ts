import { describe, expect, it } from "vitest";
import { evaluate, failedRules } from "./engine";
import { periodEnd, periodStart } from "./period";
import type { PolicyInput, PolicyMandate } from "./types";

const NOW = new Date("2026-11-11T10:00:00Z");

const giftMandate = (over: Partial<PolicyMandate> = {}): PolicyMandate => ({
  status: "ACTIVE",
  budgetCents: 15000,
  hardLimitCents: 20000,
  perItemMaxCents: null,
  allowedCategories: ["gifts", "electronics", "books", "home"],
  blockedCategories: ["gift_cards", "crypto", "cash_equivalents"],
  maxOrders: 1,
  maxQuantity: 1,
  noDuplicates: true,
  expiresAt: new Date("2026-11-13T18:29:59Z"),
  ...over,
});

const input = (over: {
  mandate?: Partial<PolicyMandate>;
  spend?: Partial<PolicyInput["spend"]>;
  priceCents?: number;
  category?: string;
  quantity?: number;
  productId?: string;
  now?: Date;
}): PolicyInput => ({
  mandate: giftMandate(over.mandate),
  spend: { amountCents: 0, orders: 0, productIds: [], ...over.spend },
  request: { productId: over.productId ?? "prd_x", quantity: over.quantity ?? 1 },
  product: { priceCents: over.priceCents ?? 8999, category: over.category ?? "gifts" },
  now: over.now ?? NOW,
});

const failed = (i: PolicyInput) =>
  failedRules(evaluate(i).results)
    .map((r) => r.rule)
    .sort();

describe("decisions", () => {
  const cases: { name: string; in: PolicyInput; decision: string; failed: string[] }[] = [
    { name: "$89.99 gift passes everything", in: input({}), decision: "APPROVE", failed: [] },
    { name: "exactly at budget approves", in: input({ priceCents: 15000 }), decision: "APPROVE", failed: [] },
    { name: "one cent over budget holds", in: input({ priceCents: 15001 }), decision: "HOLD", failed: ["budget"] },
    { name: "$170 headphones hold", in: input({ priceCents: 17000, category: "electronics" }), decision: "HOLD", failed: ["budget"] },
    { name: "exactly at hard limit holds (over budget)", in: input({ priceCents: 20000 }), decision: "HOLD", failed: ["budget"] },
    { name: "one cent over hard limit blocks", in: input({ priceCents: 20001 }), decision: "BLOCK", failed: ["budget", "hard_limit"] },
    { name: "category outside allowed list holds", in: input({ category: "toys" }), decision: "HOLD", failed: ["allowed_category"] },
    { name: "empty allowed list allows nothing", in: input({ mandate: { allowedCategories: [] } }), decision: "HOLD", failed: ["allowed_category"] },
    { name: "no allowed list = any category", in: input({ category: "toys", mandate: { allowedCategories: null } }), decision: "APPROVE", failed: [] },
    { name: "blocked category blocks", in: input({ category: "crypto" }), decision: "BLOCK", failed: ["allowed_category", "blocked_category"] },
    { name: "frozen mandate blocks", in: input({ mandate: { status: "FROZEN" } }), decision: "BLOCK", failed: ["mandate_active"] },
    { name: "draft mandate blocks", in: input({ mandate: { status: "DRAFT" } }), decision: "BLOCK", failed: ["mandate_active"] },
    { name: "at expiry second still ok", in: input({ now: new Date("2026-11-13T18:29:59Z") }), decision: "APPROVE", failed: [] },
    { name: "one second after expiry blocks", in: input({ now: new Date("2026-11-13T18:30:00Z") }), decision: "BLOCK", failed: ["not_expired"] },
    { name: "no expiry never expires", in: input({ mandate: { expiresAt: null }, now: new Date("2030-01-01") }), decision: "APPROVE", failed: [] },
    { name: "max orders used blocks", in: input({ spend: { orders: 1, amountCents: 1000, productIds: ["prd_y"] } }), decision: "BLOCK", failed: ["max_orders"] },
    { name: "quantity over max blocks", in: input({ quantity: 2, priceCents: 1000 }), decision: "BLOCK", failed: ["max_quantity"] },
    {
      name: "duplicate blocks",
      in: input({ productId: "prd_y", mandate: { maxOrders: 3 }, spend: { orders: 1, amountCents: 1000, productIds: ["prd_y"] } }),
      decision: "BLOCK",
      failed: ["no_duplicate"],
    },
    {
      name: "duplicate allowed when rule off",
      in: input({ productId: "prd_y", mandate: { maxOrders: 3, noDuplicates: false }, spend: { orders: 1, amountCents: 1000, productIds: ["prd_y"] } }),
      decision: "APPROVE",
      failed: [],
    },
    { name: "per-item max blocks", in: input({ priceCents: 6000, mandate: { perItemMaxCents: 5000 } }), decision: "BLOCK", failed: ["per_item_max"] },
    { name: "per-item max at the line ok", in: input({ priceCents: 5000, mandate: { perItemMaxCents: 5000 } }), decision: "APPROVE", failed: [] },
    {
      name: "existing spend counts toward budget",
      in: input({ priceCents: 8000, mandate: { maxOrders: 2 }, spend: { orders: 1, amountCents: 8000, productIds: ["prd_y"] } }),
      decision: "HOLD",
      failed: ["budget"],
    },
    {
      name: "existing spend counts toward hard limit",
      in: input({ priceCents: 12000, mandate: { maxOrders: 2 }, spend: { orders: 1, amountCents: 8999, productIds: ["prd_y"] } }),
      decision: "BLOCK",
      failed: ["budget", "hard_limit"],
    },
    {
      name: "refunded/voided spend is excluded by caller: same request approves",
      in: input({ spend: { orders: 0, amountCents: 0, productIds: [] } }),
      decision: "APPROVE",
      failed: [],
    },
  ];

  it.each(cases)("$name", (c) => {
    expect(evaluate(c.in).decision).toBe(c.decision);
    expect(failed(c.in)).toEqual([...c.failed].sort());
  });
});

describe("prompt-injection attack", () => {
  it("5 x $100 gift cards after a $89.99 purchase fails four hard rules", () => {
    const out = evaluate(
      input({
        productId: "prd_gc100",
        priceCents: 10000,
        category: "gift_cards",
        quantity: 5,
        spend: { amountCents: 8999, orders: 1, productIds: ["prd_candle"] },
      }),
    );
    expect(out.decision).toBe("BLOCK");
    expect(
      failedRules(out.results, "hard")
        .map((r) => r.rule)
        .sort(),
    ).toEqual(["blocked_category", "hard_limit", "max_orders", "max_quantity"]);
    expect(out.results.find((r) => r.rule === "hard_limit")!.detail).toBe("$500.00 + $89.99 spent > $200.00 limit");
  });
});

describe("result shape", () => {
  it("always evaluates every rule, in order", () => {
    const rules = evaluate(input({})).results.map((r) => r.rule);
    expect(rules).toEqual([
      "mandate_active",
      "not_expired",
      "hard_limit",
      "per_item_max",
      "blocked_category",
      "max_orders",
      "max_quantity",
      "no_duplicate",
      "budget",
      "allowed_category",
    ]);
  });

  it("budget detail says how far over", () => {
    const r = evaluate(input({ priceCents: 17000 })).results.find((x) => x.rule === "budget")!;
    expect(r.detail).toBe("$20.00 over $150.00 budget");
  });
});

describe("period windows", () => {
  const tz = "Asia/Kolkata";
  const created = new Date("2026-11-01T00:00:00Z");

  it("once = whole life of the mandate", () => {
    expect(periodStart({ period: "once", timezone: tz, mandateCreatedAt: created, now: NOW })).toEqual(created);
  });

  it("weekly starts Monday 00:00 IST", () => {
    // Wed 11 Nov 2026 15:30 IST -> Mon 9 Nov 00:00 IST = Sun 8 Nov 18:30Z
    expect(periodStart({ period: "weekly", timezone: tz, mandateCreatedAt: created, now: NOW }).toISOString()).toBe(
      "2026-11-08T18:30:00.000Z",
    );
  });

  it("weekly rolls over at Monday midnight local, not UTC", () => {
    const sundayNight = new Date("2026-11-15T18:29:59Z"); // Sun 23:59:59 IST
    const mondayStart = new Date("2026-11-15T18:30:00Z"); // Mon 00:00 IST
    expect(periodStart({ period: "weekly", timezone: tz, mandateCreatedAt: created, now: sundayNight }).toISOString()).toBe(
      "2026-11-08T18:30:00.000Z",
    );
    expect(periodStart({ period: "weekly", timezone: tz, mandateCreatedAt: created, now: mondayStart }).toISOString()).toBe(
      "2026-11-15T18:30:00.000Z",
    );
  });

  it("monthly starts on the 1st local; weekly end is +7 days", () => {
    const start = periodStart({ period: "monthly", timezone: tz, mandateCreatedAt: created, now: NOW });
    expect(start.toISOString()).toBe("2026-10-31T18:30:00.000Z");
    expect(periodEnd({ period: "monthly", timezone: tz, start })!.toISOString()).toBe("2026-11-30T18:30:00.000Z");
    const wk = periodStart({ period: "weekly", timezone: tz, mandateCreatedAt: created, now: NOW });
    expect(periodEnd({ period: "weekly", timezone: tz, start: wk })!.toISOString()).toBe("2026-11-15T18:30:00.000Z");
  });

  it("handles DST zones (New York, week containing 1 Nov 2026 fall-back)", () => {
    const now = new Date("2026-11-04T15:00:00Z"); // Wed
    expect(periodStart({ period: "weekly", timezone: "America/New_York", mandateCreatedAt: created, now }).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });
});
