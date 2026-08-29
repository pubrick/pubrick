ALTER TABLE "content_versions" ADD COLUMN "scope" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "content_item_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "adaptation_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_adaptation_id_adaptations_id_fk" FOREIGN KEY ("adaptation_id") REFERENCES "public"."adaptations"("id") ON DELETE set null ON UPDATE no action;