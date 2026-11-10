/**
 * Drizzle schema: mirrors docs/04-db-design.md.
 *
 * The three CHECKs on mandates and purchases are deliberate guarantees that
 * Postgres enforces even if application code is wrong:
 *   - locked blocked categories can never be removed
 *   - hard limit >= budget
 *   - a BLOCKED purchase never touched PayPal
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { MandateRules, RuleResult } from "../policy/types";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const mandateStatus = pgEnum("mandate_status", ["DRAFT", "ACTIVE", "FROZEN", "EXPIRED", "CANCELLED"]);
export const mandatePeriod = pgEnum("mandate_period", ["once", "weekly", "monthly"]);
export const purchaseStatus = pgEnum("purchase_status", [
  "PROPOSED",
  "BLOCKED",
  "RESERVED",
  "AUTHORIZED",
  "HELD",
  "CAPTURED",
  "VOIDED",
  "FAILED",
  "REFUNDED",
]);
export const policyDecision = pgEnum("policy_decision", ["APPROVE", "HOLD", "BLOCK"]);
export const approvalStatus = pgEnum("approval_status", ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]);
/**
 * PayPal work the sweep still owes a purchase:
 *   authorizing_vault / authorizing_popup  a call was in flight (crash cleanup knows which)
 *   capture_retry    an approved capture PayPal couldn't take yet
 *   capture_pending  PayPal reported the capture PENDING; it can still be declined
 *   void_retry       an authorization that must be released, whose void failed
 *   refund_pending   a refund PayPal hasn't finished, or whose answer was lost (no refund id yet)
 *   needs_review     we can't tell what PayPal did and won't guess; a human checks PayPal (custom_id = purchase id)
 */
export const recoveryState = pgEnum("recovery_state", [
  "authorizing_vault",
  "authorizing_popup",
  "capture_retry",
  "capture_pending",
  "void_retry",
  "refund_pending",
  "needs_review",
]);
export const runStatus = pgEnum("run_status", ["RUNNING", "WAITING_APPROVAL", "DONE", "STOPPED", "FAILED"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const paypalVaults = pgTable(
  "paypal_vaults",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    setupTokenId: text("setup_token_id"),
    paymentTokenId: text("payment_token_id"),
    payerId: text("payer_id"),
    payerEmail: text("payer_email"),
    status: text("status").notNull(), // PENDING | ACTIVE | REVOKED
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("paypal_vaults_one_active").on(t.userId).where(sql`${t.status} = 'ACTIVE'`)],
);

export const apiClients = pgTable("api_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
  revokedAt: ts("revoked_at"),
});

export const mandates = pgTable(
  "mandates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdBy: text("created_by").notNull(),
    apiClientId: text("api_client_id").references(() => apiClients.id),
    title: text("title").notNull(),
    brief: text("brief").notNull(),
    sourceText: text("source_text").notNull(),
    status: mandateStatus("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(0),
    budgetCents: integer("budget_cents").notNull(),
    hardLimitCents: integer("hard_limit_cents").notNull(),
    perItemMaxCents: integer("per_item_max_cents"),
    allowedCategories: text("allowed_categories").array(),
    blockedCategories: text("blocked_categories").array().notNull(),
    maxOrders: integer("max_orders").notNull(),
    maxQuantity: integer("max_quantity").notNull(),
    noDuplicates: boolean("no_duplicates").notNull().default(true),
    period: mandatePeriod("period").notNull().default("once"),
    expiresAt: ts("expires_at"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    confirmedAt: ts("confirmed_at"),
    frozenAt: ts("frozen_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("mandates_user_status").on(t.userId, t.status),
    check("mandates_budget_positive", sql`${t.budgetCents} > 0`),
    check("mandates_max_orders_positive", sql`${t.maxOrders} > 0`),
    check("mandates_max_quantity_positive", sql`${t.maxQuantity} > 0`),
    check("mandates_hard_limit_gte_budget", sql`${t.hardLimitCents} >= ${t.budgetCents}`),
    check("mandates_once_needs_expiry", sql`${t.period} <> 'once' OR ${t.expiresAt} IS NOT NULL`),
    check(
      "mandates_locked_blocked_categories",
      sql`${t.blockedCategories} @> ARRAY['gift_cards','crypto','cash_equivalents']::text[]`,
    ),
  ],
);

export const mandateVersions = pgTable(
  "mandate_versions",
  {
    mandateId: text("mandate_id")
      .notNull()
      .references(() => mandates.id),
    version: integer("version").notNull(),
    rules: jsonb("rules").$type<MandateRules>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.mandateId, t.version] })],
);

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    priceCents: integer("price_cents").notNull(),
    rating: numeric("rating", { precision: 2, scale: 1, mode: "number" }),
    blurb: text("blurb").notNull(),
    description: text("description").notNull(), // UNTRUSTED
    imageUrl: text("image_url"),
    isPoisoned: boolean("is_poisoned").notNull().default(false),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    index("products_category").on(t.category).where(sql`${t.active}`),
    check("products_price_positive", sql`${t.priceCents} > 0`),
  ],
);

