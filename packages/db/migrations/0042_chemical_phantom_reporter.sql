ALTER TABLE "news_sources" DROP CONSTRAINT "news_sources_kind_check";--> statement-breakpoint
ALTER TABLE "news_sources" ADD COLUMN "private_peer_encrypted" text;--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_private_peer_check" CHECK (("news_sources"."kind" = 'telegram_private') = ("news_sources"."private_peer_encrypted" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_kind_check" CHECK ("news_sources"."kind" in ('rss', 'telegram', 'telegram_private'));