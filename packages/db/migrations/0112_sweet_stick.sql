ALTER TABLE "notification_events" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "notification_events" ADD COLUMN "attempted_at" timestamp with time zone;--> statement-breakpoint
-- A populated outbox must not be scanned under the migration transaction's lock.
-- PostgreSQL enforces NOT VALID constraints on all new and updated rows.
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_reason_check" CHECK ("notification_events"."reason" in ('destination_disabled', 'event_disabled', 'subject_unavailable', 'origin_invalid', 'preflight_failed', 'provider_rejected', 'delivery_unconfirmed')) NOT VALID;
