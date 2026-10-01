CREATE UNIQUE INDEX "pipeline_runs_scope_id_idx" ON "pipeline_runs" USING btree ("org_id","brand_id","id");
--> statement-breakpoint
CREATE TABLE "content_reuse_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"hash_version" text NOT NULL,
	"root_source_id" uuid NOT NULL,
	"root_source_revision" integer NOT NULL,
	"request_target_kind" text NOT NULL,
	"request_target_id" uuid NOT NULL,
	"result_run_id" uuid NOT NULL,
	"consenting_actor_id" text NOT NULL,
	"consent_version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_reuse_operations_operation_check" CHECK ("content_reuse_operations"."operation" in ('reuse', 'reuse-retry')),
	CONSTRAINT "content_reuse_operations_request_target_kind_check" CHECK ("content_reuse_operations"."request_target_kind" in ('content', 'run')),
	CONSTRAINT "content_reuse_operations_target_check" CHECK (("content_reuse_operations"."operation" = 'reuse' and "content_reuse_operations"."request_target_kind" = 'content' and "content_reuse_operations"."request_target_id" = "content_reuse_operations"."root_source_id") or ("content_reuse_operations"."operation" = 'reuse-retry' and "content_reuse_operations"."request_target_kind" = 'run')),
	CONSTRAINT "content_reuse_operations_key_check" CHECK ("content_reuse_operations"."idempotency_key" ~ '^[A-Za-z0-9._-]{8,128}$'),
	CONSTRAINT "content_reuse_operations_hash_check" CHECK ("content_reuse_operations"."request_hash" ~ '^[a-f0-9]{64}$' and "content_reuse_operations"."hash_version" = 'parsed-dto-v1'),
	CONSTRAINT "content_reuse_operations_revision_check" CHECK ("content_reuse_operations"."root_source_revision" >= 0),
	CONSTRAINT "content_reuse_operations_consent_check" CHECK ("content_reuse_operations"."consent_version" = 'byok-paid-generation-v1' and length("content_reuse_operations"."consenting_actor_id") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "run_source_lineage" (
	"derived_run_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"source_content_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"source_title" text,
	"source_digest" varchar(64),
	"source_origin" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_redacted_at" timestamp with time zone,
	CONSTRAINT "run_source_lineage_revision_check" CHECK ("run_source_lineage"."source_revision" >= 0),
	CONSTRAINT "run_source_lineage_digest_check" CHECK ("run_source_lineage"."source_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "run_source_lineage_source_origin_check" CHECK ("run_source_lineage"."source_origin" in ('ai', 'human', 'external')),
	CONSTRAINT "run_source_lineage_redaction_check" CHECK (("run_source_lineage"."source_redacted_at" is null and "run_source_lineage"."source_digest" is not null and "run_source_lineage"."source_origin" is not null) or ("run_source_lineage"."source_redacted_at" is not null and "run_source_lineage"."source_title" is null and "run_source_lineage"."source_digest" is null and "run_source_lineage"."source_origin" is null))
);
--> statement-breakpoint
ALTER TABLE "content_reuse_operations" ADD CONSTRAINT "content_reuse_operations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reuse_operations" ADD CONSTRAINT "content_reuse_operations_brand_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_source_lineage" ADD CONSTRAINT "run_source_lineage_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_source_lineage" ADD CONSTRAINT "run_source_lineage_brand_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_source_lineage" ADD CONSTRAINT "run_source_lineage_run_fk" FOREIGN KEY ("org_id","brand_id","derived_run_id") REFERENCES "public"."pipeline_runs"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_reuse_operations_replay_idx" ON "content_reuse_operations" USING btree ("org_id","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "content_reuse_operations_org_idx" ON "content_reuse_operations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "run_source_lineage_source_idx" ON "run_source_lineage" USING btree ("org_id","brand_id","source_content_id","derived_run_id");
--> statement-breakpoint
CREATE FUNCTION content_reuse_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Reuse operation audit is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER content_reuse_operation_immutable BEFORE UPDATE ON content_reuse_operations
FOR EACH ROW EXECUTE FUNCTION content_reuse_operation_immutable();
--> statement-breakpoint
CREATE FUNCTION run_source_lineage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.derived_run_id, NEW.org_id, NEW.brand_id, NEW.source_content_id, NEW.source_revision, NEW.accepted_at)
     IS DISTINCT FROM
     (OLD.derived_run_id, OLD.org_id, OLD.brand_id, OLD.source_content_id, OLD.source_revision, OLD.accepted_at) THEN
    RAISE EXCEPTION 'Reuse lineage identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.source_redacted_at IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Reuse source erasure is terminal' USING ERRCODE = '23514';
  END IF;
  IF OLD.source_redacted_at IS NULL AND NEW.source_redacted_at IS NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Reuse source snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER run_source_lineage_immutable BEFORE UPDATE ON run_source_lineage
FOR EACH ROW EXECUTE FUNCTION run_source_lineage_immutable();
