CREATE TABLE "prompt_decision_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"role" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prompt_decision_revisions_role_check" CHECK ("prompt_decision_revisions"."role" in ('researcher', 'writer', 'editor', 'factcheck', 'adapter')),
	CONSTRAINT "prompt_decision_revisions_version_positive_check" CHECK ("prompt_decision_revisions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "prompt_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"run_id" uuid,
	"verdict" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_decisions_ordinal_positive_check" CHECK ("prompt_decisions"."ordinal" > 0),
	CONSTRAINT "prompt_decisions_verdict_check" CHECK ("prompt_decisions"."verdict" in ('approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "prompt_decision_revisions" ADD CONSTRAINT "prompt_decision_revisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_decision_revisions" ADD CONSTRAINT "prompt_decision_revisions_decision_id_prompt_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."prompt_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_decisions" ADD CONSTRAINT "prompt_decisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_decision_revisions_decision_role_idx" ON "prompt_decision_revisions" USING btree ("decision_id","role");--> statement-breakpoint
CREATE INDEX "prompt_decision_revisions_revision_time_idx" ON "prompt_decision_revisions" USING btree ("org_id","role","revision_id","decided_at","decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_decisions_org_item_ordinal_idx" ON "prompt_decisions" USING btree ("org_id","content_item_id","ordinal");