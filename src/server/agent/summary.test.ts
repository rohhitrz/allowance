import { describe, expect, it } from "vitest";
import { finishSummary } from "./runner";
import type { PurchaseResult } from "../transactions/service";

const rules = { hardLimit: { amountCents: 500 }, allowedCategories: ["gifts", "books", "home"] };
const last = (status: string) => ({ purchase: { status, quantity: 1, productName: "Herb Kit", totalCents: 4500 } }) as unknown as PurchaseResult;

describe("agent finish summary", () => {
  it("says nothing was bought, and why, when nothing fits", () => {
    expect(finishSummary(rules, null)).toBe(
      "I stopped without buying anything: nothing I found fits your rules (at most $5.00 in gifts, books or home). Raise the limit or change the categories and start again.",
    );
  });
  it("names the last attempt when there was one", () => {
    expect(finishSummary(rules, last("BLOCKED"))).toContain("My last try, Herb Kit ($45.00), was blocked by your rules.");
  });
  it("reports a purchase", () => {
    expect(finishSummary(rules, last("CAPTURED"))).toBe("Done: I bought 1 × Herb Kit for $45.00.");
  });
});