/** purchaseId: the purchase a request_purchase step made, recorded as data so reports never parse it from text. */
export type RunStep = { tool: string; input: unknown; output: unknown; at: string; purchaseId?: string };

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    mandateId: text("mandate_id")
      .notNull()
      .references(() => mandates.id),
    status: runStatus("status").notNull().default("RUNNING"),
    brief: text("brief").notNull(),
    model: text("model").notNull(),
    steps: jsonb("steps").$type<RunStep[]>().notNull().default([]),
    error: text("error"),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    /** Refreshed while the run's process is alive. A live run with a stale heartbeat was orphaned by a restart. */
    heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
  },
  (t) => [
    index("agent_runs_mandate").on(t.mandateId, t.startedAt.desc()),
    // One live agent per mandate: two quick clicks can't start two runs.
    uniqueIndex("agent_runs_one_active").on(t.mandateId).where(sql`${t.status} IN ('RUNNING', 'WAITING_APPROVAL')`),
  ],
);

export const purchases = pgTable(
  "purchases",
  {
    id: text("id").primaryKey(),
    mandateId: text("mandate_id")
      .notNull()
      .references(() => mandates.id),
    mandateVersion: integer("mandate_version").notNull(),
    runId: text("run_id").references(() => agentRuns.id),
    requestedBy: text("requested_by").notNull(),
    idempotencyKey: text("idempotency_key").unique(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    productName: text("product_name").notNull(),
    productCategory: text("product_category").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    totalCents: integer("total_cents").notNull(),
    reason: text("reason").notNull(),
    periodStart: ts("period_start").notNull(),
    decision: policyDecision("decision").notNull(),
    ruleResults: jsonb("rule_results").$type<RuleResult[]>().notNull(),
    status: purchaseStatus("status").notNull().default("PROPOSED"),
    paypalCalled: boolean("paypal_called").notNull().default(false),
    paypalOrderId: text("paypal_order_id"),
    paypalAuthorizationId: text("paypal_authorization_id"),
    paypalCaptureId: text("paypal_capture_id"),
    paypalRefundId: text("paypal_refund_id"),
    paypalApproveUrl: text("paypal_approve_url"),
    paypalDebugId: text("paypal_debug_id"),
    /** Why the purchase ended FAILED or VOIDED. Only ever a human-readable outcome, never a state flag. */
    failureReason: text("failure_reason"),
    /**
     * Work still owed to PayPal on this purchase, read by the sweep. Kept apart from
     * failureReason so a note can never move a purchase into a different retry loop.
     */
    recovery: recoveryState("recovery"),
    /** Capture tries so far (capture_retry only). */
    recoveryAttempts: integer("recovery_attempts").notNull().default(0),
    /** The last PayPal error behind the recovery, for the receipt. */
    recoveryNote: text("recovery_note"),
    /** The saved PayPal account (paypal_vaults.id) this purchase was authorized with. Crash recovery replays with it, never another. */
    paypalVaultId: text("paypal_vault_id"),
    /** Refund attempts that PayPal definitely refused; the next attempt gets a new request id. */
    refundAttempts: integer("refund_attempts").notNull().default(0),
    /** Set, with the mandate row locked, once the final re-check passed and the capture may be sent. The kill switch can't recall these. */
    captureDispatchedAt: ts("capture_dispatched_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.mandateId, t.mandateVersion],
      foreignColumns: [mandateVersions.mandateId, mandateVersions.version],
      name: "purchases_mandate_version_fk",
    }),
    check("purchases_quantity_positive", sql`${t.quantity} > 0`),
    check("purchases_total_matches", sql`${t.totalCents} = ${t.unitPriceCents} * ${t.quantity}`),
    check("purchases_blocked_never_paypal", sql`${t.status} <> 'BLOCKED' OR ${t.paypalCalled} = false`),
    index("purchases_spend").on(t.mandateId, t.periodStart, t.status),
    index("purchases_ledger").on(t.createdAt.desc()),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    purchaseId: text("purchase_id")
      .notNull()
      .unique()
      .references(() => purchases.id),
    tokenHash: text("token_hash").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    mandateVersion: integer("mandate_version").notNull(),
    softRulesFailed: jsonb("soft_rules_failed").$type<RuleResult[]>().notNull(),
    prompt: text("prompt").notNull(),
    status: approvalStatus("status").notNull().default("PENDING"),
    expiresAt: ts("expires_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("approvals_pending").on(t.expiresAt).where(sql`${t.status} = 'PENDING'`)],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: ts("at").notNull().defaultNow(),
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    mandateId: text("mandate_id").references(() => mandates.id),
    purchaseId: text("purchase_id").references(() => purchases.id),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("events_mandate").on(t.mandateId, t.id), index("events_purchase").on(t.purchaseId, t.id)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    actor: text("actor").notNull(),
    response: jsonb("response").notNull(),
    statusCode: integer("status_code").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.actor, t.key] })],
);

export type MandateRow = typeof mandates.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type PurchaseRow = typeof purchases.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type EventRow = typeof events.$inferSelect;
