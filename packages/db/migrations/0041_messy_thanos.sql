ALTER TABLE "knowledge_entries" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN "embedding_dimensions" integer;--> statement-breakpoint
-- All existing vectors use the sole model and dimensions supported before this migration.
UPDATE "knowledge_entries" SET "embedding_model" = 'gemini-embedding-001', "embedding_dimensions" = 768 WHERE "embedding" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_embedding_metadata_check" CHECK (("knowledge_entries"."embedding" is null and "knowledge_entries"."embedding_model" is null and "knowledge_entries"."embedding_dimensions" is null) or ("knowledge_entries"."embedding" is not null and "knowledge_entries"."embedding_model" is not null and "knowledge_entries"."embedding_dimensions" = 768));
