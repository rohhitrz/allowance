import { describe, expect, it } from "vitest";
import { applyDefaults, summarize, type MandateDraftInput } from "./rules";

const NOW = new Date("2026-11-10T06:00:00Z");
const base: MandateDraftInput = {
  title: "Birthday gift for sister",
  brief: "A birthday gift for my sister",
  budgetCents: 15000,
  hardLimitCents: 20000,
  perItemMaxCents: null,
  allowedCategories: ["Gifts", "electronics", "books", "home"],
  extraBlockedCategories: ["gift cards"],
  maxOrders: 1,
  maxQuantity: null,
  noDuplicates: null,
  period: "once",
  expiresAt: "2026-11-13T18:29:59Z",
};
const opts = { now: NOW, timezone: "Asia/Kolkata" };

describe("applyDefaults", () => {
  it("normalises categories and always locks gift cards, crypto and cash equivalents", () => {
    const r = applyDefaults({ ...base, extraBlockedCategories: [] }, opts);
    expect(r.blockedCategories).toEqual(["gift_cards", "crypto", "cash_equivalents"]);
    expect(r.allowedCategories).toEqual(["gifts", "electronics", "books", "home"]);
    expect(r.maxQuantity).toBe(1);
    expect(r.noDuplicates).toBe(true);
  });

  it("an allowed category can never re-allow a blocked one", () => {
    const r = applyDefaults({ ...base, allowedCategories: ["gifts", "gift_cards"] }, opts);
    expect(r.allowedCategories).toEqual(["gifts"]);
  });

  it("hard limit defaults to budget x 1.2, one-off defaults to 1 order and +7 days", () => {
    const r = applyDefaults({ ...base, hardLimitCents: null, maxOrders: null, expiresAt: null }, opts);
    expect(r.hardLimitCents).toBe(18000);
    expect(r.maxOrders).toBe(1);
    expect(r.expiresAt!.toISOString()).toBe("2026-11-17T06:00:00.000Z");
  });

  it("recurring defaults to 10 orders and no expiry", () => {
    const r = applyDefaults({ ...base, period: "weekly", maxOrders: null, expiresAt: null }, opts);
    expect(r.maxOrders).toBe(10);
    expect(r.expiresAt).toBeNull();
  });

  it("refuses an allowed list that is entirely blocked (never 'any category')", () => {
    expect(() => applyDefaults({ ...base, allowedCategories: ["gift cards", "crypto"] }, opts)).toThrow(/also blocked/);
  });

  it("rejects nonsense", () => {
    expect(() => applyDefaults({ ...base, budgetCents: 0 }, opts)).toThrow();
    expect(() => applyDefaults({ ...base, hardLimitCents: 100 }, opts)).toThrow(/below the budget/);
    expect(() => applyDefaults({ ...base, expiresAt: "2026-11-01T00:00:00Z" }, opts)).toThrow(/past/);
  });
});

describe("summarize", () => {
  it("reads the gift mandate back in plain words", () => {
    expect(summarize(applyDefaults(base, opts))).toBe(
      "Birthday gift for sister: aim for $150.00, never more than $200.00, one purchase, only gifts, electronics, books or home, no gift cards, crypto or cash equivalents, until Friday 13 November. Should I start?",
    );
  });

  it("reads a weekly budget back", () => {
    const s = summarize(applyDefaults({ ...base, title: "Weekly groceries", budgetCents: 20000, hardLimitCents: 22000, period: "weekly", maxOrders: 10, allowedCategories: null, expiresAt: null }, opts));
    expect(s).toBe(
      "Weekly groceries: $200.00 a week, never more than $220.00, up to 10 orders a week, no gift cards, crypto or cash equivalents. Should I start?",
    );
  });
});
