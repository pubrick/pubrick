ALTER TABLE "publications" ADD COLUMN "partial_primary_kind" text;--> statement-breakpoint
ALTER TABLE "publications" DROP CONSTRAINT "publications_partial_followup_outcome_check";--> statement-breakpoint
ALTER TABLE "publications" DROP CONSTRAINT "publications_partial_telegram_check";--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_partial_primary_kind_check" CHECK ("publications"."partial_primary_kind" in ('photo', 'message')) NOT VALID;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_partial_followup_outcome_check" CHECK ("publications"."partial_followup_outcome" in ('pending', 'not_sent', 'rejected', 'unknown', 'confirmed')) NOT VALID;--> statement-breakpoint
-- A null suffix means no checkpoint. Do not require kind to be null here: an
-- old worker can clear a backfilled photo checkpoint without knowing this column.
ALTER TABLE "publications" ADD CONSTRAINT "publications_partial_telegram_check" CHECK (("publications"."partial_followup_text" is null and "publications"."partial_photo_id" is null and "publications"."partial_photo_url" is null and "publications"."partial_followup_outcome" is null)
        or ("publications"."status" in ('in_flight', 'unknown') and "publications"."partial_followup_text" is not null
          and length("publications"."partial_followup_text") between 0 and 12000
          and "publications"."partial_followup_outcome" is not null
          and (("publications"."partial_followup_outcome" = 'confirmed' and length("publications"."partial_followup_text") = 0)
            or ("publications"."partial_followup_outcome" in ('pending', 'not_sent', 'rejected', 'unknown')
              and length("publications"."partial_followup_text") >= 1)))) NOT VALID;
