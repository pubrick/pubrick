ALTER TABLE "topics" ADD COLUMN "inspiration_kind" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "inspiration_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "inspiration_label" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "inspiration_date" date;--> statement-breakpoint
-- Existing topics receive the safe `none` default. Defer the table scan on populated installs.
ALTER TABLE "topics" ADD CONSTRAINT "topics_inspiration_kind_check" CHECK ("topics"."inspiration_kind" in ('none', 'news', 'editorial_placeholder', 'memorable_date')) NOT VALID;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_inspiration_snapshot_check" CHECK (("topics"."inspiration_kind" = 'none' and "topics"."inspiration_ref_id" is null and "topics"."inspiration_label" is null and "topics"."inspiration_date" is null)
        or ("topics"."inspiration_kind" = 'news' and "topics"."inspiration_ref_id" is not null and "topics"."inspiration_label" is not null and "topics"."inspiration_date" is null)
        or ("topics"."inspiration_kind" in ('editorial_placeholder', 'memorable_date') and "topics"."inspiration_ref_id" is not null and "topics"."inspiration_label" is not null and "topics"."inspiration_date" is not null)) NOT VALID;
