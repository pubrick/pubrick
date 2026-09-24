CREATE TABLE "autopilot_configs" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"start_hour" integer DEFAULT 9 NOT NULL,
	"quiet_start_hour" integer DEFAULT 22 NOT NULL,
	"quiet_end_hour" integer DEFAULT 8 NOT NULL,
	"daily_run_limit" integer DEFAULT 1 NOT NULL,
	"daily_spend_limit_usd" numeric(8, 2) DEFAULT '1.00' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autopilot_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"local_date" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autopilot_configs" ADD CONSTRAINT "autopilot_configs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_configs" ADD CONSTRAINT "autopilot_configs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_dispatches" ADD CONSTRAINT "autopilot_dispatches_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_dispatches" ADD CONSTRAINT "autopilot_dispatches_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_dispatches" ADD CONSTRAINT "autopilot_dispatches_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_dispatches" ADD CONSTRAINT "autopilot_dispatches_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autopilot_configs_org_id_idx" ON "autopilot_configs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_dispatches_topic_idx" ON "autopilot_dispatches" USING btree ("topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_dispatches_run_idx" ON "autopilot_dispatches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "autopilot_dispatches_brand_day_idx" ON "autopilot_dispatches" USING btree ("org_id","brand_id","local_date");