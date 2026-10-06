CREATE TABLE "meta_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"application_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"channel_id" uuid,
	"expected_generation" integer,
	"expected_target" text,
	"name" text NOT NULL,
	"locale" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"page_selection_encrypted" text,
	"page_selection_consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_authorization_requests_provider_check" CHECK ("meta_authorization_requests"."provider" in ('threads', 'instagram_native', 'facebook_page')),
	CONSTRAINT "meta_authorization_application_check" CHECK ("meta_authorization_requests"."application_id" ~ '^[1-9][0-9]{0,30}$'),
	CONSTRAINT "meta_authorization_callback_check" CHECK (length("meta_authorization_requests"."redirect_uri") between 1 and 2048 and "meta_authorization_requests"."redirect_uri" ~ '^https://[^[:space:]]+$'),
	CONSTRAINT "meta_authorization_requests_locale_check" CHECK ("meta_authorization_requests"."locale" in ('en', 'es', 'ru', 'pt')),
	CONSTRAINT "meta_authorization_hash_check" CHECK ("meta_authorization_requests"."state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "meta_authorization_actor_check" CHECK (length("meta_authorization_requests"."user_id") between 1 and 200 and length("meta_authorization_requests"."session_id") between 1 and 200),
	CONSTRAINT "meta_authorization_name_check" CHECK (length("meta_authorization_requests"."name") between 1 and 200),
	CONSTRAINT "meta_authorization_expiry_check" CHECK ("meta_authorization_requests"."expires_at" > "meta_authorization_requests"."created_at" and "meta_authorization_requests"."expires_at" <= "meta_authorization_requests"."created_at" + interval '10 minutes'),
	CONSTRAINT "meta_authorization_intent_check" CHECK (
    ("meta_authorization_requests"."channel_id" is null and "meta_authorization_requests"."expected_generation" is null and "meta_authorization_requests"."expected_target" is null)
    or ("meta_authorization_requests"."channel_id" is not null and "meta_authorization_requests"."expected_generation" is not null and "meta_authorization_requests"."expected_target" is not null and "meta_authorization_requests"."expected_generation" >= 0 and
      (("meta_authorization_requests"."provider" = 'threads' and "meta_authorization_requests"."expected_target" ~ '^threads:[1-9][0-9]{0,30}$')
       or ("meta_authorization_requests"."provider" = 'instagram_native' and "meta_authorization_requests"."expected_target" ~ '^instagram:[1-9][0-9]{0,30}$')
       or ("meta_authorization_requests"."provider" = 'facebook_page' and "meta_authorization_requests"."expected_target" ~ '^facebook-page:[1-9][0-9]{0,30}$')))
  ),
	CONSTRAINT "meta_authorization_page_selection_check" CHECK (
    ("meta_authorization_requests"."page_selection_encrypted" is null or ("meta_authorization_requests"."provider" = 'facebook_page' and "meta_authorization_requests"."consumed_at" is not null and "meta_authorization_requests"."page_selection_consumed_at" is null))
    and ("meta_authorization_requests"."page_selection_consumed_at" is null or ("meta_authorization_requests"."provider" = 'facebook_page' and "meta_authorization_requests"."consumed_at" is not null and "meta_authorization_requests"."page_selection_encrypted" is null))
  )
);
--> statement-breakpoint
ALTER TABLE "editorial_placeholders" DROP CONSTRAINT "editorial_placeholders_platform_check";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_platform_check";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_credentials_mode_check";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "connection_application_id" text;--> statement-breakpoint
ALTER TABLE "meta_authorization_requests" ADD CONSTRAINT "meta_authorization_requests_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_authorization_requests" ADD CONSTRAINT "meta_authorization_brand_org_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_authorization_requests" ADD CONSTRAINT "meta_authorization_channel_brand_org_fk" FOREIGN KEY ("org_id","brand_id","channel_id") REFERENCES "public"."channels"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_authorization_state_hash_idx" ON "meta_authorization_requests" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "meta_authorization_org_expiry_idx" ON "meta_authorization_requests" USING btree ("org_id","expires_at");--> statement-breakpoint
ALTER TABLE "editorial_placeholders" ADD CONSTRAINT "editorial_placeholders_platform_check" CHECK ("editorial_placeholders"."platform" in ('telegram', 'vk', 'dzen', 'vc_ru', 'instagram', 'youtube', 'rutube', 'tenchat', 't_j', 'max', 'bluesky', 'mastodon', 'x', 'wordpress', 'linkedin', 'threads', 'instagram_native', 'facebook_page'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_connection_application_check" CHECK ("channels"."connection_application_id" is null or "channels"."connection_application_id" ~ '^[1-9][0-9]{0,30}$');--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_meta_target_check" CHECK (("channels"."platform" not in ('threads', 'instagram_native', 'facebook_page')) or
        ("channels"."connection_target" is not null and "channels"."connection_application_id" is not null and
          (("channels"."platform" = 'threads' and "channels"."connection_target" ~ '^threads:[1-9][0-9]{0,30}$') or
           ("channels"."platform" = 'instagram_native' and "channels"."connection_target" ~ '^instagram:[1-9][0-9]{0,30}$') or
           ("channels"."platform" = 'facebook_page' and "channels"."connection_target" ~ '^facebook-page:[1-9][0-9]{0,30}$'))));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_platform_check" CHECK ("channels"."platform" in ('telegram', 'vk', 'dzen', 'vc_ru', 'instagram', 'youtube', 'rutube', 'tenchat', 't_j', 'max', 'bluesky', 'mastodon', 'x', 'wordpress', 'linkedin', 'threads', 'instagram_native', 'facebook_page'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_credentials_mode_check" CHECK ("channels"."platform" in ('dzen', 'linkedin', 'threads', 'instagram_native', 'facebook_page') or (("channels"."platform" in ('vc_ru', 'instagram', 'youtube', 'rutube', 'tenchat', 't_j')) = ("channels"."credentials_encrypted" is null)));