CREATE TABLE "calendar_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"brief" text NOT NULL,
	"channel_ids" jsonb NOT NULL,
	"notes" text,
	"run_id" uuid,
	"error_code" text,
	"retry_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_slots_brief_nonempty" CHECK (length(trim("calendar_slots"."brief")) > 0),
	CONSTRAINT "calendar_slots_error_code_check" CHECK ("calendar_slots"."error_code" in ('channels_missing', 'invalid_input'))
);
--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_slots_org_brand_date_idx" ON "calendar_slots" USING btree ("org_id","brand_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "calendar_slots_due_idx" ON "calendar_slots" USING btree ("scheduled_at") WHERE "calendar_slots"."run_id" is null and "calendar_slots"."error_code" is null;