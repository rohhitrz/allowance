ALTER TYPE "public"."recovery_state" ADD VALUE 'needs_review';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "paypal_vault_id" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "refund_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "capture_dispatched_at" timestamp with time zone;--> statement-breakpoint
-- Rows from the previous release kept the vault row id in recovery_note; move it to its own column.
UPDATE "purchases" SET "paypal_vault_id" = "recovery_note", "recovery_note" = NULL
  WHERE "recovery" = 'authorizing_vault' AND "recovery_note" LIKE 'vlt\_%';
