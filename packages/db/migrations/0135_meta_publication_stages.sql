CREATE TABLE "meta_publication_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"adaptation_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"attempt" integer NOT NULL,
	"input_hash" text NOT NULL,
	"frozen_input" jsonb NOT NULL,
	"target" text NOT NULL,
	"credential_generation" integer NOT NULL,
	"phase" text NOT NULL,
	"container_id" text,
	"final_publication_id" uuid,
	"external_id" text,
	"external_url" text,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"preparation_deadline" timestamp with time zone NOT NULL,
	"next_poll_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_publication_stages_platform_check" CHECK ("meta_publication_stages"."platform" in ('threads', 'instagram_native')),
	CONSTRAINT "meta_publication_stages_phase_check" CHECK ("meta_publication_stages"."phase" in ('preparation_intent', 'waiting', 'final_intent', 'published', 'preparation_unknown', 'final_unknown', 'published_without_receipt', 'failed', 'cancelled')),
	CONSTRAINT "meta_publication_stages_failure_reason_check" CHECK ("meta_publication_stages"."failure_reason" in ('preparation_receipt_lost', 'container_rejected', 'container_expired', 'preparation_deadline', 'input_changed', 'connection_changed', 'permission_refused', 'final_outcome_unknown', 'published_without_receipt', 'recording_failed')),
	CONSTRAINT "meta_publication_stages_attempt_check" CHECK ("meta_publication_stages"."attempt" > 0 and "meta_publication_stages"."credential_generation" >= 0 and "meta_publication_stages"."poll_count" between 0 and 120),
	CONSTRAINT "meta_publication_stages_input_hash_check" CHECK ("meta_publication_stages"."input_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "meta_publication_stages_target_check" CHECK (("meta_publication_stages"."platform" = 'threads' and "meta_publication_stages"."target" ~ '^threads:[1-9][0-9]{0,30}$') or ("meta_publication_stages"."platform" = 'instagram_native' and "meta_publication_stages"."target" ~ '^instagram:[1-9][0-9]{0,30}$')),
	CONSTRAINT "meta_publication_stages_input_check" CHECK (coalesce(
        jsonb_typeof("meta_publication_stages"."frozen_input") = 'object'
        and "meta_publication_stages"."frozen_input" ?& array['version','platform','text']
        and "meta_publication_stages"."frozen_input"->'version' = '1'::jsonb
        and "meta_publication_stages"."frozen_input"->>'platform' = "meta_publication_stages"."platform"
        and jsonb_typeof("meta_publication_stages"."frozen_input"->'text') = 'string'
        and length("meta_publication_stages"."frozen_input"->>'text') <= 4096
        and ("meta_publication_stages"."frozen_input" - array['version','platform','text','image']::text[]) = '{}'::jsonb
        and (
          ("meta_publication_stages"."platform" = 'threads' and not ("meta_publication_stages"."frozen_input" ? 'image'))
          or (
            "meta_publication_stages"."platform" = 'instagram_native'
            and jsonb_typeof("meta_publication_stages"."frozen_input"->'image') = 'object'
            and ("meta_publication_stages"."frozen_input"->'image') ?& array['mediaId','sha256','mimeType','width','height','byteSize']
            and (("meta_publication_stages"."frozen_input"->'image') - array['mediaId','sha256','mimeType','width','height','byteSize']::text[]) = '{}'::jsonb
            and jsonb_typeof("meta_publication_stages"."frozen_input"->'image'->'mediaId') = 'string'
            and "meta_publication_stages"."frozen_input"->'image'->>'mediaId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            and jsonb_typeof("meta_publication_stages"."frozen_input"->'image'->'sha256') = 'string'
            and "meta_publication_stages"."frozen_input"->'image'->>'sha256' ~ '^[a-f0-9]{64}$'
            and "meta_publication_stages"."frozen_input"->'image'->>'mimeType' = 'image/jpeg'
            and jsonb_typeof("meta_publication_stages"."frozen_input"->'image'->'width') = 'number'
            and case when "meta_publication_stages"."frozen_input"->'image'->>'width' ~ '^[1-9][0-9]{0,4}$' then ("meta_publication_stages"."frozen_input"->'image'->>'width')::integer <= 20000 else false end
            and jsonb_typeof("meta_publication_stages"."frozen_input"->'image'->'height') = 'number'
            and case when "meta_publication_stages"."frozen_input"->'image'->>'height' ~ '^[1-9][0-9]{0,4}$' then ("meta_publication_stages"."frozen_input"->'image'->>'height')::integer <= 20000 else false end
            and jsonb_typeof("meta_publication_stages"."frozen_input"->'image'->'byteSize') = 'number'
            and case when "meta_publication_stages"."frozen_input"->'image'->>'byteSize' ~ '^[1-9][0-9]{0,7}$' then ("meta_publication_stages"."frozen_input"->'image'->>'byteSize')::integer <= 10485760 else false end
          )
        ), false)),
	CONSTRAINT "meta_publication_stages_lease_pair_check" CHECK (("meta_publication_stages"."lease_token" is null) = ("meta_publication_stages"."lease_until" is null)),
	CONSTRAINT "meta_publication_stages_container_check" CHECK ("meta_publication_stages"."container_id" is null or "meta_publication_stages"."container_id" ~ '^[1-9][0-9]{0,30}$'),
	CONSTRAINT "meta_publication_stages_receipt_check" CHECK (("meta_publication_stages"."external_id" is null or ("meta_publication_stages"."external_id" ~ '^[1-9][0-9]{0,30}$' and "meta_publication_stages"."external_id" is distinct from "meta_publication_stages"."container_id")) and ("meta_publication_stages"."external_url" is null or length("meta_publication_stages"."external_url") <= 2048)),
	CONSTRAINT "meta_publication_stages_checkpoint_check" CHECK (("meta_publication_stages"."phase" <> 'preparation_intent' or ("meta_publication_stages"."container_id" is null and "meta_publication_stages"."final_publication_id" is null)) and ("meta_publication_stages"."phase" <> 'waiting' or ("meta_publication_stages"."container_id" is not null and "meta_publication_stages"."final_publication_id" is null)) and ("meta_publication_stages"."phase" not in ('final_intent','final_unknown','published') or ("meta_publication_stages"."container_id" is not null and "meta_publication_stages"."final_publication_id" is not null)) and ("meta_publication_stages"."phase" <> 'published' or "meta_publication_stages"."external_id" is not null) and ("meta_publication_stages"."phase" <> 'published_without_receipt' or ("meta_publication_stages"."container_id" is not null and "meta_publication_stages"."external_id" is null))),
	CONSTRAINT "meta_publication_stages_deadline_check" CHECK ("meta_publication_stages"."preparation_deadline" > "meta_publication_stages"."created_at" and "meta_publication_stages"."preparation_deadline" <= "meta_publication_stages"."created_at" + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "meta_publication_stages" ADD CONSTRAINT "meta_publication_stages_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_publication_stages" ADD CONSTRAINT "meta_publication_stages_brand_org_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_publication_stages_org_adaptation_attempt_idx" ON "meta_publication_stages" USING btree ("org_id","adaptation_id","attempt");--> statement-breakpoint
CREATE INDEX "meta_publication_stages_recovery_idx" ON "meta_publication_stages" USING btree ("org_id","phase","updated_at");--> statement-breakpoint
CREATE INDEX "meta_publication_stages_live_target_idx" ON "meta_publication_stages" USING btree ("org_id","adaptation_id","phase");