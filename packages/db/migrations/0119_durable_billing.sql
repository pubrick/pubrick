CREATE TABLE "billing_accounts" (
	"org_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"customer_id" text,
	"customer_key" text NOT NULL,
	"customer_issued_at" timestamp with time zone NOT NULL,
	"customer_recovery_deadline" timestamp with time zone NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_provider_check" CHECK ("billing_accounts"."provider" IN ('stripe','fixture')),
	CONSTRAINT "billing_accounts_environment_check" CHECK ("billing_accounts"."environment" = 'sandbox'),
	CONSTRAINT "billing_account_revision_nonnegative" CHECK ("billing_accounts"."revision" >= 0),
	CONSTRAINT "billing_customer_recovery_window" CHECK ("billing_accounts"."customer_recovery_deadline" > "billing_accounts"."customer_issued_at")
);
--> statement-breakpoint
CREATE TABLE "billing_checkout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"price_id" text NOT NULL,
	"customer_id" text,
	"checkout_id" text,
	"checkout_url" text,
	"customer_key" text NOT NULL,
	"checkout_key" text NOT NULL,
	"success_url" text NOT NULL,
	"cancel_url" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"recovery_deadline" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" text,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_checkout_attempts_provider_check" CHECK ("billing_checkout_attempts"."provider" IN ('stripe','fixture')),
	CONSTRAINT "billing_checkout_attempts_environment_check" CHECK ("billing_checkout_attempts"."environment" = 'sandbox'),
	CONSTRAINT "billing_checkout_status_check" CHECK ("billing_checkout_attempts"."status" IN ('pending','ready','closed','operator_action')),
	CONSTRAINT "billing_checkout_revision_nonnegative" CHECK ("billing_checkout_attempts"."revision" >= 0),
	CONSTRAINT "billing_checkout_recovery_window" CHECK ("billing_checkout_attempts"."recovery_deadline" > "billing_checkout_attempts"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "billing_cleanup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_cleanup_provider_check" CHECK ("billing_cleanup"."provider" IN ('stripe','fixture')),
	CONSTRAINT "billing_cleanup_environment_check" CHECK ("billing_cleanup"."environment" = 'sandbox'),
	CONSTRAINT "billing_cleanup_attempts_check" CHECK ("billing_cleanup"."attempts" BETWEEN 0 AND 12),
	CONSTRAINT "billing_cleanup_kind_check" CHECK ("billing_cleanup"."kind" IN ('attempt','subscription')),
	CONSTRAINT "billing_cleanup_status_check" CHECK ("billing_cleanup"."status" IN ('pending','processing','complete','retry','operator_action'))
);
--> statement-breakpoint
CREATE TABLE "billing_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"version" text NOT NULL,
	"price_id" text NOT NULL,
	"price" jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_plan_versions_provider_check" CHECK ("billing_plan_versions"."provider" IN ('stripe','fixture')),
	CONSTRAINT "billing_plan_versions_environment_check" CHECK ("billing_plan_versions"."environment" = 'sandbox'),
	CONSTRAINT "billing_plan_version_positive" CHECK (length(btrim("billing_plan_versions"."version")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "billing_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_receipts_provider_check" CHECK ("billing_receipts"."provider" IN ('stripe','fixture')),
	CONSTRAINT "billing_receipts_environment_check" CHECK ("billing_receipts"."environment" = 'sandbox'),
	CONSTRAINT "billing_receipt_attempts_check" CHECK ("billing_receipts"."attempts" BETWEEN 0 AND 12),
	CONSTRAINT "billing_receipt_kind_check" CHECK ("billing_receipts"."kind" IN ('subscription.changed','checkout.completed','invoice.changed')),
	CONSTRAINT "billing_receipt_status_check" CHECK ("billing_receipts"."status" IN ('pending','processing','complete','ignored','retry','operator_action'))
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"account_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"price_id" text NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"next_reconcile_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"last_reconcile_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_provider_check" CHECK ("billing_subscriptions"."provider" IN ('stripe','fixture')),
	CONSTRAINT "billing_subscriptions_environment_check" CHECK ("billing_subscriptions"."environment" = 'sandbox'),
	CONSTRAINT "billing_subscription_reconcile_attempts_check" CHECK ("billing_subscriptions"."reconcile_attempts" BETWEEN 0 AND 12),
	CONSTRAINT "billing_subscription_revision_nonnegative" CHECK ("billing_subscriptions"."revision" >= 0),
	CONSTRAINT "billing_subscription_status_check" CHECK ("billing_subscriptions"."status" IN ('active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'))
);
--> statement-breakpoint
CREATE TABLE "organization_billing_state" (
	"org_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"subscription_id" text,
	"plan_version_id" uuid,
	"access_until" timestamp with time zone,
	"access" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_billing_revision_nonnegative" CHECK ("organization_billing_state"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_checkout_attempts" ADD CONSTRAINT "billing_checkout_attempts_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."billing_plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."billing_plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_billing_state" ADD CONSTRAINT "organization_billing_state_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_billing_state" ADD CONSTRAINT "organization_billing_state_plan_version_id_billing_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."billing_plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_identity_idx" ON "billing_accounts" USING btree ("provider","environment","account_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_unresolved_org_idx" ON "billing_checkout_attempts" USING btree ("org_id") WHERE "billing_checkout_attempts"."status" IN ('pending','ready','operator_action');--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkout_identity_idx" ON "billing_checkout_attempts" USING btree ("provider","environment","account_id","checkout_id");--> statement-breakpoint
CREATE INDEX "billing_checkout_due_idx" ON "billing_checkout_attempts" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_cleanup_resource_identity_idx" ON "billing_cleanup" USING btree ("provider","environment","account_id","kind","resource_id");--> statement-breakpoint
CREATE INDEX "billing_cleanup_due_idx" ON "billing_cleanup" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_version_identity_idx" ON "billing_plan_versions" USING btree ("provider","environment","account_id","plan_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_price_identity_idx" ON "billing_plan_versions" USING btree ("provider","environment","account_id","price_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_receipt_event_identity_idx" ON "billing_receipts" USING btree ("provider","environment","account_id","event_id");--> statement-breakpoint
CREATE INDEX "billing_receipt_due_idx" ON "billing_receipts" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_identity_idx" ON "billing_subscriptions" USING btree ("provider","environment","account_id","subscription_id");--> statement-breakpoint
CREATE INDEX "billing_subscription_org_idx" ON "billing_subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "billing_subscription_reconcile_due_idx" ON "billing_subscriptions" USING btree ("next_reconcile_at","id");