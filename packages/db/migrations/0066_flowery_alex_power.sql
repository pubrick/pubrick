CREATE TABLE "analysis_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"sample_checked_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"unrecorded_calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "analysis_admissions_target_kind_check" CHECK ("analysis_admissions"."target_kind" in ('source_comment', 'publication_comment')),
	CONSTRAINT "analysis_admissions_unrecorded_calls_check" CHECK ("analysis_admissions"."unrecorded_calls" >= 0)
);
--> statement-breakpoint
ALTER TABLE "analysis_admissions" ADD CONSTRAINT "analysis_admissions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_admissions_org_requested_idx" ON "analysis_admissions" USING btree ("org_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_admissions_active_target_idx" ON "analysis_admissions" USING btree ("target_kind","target_id") WHERE "analysis_admissions"."completed_at" is null;