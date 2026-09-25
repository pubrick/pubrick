CREATE TABLE "topic_suggestion_scan_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"decision" text NOT NULL,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_suggestion_scan_decisions_decision_check" CHECK ("topic_suggestion_scan_decisions"."decision" in ('ideas_pending', 'no_ai_key', 'queued')),
	CONSTRAINT "topic_suggestion_scan_decisions_request_check" CHECK (("topic_suggestion_scan_decisions"."decision" = 'queued' and "topic_suggestion_scan_decisions"."request_id" is not null) or ("topic_suggestion_scan_decisions"."decision" <> 'queued' and "topic_suggestion_scan_decisions"."request_id" is null))
);
--> statement-breakpoint
ALTER TABLE "topic_suggestion_scan_decisions" ADD CONSTRAINT "topic_suggestion_scan_decisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_suggestion_scan_decisions" ADD CONSTRAINT "topic_suggestion_scan_decisions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_suggestion_scan_decisions" ADD CONSTRAINT "topic_suggestion_scan_decisions_request_id_topic_suggestion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."topic_suggestion_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_suggestion_scan_decisions_org_brand_day_idx" ON "topic_suggestion_scan_decisions" USING btree ("org_id","brand_id","local_date");--> statement-breakpoint
CREATE INDEX "topic_suggestion_scan_decisions_org_brand_created_idx" ON "topic_suggestion_scan_decisions" USING btree ("org_id","brand_id","created_at");