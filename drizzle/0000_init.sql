CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."mandate_period" AS ENUM('once', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."mandate_status" AS ENUM('DRAFT', 'ACTIVE', 'FROZEN', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('APPROVE', 'HOLD', 'BLOCK');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('PROPOSED', 'BLOCKED', 'RESERVED', 'AUTHORIZED', 'HELD', 'CAPTURED', 'VOIDED', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('RUNNING', 'WAITING_APPROVAL', 'DONE', 'STOPPED', 'FAILED');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"status" "run_status" DEFAULT 'RUNNING' NOT NULL,
	"brief" text NOT NULL,
	"model" text NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_clients_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"mandate_version" integer NOT NULL,
	"soft_rules_failed" jsonb NOT NULL,
	"prompt" text NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_purchase_id_unique" UNIQUE("purchase_id"),
	CONSTRAINT "approvals_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"mandate_id" text,
	"purchase_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"actor" text NOT NULL,
	"response" jsonb NOT NULL,
	"status_code" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_actor_key_pk" PRIMARY KEY("scope","actor","key")
);
--> statement-breakpoint
CREATE TABLE "mandate_versions" (
	"mandate_id" text NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandate_versions_mandate_id_version_pk" PRIMARY KEY("mandate_id","version")
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_by" text NOT NULL,
	"api_client_id" text,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"source_text" text NOT NULL,
	"status" "mandate_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"budget_cents" integer NOT NULL,
	"hard_limit_cents" integer NOT NULL,
	"per_item_max_cents" integer,
	"allowed_categories" text[],
	"blocked_categories" text[] NOT NULL,
	"max_orders" integer NOT NULL,
	"max_quantity" integer NOT NULL,
	"no_duplicates" boolean DEFAULT true NOT NULL,
	"period" "mandate_period" DEFAULT 'once' NOT NULL,
	"expires_at" timestamp with time zone,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandates_budget_positive" CHECK ("mandates"."budget_cents" > 0),
	CONSTRAINT "mandates_max_orders_positive" CHECK ("mandates"."max_orders" > 0),
	CONSTRAINT "mandates_max_quantity_positive" CHECK ("mandates"."max_quantity" > 0),
	CONSTRAINT "mandates_hard_limit_gte_budget" CHECK ("mandates"."hard_limit_cents" >= "mandates"."budget_cents"),
	CONSTRAINT "mandates_once_needs_expiry" CHECK ("mandates"."period" <> 'once' OR "mandates"."expires_at" IS NOT NULL),
	CONSTRAINT "mandates_locked_blocked_categories" CHECK ("mandates"."blocked_categories" @> ARRAY['gift_cards','crypto','cash_equivalents']::text[])
);
--> statement-breakpoint
CREATE TABLE "paypal_vaults" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"setup_token_id" text,
	"payment_token_id" text,
	"payer_id" text,
	"payer_email" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"price_cents" integer NOT NULL,
	"rating" numeric(2, 1),
	"blurb" text NOT NULL,
	"description" text NOT NULL,
	"image_url" text,
	"is_poisoned" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "products_price_positive" CHECK ("products"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"mandate_version" integer NOT NULL,
	"run_id" text,
	"requested_by" text NOT NULL,
	"idempotency_key" text,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"product_category" text NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"quantity" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"decision" "policy_decision" NOT NULL,
	"rule_results" jsonb NOT NULL,
	"status" "purchase_status" DEFAULT 'PROPOSED' NOT NULL,
	"paypal_called" boolean DEFAULT false NOT NULL,
	"paypal_order_id" text,
	"paypal_authorization_id" text,
	"paypal_capture_id" text,
	"paypal_refund_id" text,
	"paypal_approve_url" text,
	"paypal_debug_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "purchases_quantity_positive" CHECK ("purchases"."quantity" > 0),
	CONSTRAINT "purchases_total_matches" CHECK ("purchases"."total_cents" = "purchases"."unit_price_cents" * "purchases"."quantity"),
	CONSTRAINT "purchases_blocked_never_paypal" CHECK ("purchases"."status" <> 'BLOCKED' OR "purchases"."paypal_called" = false)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_versions" ADD CONSTRAINT "mandate_versions_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_api_client_id_api_clients_id_fk" FOREIGN KEY ("api_client_id") REFERENCES "public"."api_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_vaults" ADD CONSTRAINT "paypal_vaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_mandate_version_fk" FOREIGN KEY ("mandate_id","mandate_version") REFERENCES "public"."mandate_versions"("mandate_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_mandate" ON "agent_runs" USING btree ("mandate_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "approvals_pending" ON "approvals" USING btree ("expires_at") WHERE "approvals"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "events_mandate" ON "events" USING btree ("mandate_id","id");--> statement-breakpoint
CREATE INDEX "events_purchase" ON "events" USING btree ("purchase_id","id");--> statement-breakpoint
CREATE INDEX "mandates_user_status" ON "mandates" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "paypal_vaults_one_active" ON "paypal_vaults" USING btree ("user_id") WHERE "paypal_vaults"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "products_category" ON "products" USING btree ("category") WHERE "products"."active";--> statement-breakpoint
CREATE INDEX "purchases_spend" ON "purchases" USING btree ("mandate_id","period_start","status");--> statement-breakpoint
CREATE INDEX "purchases_ledger" ON "purchases" USING btree ("created_at" DESC NULLS LAST);