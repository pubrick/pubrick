ALTER TABLE "adaptations" ADD COLUMN "hashtags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "adaptations" ADD COLUMN "cta" text;--> statement-breakpoint
ALTER TABLE "content_versions" ADD COLUMN "hashtags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_versions" ADD COLUMN "cta" text;