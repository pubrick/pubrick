ALTER TABLE "channels" ADD COLUMN "posting_timezone" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "posting_slots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "posting_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_posting_revision_check" CHECK ("channels"."posting_revision" >= 0);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_posting_slots_check" CHECK (jsonb_typeof("channels"."posting_slots") = 'array' and jsonb_array_length("channels"."posting_slots") <= 70 and (jsonb_array_length("channels"."posting_slots") = 0 or "channels"."posting_timezone" is not null));