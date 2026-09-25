CREATE TABLE "prompt_decision_template_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"role" text NOT NULL,
	"revision_id" uuid,
	"version" integer,
	"is_default" boolean NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prompt_decision_template_revisions_role_check" CHECK ("prompt_decision_template_revisions"."role" in ('researcher', 'writer', 'editor', 'factcheck', 'adapter')),
	CONSTRAINT "prompt_decision_template_revisions_selection_check" CHECK (("prompt_decision_template_revisions"."is_default" AND "prompt_decision_template_revisions"."revision_id" IS NULL AND "prompt_decision_template_revisions"."version" IS NULL) OR (NOT "prompt_decision_template_revisions"."is_default" AND "prompt_decision_template_revisions"."revision_id" IS NOT NULL AND "prompt_decision_template_revisions"."version" IS NOT NULL AND "prompt_decision_template_revisions"."version" > 0))
);
--> statement-breakpoint
-- PostgreSQL needs the referenced composite unique key before adding the child FK.
CREATE UNIQUE INDEX "prompt_decisions_org_id_idx" ON "prompt_decisions" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "prompt_decision_template_revisions" ADD CONSTRAINT "prompt_decision_template_revisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_decision_template_revisions" ADD CONSTRAINT "prompt_decision_template_revisions_decision_fk" FOREIGN KEY ("org_id","decision_id") REFERENCES "public"."prompt_decisions"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_decision_template_revisions" ADD CONSTRAINT "prompt_decision_template_revisions_revision_fk" FOREIGN KEY ("org_id","role","revision_id") REFERENCES "public"."role_template_revisions"("org_id","role","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_decision_template_revisions_decision_role_idx" ON "prompt_decision_template_revisions" USING btree ("decision_id","role");--> statement-breakpoint
CREATE INDEX "prompt_decision_template_revisions_cohort_idx" ON "prompt_decision_template_revisions" USING btree ("org_id","role","is_default","revision_id","decided_at","decision_id");--> statement-breakpoint
-- A decision's attribution is an observation at decision time, never mutable.
-- Removing its owning organization may cascade the entire journal.
CREATE FUNCTION prompt_decision_template_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    NOT EXISTS (SELECT 1 FROM prompt_decisions WHERE id = OLD.decision_id)
    OR NOT EXISTS (SELECT 1 FROM organization WHERE id = OLD.org_id)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'template decision attribution is immutable' USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER prompt_decision_template_revisions_immutable
BEFORE UPDATE OR DELETE ON prompt_decision_template_revisions
FOR EACH ROW EXECUTE FUNCTION prompt_decision_template_revisions_immutable();
