CREATE TABLE "manual_topic_plan_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"created_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "manual_topic_plan_attempts_status_check" CHECK ("manual_topic_plan_attempts"."status" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "manual_topic_plan_attempts_error_check" CHECK ("manual_topic_plan_attempts"."error_code" IS NULL OR "manual_topic_plan_attempts"."error_code" = 'worker_failed'),
	CONSTRAINT "manual_topic_plan_attempts_count_check" CHECK ("manual_topic_plan_attempts"."created_count" >= 0),
	CONSTRAINT "manual_topic_plan_attempts_terminal_check" CHECK ((("manual_topic_plan_attempts"."status" IN ('queued', 'running')) AND "manual_topic_plan_attempts"."completed_at" IS NULL AND "manual_topic_plan_attempts"."error_code" IS NULL) OR ("manual_topic_plan_attempts"."status" = 'completed' AND "manual_topic_plan_attempts"."completed_at" IS NOT NULL AND "manual_topic_plan_attempts"."error_code" IS NULL) OR ("manual_topic_plan_attempts"."status" = 'failed' AND "manual_topic_plan_attempts"."completed_at" IS NOT NULL AND "manual_topic_plan_attempts"."error_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD COLUMN "manual_plan_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "manual_topic_plan_attempts" ADD CONSTRAINT "manual_topic_plan_attempts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_topic_plan_attempts" ADD CONSTRAINT "manual_topic_plan_attempts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manual_topic_plan_attempts_brand_created_idx" ON "manual_topic_plan_attempts" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_manual_plan_attempt_id_manual_topic_plan_attempts_id_fk" FOREIGN KEY ("manual_plan_attempt_id") REFERENCES "public"."manual_topic_plan_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_slots_manual_plan_attempt_idx" ON "calendar_slots" USING btree ("manual_plan_attempt_id");