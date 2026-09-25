CREATE TABLE "autopilot_manual_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"decision" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "autopilot_manual_attempts_status_check" CHECK ("autopilot_manual_attempts"."status" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "autopilot_manual_attempts_decision_check" CHECK ("autopilot_manual_attempts"."decision" IN ('disabled', 'before_start', 'quiet_hours', 'quota_full', 'budget_full', 'unpriced_spend', 'run_in_progress', 'org_busy', 'channels_missing', 'no_approved_topic', 'invalid_brief', 'dispatched', 'worker_failed')),
	CONSTRAINT "autopilot_manual_attempts_terminal_check" CHECK ((("autopilot_manual_attempts"."status" = 'queued' OR "autopilot_manual_attempts"."status" = 'running') AND "autopilot_manual_attempts"."completed_at" IS NULL AND "autopilot_manual_attempts"."decision" IS NULL) OR (("autopilot_manual_attempts"."status" = 'completed' OR "autopilot_manual_attempts"."status" = 'failed') AND "autopilot_manual_attempts"."completed_at" IS NOT NULL AND "autopilot_manual_attempts"."decision" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "autopilot_manual_attempts" ADD CONSTRAINT "autopilot_manual_attempts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_manual_attempts" ADD CONSTRAINT "autopilot_manual_attempts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_manual_attempts" ADD CONSTRAINT "autopilot_manual_attempts_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autopilot_manual_attempts_brand_created_idx" ON "autopilot_manual_attempts" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_manual_attempts_active_idx" ON "autopilot_manual_attempts" USING btree ("brand_id") WHERE "autopilot_manual_attempts"."status" IN ('queued', 'running');
