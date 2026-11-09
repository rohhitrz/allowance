export type Money = { amountCents: number; currency: "USD" };

export type Period = "once" | "weekly" | "monthly";

/** The rules as stored in mandate_versions.rules and shown in receipts (API doc §4). */
export type MandateRules = {
  budget: Money;
  hardLimit: Money;
  perItemMax?: Money;
  allowedCategories?: string[];
  blockedCategories: string[];
  maxOrders: number;
  maxQuantity: number;
  noDuplicates: boolean;
  period: Period;
  expiresAt?: string;
  timezone: string;
};

export type MandateStatus = "DRAFT" | "ACTIVE" | "FROZEN" | "EXPIRED" | "CANCELLED";

export type RuleName =
  | "mandate_active"
  | "not_expired"
  | "hard_limit"
  | "per_item_max"
  | "blocked_category"
  | "max_orders"
  | "max_quantity"
  | "no_duplicate"
  | "budget"
  | "allowed_category";

export type RuleResult = { rule: RuleName; kind: "hard" | "soft"; passed: boolean; detail: string };

export type Decision = "APPROVE" | "HOLD" | "BLOCK";

/** What the engine needs about a mandate. Plain data, no DB types. */
export type PolicyMandate = {
  status: MandateStatus;
  budgetCents: number;
  hardLimitCents: number;
  perItemMaxCents: number | null;
  allowedCategories: string[] | null;
  blockedCategories: string[];
  maxOrders: number;
  maxQuantity: number;
  noDuplicates: boolean;
  expiresAt: Date | null;
};

/** Live spend in the current period (RESERVED, AUTHORIZED, HELD, CAPTURED). */
export type Spend = { amountCents: number; orders: number; productIds: string[] };

export type PolicyInput = {
  mandate: PolicyMandate;
  spend: Spend;
  request: { productId: string; quantity: number };
  product: { priceCents: number; category: string }; // loaded from DB, never from the agent
  now: Date;
};

export type PolicyOutput = { decision: Decision; results: RuleResult[] };

export const LOCKED_BLOCKED_CATEGORIES = ["gift_cards", "crypto", "cash_equivalents"] as const;

export const LIVE_PURCHASE_STATUSES = ["RESERVED", "AUTHORIZED", "HELD", "CAPTURED"] as const;
