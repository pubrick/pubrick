CREATE TABLE "accepted_claim_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"fragment_version_id" uuid NOT NULL,
	"claim_index" integer NOT NULL,
	"source_body_hash" text NOT NULL,
	"claim" text NOT NULL,
	"replacement" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accepted_claim_corrections_claim_index_check" CHECK ("accepted_claim_corrections"."claim_index" >= 0),
	CONSTRAINT "accepted_claim_corrections_source_hash_check" CHECK ("accepted_claim_corrections"."source_body_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accepted_claim_corrections_claim_check" CHECK (length(btrim("accepted_claim_corrections"."claim")) BETWEEN 1 AND 1000),
	CONSTRAINT "accepted_claim_corrections_replacement_check" CHECK (length(btrim("accepted_claim_corrections"."replacement")) BETWEEN 1 AND 1000),
	CONSTRAINT "accepted_claim_corrections_reason_check" CHECK (length(btrim("accepted_claim_corrections"."reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "accepted_claim_corrections_evidence_check" CHECK (jsonb_typeof("accepted_claim_corrections"."evidence") = 'array' AND jsonb_array_length("accepted_claim_corrections"."evidence") BETWEEN 1 AND 5)
);
--> statement-breakpoint
ALTER TABLE "accepted_claim_corrections" ADD CONSTRAINT "accepted_claim_corrections_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_claim_corrections" ADD CONSTRAINT "accepted_claim_corrections_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_claim_corrections" ADD CONSTRAINT "accepted_claim_corrections_review_id_claim_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."claim_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accepted_claim_corrections" ADD CONSTRAINT "accepted_claim_corrections_fragment_version_id_content_versions_id_fk" FOREIGN KEY ("fragment_version_id") REFERENCES "public"."content_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accepted_claim_corrections_fragment_version_idx" ON "accepted_claim_corrections" USING btree ("fragment_version_id");--> statement-breakpoint
CREATE INDEX "accepted_claim_corrections_org_item_recent_idx" ON "accepted_claim_corrections" USING btree ("org_id","content_item_id","accepted_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
-- Store the exact staged suggestion before Accept deletes that stage. The
-- version row identifies which AI fragment actually entered the draft.
CREATE FUNCTION validate_accepted_claim_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reviewed claim_reviews%ROWTYPE;
  version_row content_versions%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'accepted claim corrections are immutable' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1 FROM content_items
  WHERE id = NEW.content_item_id AND org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted correction item belongs to another organization' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO reviewed FROM claim_reviews
  WHERE id = NEW.review_id AND org_id = NEW.org_id
    AND content_item_id = NEW.content_item_id AND status = 'ready'
    AND body_hash = NEW.source_body_hash;
  IF NOT FOUND OR reviewed.claims -> NEW.claim_index ->> 'claim' IS DISTINCT FROM NEW.claim
     OR reviewed.claims -> NEW.claim_index ->> 'outcome' IS DISTINCT FROM 'evidence_conflicts'
     OR NOT (NEW.evidence <@ COALESCE(reviewed.claims -> NEW.claim_index -> 'evidence', '[]'::jsonb)) THEN
    RAISE EXCEPTION 'accepted correction review does not match' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO version_row FROM content_versions
  WHERE id = NEW.fragment_version_id AND org_id = NEW.org_id
    AND content_item_id = NEW.content_item_id AND scope = 'fragment'
    AND origin = 'ai' AND adaptation_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted correction version is not an AI master fragment' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM claim_correction_proposals
  WHERE org_id = NEW.org_id AND content_item_id = NEW.content_item_id
    AND review_id = NEW.review_id AND claim_index = NEW.claim_index
    AND source_body_hash = NEW.source_body_hash AND claim = NEW.claim
    AND replacement = NEW.replacement AND reason = NEW.reason
    AND evidence = NEW.evidence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accepted correction differs from its staged proposal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER validate_accepted_claim_correction
BEFORE INSERT OR UPDATE ON accepted_claim_corrections
FOR EACH ROW EXECUTE FUNCTION validate_accepted_claim_correction();
