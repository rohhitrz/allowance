/**
 * The policy engine. Decides whether money may move.
 *
 * Pure function: no I/O, no clock, no LLM. Every rule is always evaluated so
 * the receipt can show the full list, not just the first failure.
 *   any hard rule fails -> BLOCK
 *   else any soft rule fails -> HOLD
 *   else -> APPROVE
 */
import { fmt } from "../money";
import type { PolicyInput, PolicyOutput, RuleResult } from "./types";

export function evaluate(input: PolicyInput): PolicyOutput {
  const { mandate: m, spend, request, product, now } = input;
  const total = product.priceCents * request.quantity;
  const after = spend.amountCents + total;
  const spentNote = spend.amountCents > 0 ? ` + ${fmt(spend.amountCents)} spent` : "";

  const results: RuleResult[] = [
    {
      rule: "mandate_active",
      kind: "hard",
      passed: m.status === "ACTIVE",
      detail: m.status === "ACTIVE" ? "ACTIVE" : `mandate is ${m.status}`,
    },
    m.expiresAt === null
      ? { rule: "not_expired", kind: "hard", passed: true, detail: "no expiry" }
      : {
          rule: "not_expired",
          kind: "hard",
          passed: now.getTime() <= m.expiresAt.getTime(),
          detail:
            now.getTime() <= m.expiresAt.getTime()
              ? `expires ${m.expiresAt.toISOString()}`
              : `expired at ${m.expiresAt.toISOString()}`,
        },
    {
      rule: "hard_limit",
      kind: "hard",
      passed: after <= m.hardLimitCents,
      detail:
        after <= m.hardLimitCents
          ? `${fmt(total)}${spentNote} within ${fmt(m.hardLimitCents)} limit`
          : `${fmt(total)}${spentNote} > ${fmt(m.hardLimitCents)} limit`,
    },
    m.perItemMaxCents === null
      ? { rule: "per_item_max", kind: "hard", passed: true, detail: "no per-item limit" }
      : {
          rule: "per_item_max",
          kind: "hard",
          passed: product.priceCents <= m.perItemMaxCents,
          detail: `${fmt(product.priceCents)} ${product.priceCents <= m.perItemMaxCents ? "<=" : ">"} ${fmt(m.perItemMaxCents)} per item`,
        },
    {
      rule: "blocked_category",
      kind: "hard",
      passed: !m.blockedCategories.includes(product.category),
      detail: m.blockedCategories.includes(product.category)
        ? `${product.category} is blocked`
        : `${product.category} is not blocked`,
    },
    {
      rule: "max_orders",
      kind: "hard",
      passed: spend.orders + 1 <= m.maxOrders,
      detail:
        spend.orders + 1 <= m.maxOrders
          ? `order ${spend.orders + 1} of ${m.maxOrders}`
          : `${spend.orders} of ${m.maxOrders} orders already used`,
    },
    {
      rule: "max_quantity",
      kind: "hard",
      passed: request.quantity <= m.maxQuantity,
      detail: `${request.quantity} ${request.quantity <= m.maxQuantity ? "<=" : ">"} ${m.maxQuantity}`,
    },
    !m.noDuplicates
      ? { rule: "no_duplicate", kind: "hard", passed: true, detail: "duplicates allowed" }
      : {
          rule: "no_duplicate",
          kind: "hard",
          passed: !spend.productIds.includes(request.productId),
          detail: spend.productIds.includes(request.productId)
            ? "already bought this item in this period"
            : "not bought before in this period",
        },
    {
      rule: "budget",
      kind: "soft",
      passed: after <= m.budgetCents,
      detail:
        after <= m.budgetCents
          ? `${fmt(after)} within ${fmt(m.budgetCents)} budget`
          : `${fmt(after - m.budgetCents)} over ${fmt(m.budgetCents)} budget`,
    },
    m.allowedCategories === null || m.allowedCategories.length === 0
      ? { rule: "allowed_category", kind: "soft", passed: true, detail: "any category allowed" }
      : {
          rule: "allowed_category",
          kind: "soft",
          passed: m.allowedCategories.includes(product.category),
          detail: m.allowedCategories.includes(product.category)
            ? `${product.category} is allowed`
            : `${product.category} is not in ${m.allowedCategories.join(", ")}`,
        },
  ];

  const hardFail = results.some((r) => r.kind === "hard" && !r.passed);
  const softFail = results.some((r) => r.kind === "soft" && !r.passed);
  return { decision: hardFail ? "BLOCK" : softFail ? "HOLD" : "APPROVE", results };
}

export const failedRules = (results: RuleResult[], kind?: "hard" | "soft") =>
  results.filter((r) => !r.passed && (kind === undefined || r.kind === kind));
