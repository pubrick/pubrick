CREATE TABLE "editorial_placeholders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"date" date NOT NULL,
	"platform" text,
	"content_type" text,
	"time_of_day" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editorial_placeholders_platform_check" CHECK ("editorial_placeholders"."platform" in ('telegram', 'vk', 'dzen', 'vc_ru', 'instagram', 'youtube', 'rutube', 'tenchat', 't_j', 'max', 'bluesky', 'mastodon', 'x')),
	CONSTRAINT "editorial_placeholders_content_type_check" CHECK ("editorial_placeholders"."content_type" in ('social_post', 'news_digest', 'repost', 'product_update', 'expert_article', 'comparison', 'case_study', 'educational')),
	CONSTRAINT "editorial_placeholders_time_of_day_check" CHECK ("editorial_placeholders"."time_of_day" is null or "editorial_placeholders"."time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "editorial_placeholders_notes_length_check" CHECK ("editorial_placeholders"."notes" is null or length("editorial_placeholders"."notes") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "editorial_placeholders" ADD CONSTRAINT "editorial_placeholders_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_placeholders" ADD CONSTRAINT "editorial_placeholders_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "editorial_placeholders_org_brand_date_idx" ON "editorial_placeholders" USING btree ("org_id","brand_id","date");