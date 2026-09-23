CREATE TABLE "topic_suggestion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"suggestion_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_suggestion_requests_status_check" CHECK ("topic_suggestion_requests"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "topic_suggestion_requests_error_code_check" CHECK ("topic_suggestion_requests"."error_code" in ('no_api_key', 'unreadable_key', 'model_failed'))
);
--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "suggestion_key" text;--> statement-breakpoint
ALTER TABLE "topic_suggestion_requests" ADD CONSTRAINT "topic_suggestion_requests_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_suggestion_requests" ADD CONSTRAINT "topic_suggestion_requests_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topic_suggestion_requests_org_brand_created_idx" ON "topic_suggestion_requests" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_org_brand_suggestion_key_idx" ON "topics" USING btree ("org_id","brand_id","suggestion_key");--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_origin_check" CHECK ("topics"."origin" in ('manual', 'ai'));