ALTER TABLE "publications" ADD COLUMN "partial_photo_id" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "partial_photo_url" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "partial_followup_text" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "partial_followup_outcome" text;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_partial_followup_outcome_check" CHECK ("publications"."partial_followup_outcome" in ('pending', 'not_sent', 'rejected', 'unknown')) NOT VALID;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_partial_telegram_check" CHECK (("publications"."partial_followup_text" is null and "publications"."partial_photo_id" is null and "publications"."partial_photo_url" is null and "publications"."partial_followup_outcome" is null)
        or ("publications"."status" in ('in_flight', 'unknown') and "publications"."partial_followup_text" is not null
          and length("publications"."partial_followup_text") between 1 and 4096
          and "publications"."partial_followup_outcome" is not null
          and "publications"."partial_followup_outcome" in ('pending', 'not_sent', 'rejected', 'unknown'))) NOT VALID;
