CREATE TABLE "autopilot_scan_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"scan_job_id" uuid NOT NULL,
	"status" text NOT NULL,
	"decision" text NOT NULL,
	"run_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autopilot_scan_events_status_check" CHECK ("autopilot_scan_events"."status" in ('skipped', 'dispatched', 'failed')),
	CONSTRAINT "autopilot_scan_events_decision_check" CHECK ("autopilot_scan_events"."decision" in ('disabled', 'before_start', 'quiet_hours', 'quota_full', 'budget_full', 'unpriced_spend', 'run_in_progress', 'org_busy', 'channels_missing', 'no_approved_topic', 'invalid_brief', 'dispatched', 'worker_failed')),
	CONSTRAINT "autopilot_scan_events_terminal_check" CHECK (("autopilot_scan_events"."status" = 'dispatched' AND "autopilot_scan_events"."decision" = 'dispatched') OR ("autopilot_scan_events"."status" = 'failed' AND "autopilot_scan_events"."decision" = 'worker_failed' AND "autopilot_scan_events"."run_id" IS NULL) OR ("autopilot_scan_events"."status" = 'skipped' AND "autopilot_scan_events"."decision" NOT IN ('dispatched', 'worker_failed') AND "autopilot_scan_events"."run_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "autopilot_scan_events" ADD CONSTRAINT "autopilot_scan_events_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_scan_events" ADD CONSTRAINT "autopilot_scan_events_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_scan_events" ADD CONSTRAINT "autopilot_scan_events_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_scan_events_job_brand_idx" ON "autopilot_scan_events" USING btree ("scan_job_id","brand_id");--> statement-breakpoint
CREATE INDEX "autopilot_scan_events_brand_finished_idx" ON "autopilot_scan_events" USING btree ("org_id","brand_id","finished_at","id");--> statement-breakpoint
CREATE INDEX "autopilot_scan_events_retention_idx" ON "autopilot_scan_events" USING btree ("finished_at","id");