CREATE TYPE "public"."recovery_state" AS ENUM('authorizing_vault', 'authorizing_popup', 'capture_retry', 'capture_pending', 'void_retry', 'refund_pending');--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "recovery" "recovery_state";--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "recovery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "recovery_note" text;--> statement-breakpoint
-- Existing duplicate live runs on one mandate (from before this index): keep the newest.
UPDATE "agent_runs" r SET "status" = 'STOPPED', "ended_at" = now()
WHERE r."status" IN ('RUNNING', 'WAITING_APPROVAL')
  AND EXISTS (SELECT 1 FROM "agent_runs" n WHERE n."mandate_id" = r."mandate_id" AND n."status" IN ('RUNNING', 'WAITING_APPROVAL') AND n."started_at" > r."started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_active" ON "agent_runs" USING btree ("mandate_id") WHERE "agent_runs"."status" IN ('RUNNING', 'WAITING_APPROVAL');--> statement-breakpoint
-- Move the old text markers in failure_reason into the new columns.
UPDATE "purchases" SET "recovery" = 'authorizing_vault', "failure_reason" = NULL WHERE "status" = 'RESERVED' AND "failure_reason" = 'authorizing: saved PayPal account';--> statement-breakpoint
UPDATE "purchases" SET "recovery" = 'authorizing_popup', "failure_reason" = NULL WHERE "status" = 'RESERVED' AND "failure_reason" = 'authorizing: PayPal popup';--> statement-breakpoint
UPDATE "purchases" SET "recovery" = 'capture_retry', "recovery_attempts" = COALESCE(substring("failure_reason" from '^capture retry (\d+)/')::int, 1), "recovery_note" = "failure_reason", "failure_reason" = NULL
  WHERE "status" IN ('AUTHORIZED', 'HELD') AND "failure_reason" LIKE 'capture retry%';--> statement-breakpoint
UPDATE "purchases" SET "recovery" = 'void_retry', "recovery_note" = "failure_reason", "failure_reason" = NULL WHERE "status" IN ('AUTHORIZED', 'HELD') AND "failure_reason" LIKE 'void failed:%';--> statement-breakpoint
UPDATE "purchases" SET "recovery" = 'capture_pending', "recovery_note" = "failure_reason", "failure_reason" = NULL WHERE "status" = 'CAPTURED' AND "failure_reason" LIKE 'capture PENDING%';