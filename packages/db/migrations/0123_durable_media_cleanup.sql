CREATE TABLE "media_cleanup_work" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "media_cleanup_work_kind_check" CHECK ("media_cleanup_work"."kind" in ('image', 'video')),
	CONSTRAINT "media_cleanup_work_state_check" CHECK ("media_cleanup_work"."state" in ('pending', 'completed', 'operator_action')),
	CONSTRAINT "media_cleanup_work_attempts_check" CHECK ("media_cleanup_work"."attempts" BETWEEN 0 AND 8),
	CONSTRAINT "media_cleanup_work_lease_check" CHECK (("media_cleanup_work"."lease_until" IS NULL) = ("media_cleanup_work"."lease_token" IS NULL)),
	CONSTRAINT "media_cleanup_work_completed_check" CHECK (("media_cleanup_work"."state" = 'completed') = ("media_cleanup_work"."completed_at" IS NOT NULL)),
	CONSTRAINT "media_cleanup_work_last_error_check" CHECK ("media_cleanup_work"."last_error" in ('asset_exists', 'lease_exhausted', 'permission', 'storage_unavailable', 'invalid_path'))
);
--> statement-breakpoint
ALTER TABLE "billing_checkout_attempts" DROP CONSTRAINT "billing_checkout_status_check";--> statement-breakpoint
ALTER TABLE "billing_receipts" DROP CONSTRAINT "billing_receipt_kind_check";--> statement-breakpoint
ALTER TABLE "billing_receipts" DROP CONSTRAINT "billing_receipt_status_check";--> statement-breakpoint
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT "billing_subscription_status_check";--> statement-breakpoint
ALTER TABLE "hosted_ai_call_leases" DROP CONSTRAINT "hosted_ai_call_kind_check";--> statement-breakpoint
CREATE INDEX "media_cleanup_pending_idx" ON "media_cleanup_work" USING btree ("next_attempt_at","asset_id") WHERE "media_cleanup_work"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "media_cleanup_completed_idx" ON "media_cleanup_work" USING btree ("completed_at","asset_id") WHERE "media_cleanup_work"."state" = 'completed';--> statement-breakpoint
ALTER TABLE "billing_checkout_attempts" ADD CONSTRAINT "billing_checkout_attempts_status_check" CHECK ("billing_checkout_attempts"."status" IN ('pending','ready','closed','operator_action')) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing_receipts" ADD CONSTRAINT "billing_receipts_kind_check" CHECK ("billing_receipts"."kind" IN ('subscription.changed','checkout.completed','invoice.changed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing_receipts" ADD CONSTRAINT "billing_receipts_status_check" CHECK ("billing_receipts"."status" IN ('pending','processing','complete','ignored','retry','operator_action')) NOT VALID;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_status_check" CHECK ("billing_subscriptions"."status" IN ('active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused')) NOT VALID;--> statement-breakpoint
ALTER TABLE "hosted_ai_call_leases" ADD CONSTRAINT "hosted_ai_call_leases_kind_check" CHECK ("hosted_ai_call_leases"."kind" in ('text', 'image', 'embedding', 'probe')) NOT VALID;