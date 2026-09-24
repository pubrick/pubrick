ALTER TABLE "news_items" ADD COLUMN "embedding" vector(768);--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "embedding_dimensions" integer;--> statement-breakpoint
-- Existing rows have NULL vector metadata; enforce future writes without an install-time table scan.
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_embedding_metadata_check" CHECK (("news_items"."embedding" is null and "news_items"."embedding_model" is null and "news_items"."embedding_dimensions" is null) or ("news_items"."embedding" is not null and "news_items"."embedding_model" is not null and "news_items"."embedding_dimensions" is not null and "news_items"."embedding_dimensions" = 768)) NOT VALID;
