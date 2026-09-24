CREATE TABLE "organization_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scope" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "organization_api_keys_scope_check" CHECK ("organization_api_keys"."scope" = 'content:read'),
	CONSTRAINT "organization_api_keys_name_check" CHECK (char_length("organization_api_keys"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_api_keys_org_id_idx" ON "organization_api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_api_keys_prefix_idx" ON "organization_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_api_keys_hash_idx" ON "organization_api_keys" USING btree ("key_hash");
