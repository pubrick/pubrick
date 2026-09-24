CREATE TABLE "telegram_source_accounts" (
	"org_id" text PRIMARY KEY NOT NULL,
	"session_encrypted" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_sources" ADD COLUMN "kind" text DEFAULT 'rss' NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_source_accounts" ADD CONSTRAINT "telegram_source_accounts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_kind_check" CHECK ("news_sources"."kind" in ('rss', 'telegram'));