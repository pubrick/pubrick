CREATE TABLE "role_template_activation_gate" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"activation_enabled" boolean DEFAULT false NOT NULL,
	"release_epoch" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_template_activation_gate_singleton_check" CHECK ("role_template_activation_gate"."id" = 1),
	CONSTRAINT "role_template_activation_gate_epoch_check" CHECK ("role_template_activation_gate"."release_epoch" >= 0),
	CONSTRAINT "role_template_activation_gate_enabled_epoch_check" CHECK (NOT "role_template_activation_gate"."activation_enabled" OR "role_template_activation_gate"."release_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "role_template_heads" (
	"org_id" text NOT NULL,
	"role" text NOT NULL,
	"active_revision_id" uuid,
	"generation" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "role_template_heads_org_role_pk" PRIMARY KEY("org_id","role"),
	CONSTRAINT "role_template_heads_role_check" CHECK ("role_template_heads"."role" in ('researcher', 'writer', 'editor', 'factcheck', 'adapter')),
	CONSTRAINT "role_template_heads_generation_check" CHECK ("role_template_heads"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "role_template_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"role" text NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"source_sha256" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_template_revisions_role_check" CHECK ("role_template_revisions"."role" in ('researcher', 'writer', 'editor', 'factcheck', 'adapter')),
	CONSTRAINT "role_template_revisions_version_check" CHECK ("role_template_revisions"."version" > 0),
	CONSTRAINT "role_template_revisions_source_check" CHECK (char_length("role_template_revisions"."source") BETWEEN 1 AND 12000 AND octet_length("role_template_revisions"."source") <= 49152 AND length(btrim("role_template_revisions"."source")) > 0),
	CONSTRAINT "role_template_revisions_sha_check" CHECK ("role_template_revisions"."source_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "template_snapshot" jsonb;--> statement-breakpoint
-- PostgreSQL needs the referenced composite unique index before the head FK.
CREATE UNIQUE INDEX "role_template_revisions_org_role_version_idx" ON "role_template_revisions" USING btree ("org_id","role","version");--> statement-breakpoint
CREATE UNIQUE INDEX "role_template_revisions_org_role_id_idx" ON "role_template_revisions" USING btree ("org_id","role","id");--> statement-breakpoint
ALTER TABLE "role_template_heads" ADD CONSTRAINT "role_template_heads_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_template_heads" ADD CONSTRAINT "role_template_heads_active_revision_fk" FOREIGN KEY ("org_id","role","active_revision_id") REFERENCES "public"."role_template_revisions"("org_id","role","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_template_revisions" ADD CONSTRAINT "role_template_revisions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_template_revisions" ADD CONSTRAINT "role_template_revisions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_template_revisions_org_role_created_idx" ON "role_template_revisions" USING btree ("org_id","role","created_at");--> statement-breakpoint
-- A missing gate row must fail closed; deployment alone may enable it after old workers drain.
INSERT INTO role_template_activation_gate (id) VALUES (1);--> statement-breakpoint
-- Revision text, version and attribution are permanent while their organization exists.
-- An organization cascade may still remove its entire tenant-owned history.
CREATE FUNCTION role_template_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The created_by FK uses ON DELETE SET NULL. Preserve every other field,
  -- and only permit that FK action after its user row has been deleted.
  IF TG_OP = 'UPDATE' AND OLD.created_by IS NOT NULL
    AND NEW.created_by IS NULL
    AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = OLD.created_by)
    AND (NEW.id, NEW.org_id, NEW.role, NEW.version, NEW.source,
         NEW.source_sha256, NEW.created_at) IS NOT DISTINCT FROM
        (OLD.id, OLD.org_id, OLD.role, OLD.version, OLD.source,
         OLD.source_sha256, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM organization WHERE id = OLD.org_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'role template revisions are immutable' USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER role_template_revisions_immutable
BEFORE UPDATE OR DELETE ON role_template_revisions
FOR EACH ROW EXECUTE FUNCTION role_template_revisions_immutable();
