CREATE TABLE "prompt_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"role" text NOT NULL,
	"version" integer NOT NULL,
	"guidance" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_revisions_role_check" CHECK ("prompt_revisions"."role" in ('researcher', 'writer', 'editor', 'factcheck', 'adapter')),
	CONSTRAINT "prompt_revisions_version_positive_check" CHECK ("prompt_revisions"."version" > 0),
	CONSTRAINT "prompt_revisions_guidance_limit_check" CHECK (char_length("prompt_revisions"."guidance") <= 6000)
);
--> statement-breakpoint
ALTER TABLE "prompt_revisions" ADD CONSTRAINT "prompt_revisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_revisions_org_role_version_idx" ON "prompt_revisions" USING btree ("org_id","role","version");--> statement-breakpoint
CREATE INDEX "prompt_revisions_org_role_created_idx" ON "prompt_revisions" USING btree ("org_id","role","created_at");