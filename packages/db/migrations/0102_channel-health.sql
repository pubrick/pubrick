ALTER TABLE "channels" ADD COLUMN "health_ok" boolean;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "health_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "channels_health_due_idx" ON "channels" USING btree ("health_checked_at","id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_health_result_pair_check" CHECK ("channels"."health_ok" is null or "channels"."health_checked_at" is not null);