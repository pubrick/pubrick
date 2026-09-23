ALTER TABLE "calendar_slots" DROP CONSTRAINT "calendar_slots_error_code_check";--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD COLUMN "topic_title" text;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD COLUMN "topic_description" text;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD COLUMN "topic_source_url" text;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD COLUMN "topic_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD COLUMN "topic_revision" integer;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_slots_topic_idx" ON "calendar_slots" USING btree ("topic_id");--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_topic_snapshot_check" CHECK (("calendar_slots"."topic_id" is null and "calendar_slots"."topic_title" is null and "calendar_slots"."topic_description" is null and "calendar_slots"."topic_source_url" is null and "calendar_slots"."topic_updated_at" is null and "calendar_slots"."topic_revision" is null) or ("calendar_slots"."topic_id" is not null and "calendar_slots"."topic_title" is not null and "calendar_slots"."topic_description" is not null and "calendar_slots"."topic_updated_at" is not null and "calendar_slots"."topic_revision" is not null));--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_error_code_check" CHECK ("calendar_slots"."error_code" in ('channels_missing', 'invalid_input', 'topic_changed'));