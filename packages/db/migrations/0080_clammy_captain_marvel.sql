CREATE TABLE "news_relevance_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"completed_at" timestamp with time zone,
	CONSTRAINT "news_relevance_batch_items_status_check" CHECK ("news_relevance_batch_items"."status" in ('queued', 'running', 'scored', 'failed', 'skipped')),
	CONSTRAINT "news_relevance_batch_items_error_code_check" CHECK ("news_relevance_batch_items"."error_code" in ('no_api_key', 'unreadable_key', 'invalid_key', 'model_not_found', 'provider_refused', 'model_failed'))
);
--> statement-breakpoint
CREATE TABLE "news_relevance_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"days" integer NOT NULL,
	"selected_count" integer NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"unrecorded_calls" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "news_relevance_batches_days_check" CHECK ("news_relevance_batches"."days" BETWEEN 1 AND 30),
	CONSTRAINT "news_relevance_batches_counts_check" CHECK ("news_relevance_batches"."selected_count" BETWEEN 1 AND 500 AND "news_relevance_batches"."processed_count" BETWEEN 0 AND "news_relevance_batches"."selected_count" AND "news_relevance_batches"."updated_count" >= 0 AND "news_relevance_batches"."failed_count" >= 0 AND "news_relevance_batches"."skipped_count" >= 0 AND "news_relevance_batches"."processed_count" = "news_relevance_batches"."updated_count" + "news_relevance_batches"."failed_count" + "news_relevance_batches"."skipped_count"),
	CONSTRAINT "news_relevance_batches_unrecorded_check" CHECK ("news_relevance_batches"."unrecorded_calls" >= 0),
	CONSTRAINT "news_relevance_batches_status_check" CHECK ("news_relevance_batches"."status" in ('queued', 'running', 'completed', 'partial', 'halted')),
	CONSTRAINT "news_relevance_batches_error_code_check" CHECK ("news_relevance_batches"."error_code" in ('no_api_key', 'unreadable_key', 'invalid_key', 'model_not_found', 'provider_refused', 'model_failed'))
);
--> statement-breakpoint
ALTER TABLE "news_relevance_batch_items" ADD CONSTRAINT "news_relevance_batch_items_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_relevance_batch_items" ADD CONSTRAINT "news_relevance_batch_items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_relevance_batches_org_brand_id_idx" ON "news_relevance_batches" USING btree ("org_id","brand_id","id");--> statement-breakpoint
ALTER TABLE "news_relevance_batch_items" ADD CONSTRAINT "news_relevance_batch_items_batch_scope_fk" FOREIGN KEY ("org_id","brand_id","batch_id") REFERENCES "public"."news_relevance_batches"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_relevance_batches" ADD CONSTRAINT "news_relevance_batches_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_relevance_batches" ADD CONSTRAINT "news_relevance_batches_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_relevance_batch_items_once_idx" ON "news_relevance_batch_items" USING btree ("batch_id","item_id");--> statement-breakpoint
CREATE INDEX "news_relevance_batch_items_scope_idx" ON "news_relevance_batch_items" USING btree ("org_id","brand_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "news_relevance_batches_one_active_idx" ON "news_relevance_batches" USING btree ("org_id","brand_id") WHERE "news_relevance_batches"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "news_relevance_batches_history_idx" ON "news_relevance_batches" USING btree ("org_id","brand_id","created_at" DESC NULLS LAST);
