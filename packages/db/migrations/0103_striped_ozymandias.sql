ALTER TABLE "pipeline_runs" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_runs_topic_id_idx" ON "pipeline_runs" USING btree ("topic_id");
--> statement-breakpoint
-- Started slots are immutable. Match all three tenant coordinates and leave
-- ambiguous historical links unset rather than guessing their provenance.
UPDATE pipeline_runs AS run
SET topic_id = slot.topic_id
FROM calendar_slots AS slot
JOIN topics AS topic ON topic.id = slot.topic_id
  AND topic.org_id = slot.org_id AND topic.brand_id = slot.brand_id
WHERE run.id = slot.run_id
  AND run.org_id = slot.org_id AND run.brand_id = slot.brand_id
  AND run.topic_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM calendar_slots AS other
    WHERE other.run_id = run.id
      AND other.topic_id IS DISTINCT FROM slot.topic_id
  );
--> statement-breakpoint
-- The dispatch record is immutable and already identifies one topic per run.
UPDATE pipeline_runs AS run
SET topic_id = dispatch.topic_id
FROM autopilot_dispatches AS dispatch
JOIN topics AS topic ON topic.id = dispatch.topic_id
  AND topic.org_id = dispatch.org_id AND topic.brand_id = dispatch.brand_id
WHERE run.id = dispatch.run_id
  AND run.org_id = dispatch.org_id AND run.brand_id = dispatch.brand_id
  AND run.topic_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM calendar_slots AS slot
    WHERE slot.run_id = run.id AND slot.topic_id IS NOT NULL
  );
