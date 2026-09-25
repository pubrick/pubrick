CREATE TABLE "paid_reply_backfill_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "paid_reply_backfill_state_singleton_check" CHECK ("paid_reply_backfill_state"."id" = 1)
);--> statement-breakpoint
-- Persist the start fence in the schema migration transaction. Retries can
-- recognize samples collected after this point, even if backfill was partial.
INSERT INTO paid_reply_backfill_state (id) VALUES (1);
