CREATE TABLE "claim_correction_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"claim_index" integer NOT NULL,
	"source_body" text NOT NULL,
	"source_body_hash" text NOT NULL,
	"claim" text NOT NULL,
	"replacement" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_correction_proposals_claim_index_check" CHECK ("claim_correction_proposals"."claim_index" >= 0),
	CONSTRAINT "claim_correction_proposals_source_body_check" CHECK (length("claim_correction_proposals"."source_body") BETWEEN 1 AND 4096),
	CONSTRAINT "claim_correction_proposals_source_hash_check" CHECK ("claim_correction_proposals"."source_body_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "claim_correction_proposals_claim_check" CHECK (length(btrim("claim_correction_proposals"."claim")) BETWEEN 1 AND 1000),
	CONSTRAINT "claim_correction_proposals_replacement_check" CHECK (length(btrim("claim_correction_proposals"."replacement")) BETWEEN 1 AND 1000),
	CONSTRAINT "claim_correction_proposals_reason_check" CHECK (length(btrim("claim_correction_proposals"."reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "claim_correction_proposals_evidence_check" CHECK (jsonb_typeof("claim_correction_proposals"."evidence") = 'array' AND jsonb_array_length("claim_correction_proposals"."evidence") BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "claim_correction_proposals" ADD CONSTRAINT "claim_correction_proposals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_correction_proposals" ADD CONSTRAINT "claim_correction_proposals_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_correction_proposals" ADD CONSTRAINT "claim_correction_proposals_review_id_claim_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."claim_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claim_correction_proposals_one_per_item_idx" ON "claim_correction_proposals" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "claim_correction_proposals_org_review_idx" ON "claim_correction_proposals" USING btree ("org_id","review_id");--> statement-breakpoint
-- The three single-column FKs guarantee cascade cleanup. This insert guard
-- ties them to the same tenant and exact claim/body; it cannot be expressed as
-- a foreign key because claim_reviews.content_item_id is nullable by design.
CREATE FUNCTION validate_claim_correction_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reviewed claim_reviews%ROWTYPE;
  quoted jsonb;
  current_body text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'claim correction proposals are immutable' USING ERRCODE = 'check_violation';
  END IF;

  SELECT body INTO current_body FROM content_items
  WHERE id = NEW.content_item_id AND org_id = NEW.org_id;
  IF NOT FOUND OR current_body IS DISTINCT FROM NEW.source_body THEN
    RAISE EXCEPTION 'correction source is not the current item body' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_body_hash <> encode(sha256(convert_to(NEW.source_body, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'correction source hash does not match its body' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO reviewed FROM claim_reviews
  WHERE id = NEW.review_id AND org_id = NEW.org_id
    AND content_item_id = NEW.content_item_id AND status = 'ready'
    AND body_hash = NEW.source_body_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction review does not match source' USING ERRCODE = 'check_violation';
  END IF;
  quoted := reviewed.claims -> NEW.claim_index;
  IF quoted IS NULL OR quoted ->> 'outcome' IS DISTINCT FROM 'evidence_conflicts'
     OR quoted ->> 'claim' IS DISTINCT FROM NEW.claim
     OR position(NEW.claim IN NEW.source_body) = 0
     OR NOT (NEW.evidence <@ COALESCE(quoted -> 'evidence', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'correction must cite the selected conflicting claim' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER validate_claim_correction_proposal
BEFORE INSERT OR UPDATE ON claim_correction_proposals
FOR EACH ROW EXECUTE FUNCTION validate_claim_correction_proposal();
