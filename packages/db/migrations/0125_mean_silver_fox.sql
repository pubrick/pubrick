CREATE TABLE "api_request_limits" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"expire" bigint
);
--> statement-breakpoint
CREATE TABLE "public_api_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"operation" text NOT NULL,
	"key_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"hash_version" text NOT NULL,
	"result_id" uuid NOT NULL,
	"consent_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_api_operations_operation_check" CHECK ("public_api_operations"."operation" in ('content:create', 'generation:create')),
	CONSTRAINT "public_api_operations_idempotency_key_check" CHECK ("public_api_operations"."idempotency_key" ~ '^[A-Za-z0-9._-]{8,128}$'),
	CONSTRAINT "public_api_operations_request_hash_check" CHECK ("public_api_operations"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "public_api_operations_hash_version_check" CHECK ("public_api_operations"."hash_version" = 'parsed-dto-v1'),
	CONSTRAINT "public_api_operations_consent_check" CHECK (("public_api_operations"."operation" = 'content:create' AND "public_api_operations"."consent_version" IS NULL) OR ("public_api_operations"."operation" = 'generation:create' AND "public_api_operations"."consent_version" IS NOT NULL AND "public_api_operations"."consent_version" = 'byok-paid-generation-v1'))
);
--> statement-breakpoint
ALTER TABLE "organization_api_keys" DROP CONSTRAINT "organization_api_keys_scope_check";--> statement-breakpoint
ALTER TABLE "adaptations" DROP CONSTRAINT "adaptations_origin_check";--> statement-breakpoint
ALTER TABLE "content_items" DROP CONSTRAINT "content_items_origin_check";--> statement-breakpoint
ALTER TABLE "content_versions" DROP CONSTRAINT "content_versions_origin_check";--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "requires_imported_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "public_api_operations" ADD CONSTRAINT "public_api_operations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_request_limits_expire_key_idx" ON "api_request_limits" USING btree ("expire","key");--> statement-breakpoint
CREATE UNIQUE INDEX "public_api_operations_replay_idx" ON "public_api_operations" USING btree ("org_id","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "public_api_operations_org_id_idx" ON "public_api_operations" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_scope_check" CHECK ("organization_api_keys"."scope" in ('content:read', 'publications:read', 'content:create', 'generation:create')) NOT VALID;--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_origin_check" CHECK ("adaptations"."origin" in ('ai', 'human', 'external')) NOT VALID;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_external_review_check" CHECK ("content_items"."origin" <> 'external' OR "content_items"."requires_imported_review") NOT VALID;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_origin_check" CHECK ("content_items"."origin" in ('ai', 'human', 'external')) NOT VALID;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_origin_check" CHECK ("content_versions"."origin" in ('ai', 'human', 'external')) NOT VALID;
--> statement-breakpoint
CREATE FUNCTION public_api_operations_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Public API operation audit is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER public_api_operations_immutable BEFORE UPDATE ON public_api_operations
FOR EACH ROW EXECUTE FUNCTION public_api_operations_immutable();
--> statement-breakpoint
CREATE FUNCTION content_imported_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.requires_imported_review AND NOT NEW.requires_imported_review THEN
    RAISE EXCEPTION 'Imported review obligation is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_imported_review_immutable BEFORE UPDATE ON content_items
FOR EACH ROW EXECUTE FUNCTION content_imported_review_immutable();
