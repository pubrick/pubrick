CREATE TABLE "linkedin_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"state_hash" text NOT NULL,
	"nonce_encrypted" text NOT NULL,
	"channel_id" uuid,
	"expected_generation" integer,
	"expected_target" text,
	"name" text NOT NULL,
	"locale" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_authorization_hash_check" CHECK ("linkedin_authorization_requests"."state_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "linkedin_authorization_actor_check" CHECK (length("linkedin_authorization_requests"."user_id") between 1 and 200 and length("linkedin_authorization_requests"."session_id") between 1 and 200),
	CONSTRAINT "linkedin_authorization_name_check" CHECK (length("linkedin_authorization_requests"."name") between 1 and 200),
	CONSTRAINT "linkedin_authorization_requests_locale_check" CHECK ("linkedin_authorization_requests"."locale" in ('en', 'es', 'ru', 'pt')),
	CONSTRAINT "linkedin_authorization_intent_check" CHECK (("linkedin_authorization_requests"."channel_id" is null and "linkedin_authorization_requests"."expected_generation" is null and "linkedin_authorization_requests"."expected_target" is null) or ("linkedin_authorization_requests"."channel_id" is not null and "linkedin_authorization_requests"."expected_generation" is not null and "linkedin_authorization_requests"."expected_generation" >= 0 and "linkedin_authorization_requests"."expected_target" is not null and "linkedin_authorization_requests"."expected_target" ~ '^urn:li:person:[A-Za-z0-9_-]{1,200}$')),
	CONSTRAINT "linkedin_authorization_expiry_check" CHECK ("linkedin_authorization_requests"."expires_at" > "linkedin_authorization_requests"."created_at" and "linkedin_authorization_requests"."expires_at" <= "linkedin_authorization_requests"."created_at" + interval '10 minutes')
);
--> statement-breakpoint
ALTER TABLE "editorial_placeholders" DROP CONSTRAINT "editorial_placeholders_platform_check";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_platform_check";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_credentials_mode_check";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "connection_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "connection_account" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "connection_scopes" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "connection_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "connection_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "connection_disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linkedin_authorization_requests" ADD CONSTRAINT "linkedin_authorization_requests_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_authorization_requests" ADD CONSTRAINT "linkedin_authorization_brand_org_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_org_brand_id_idx" ON "channels" USING btree ("org_id","brand_id","id");--> statement-breakpoint
ALTER TABLE "linkedin_authorization_requests" ADD CONSTRAINT "linkedin_authorization_channel_brand_org_fk" FOREIGN KEY ("org_id","brand_id","channel_id") REFERENCES "public"."channels"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_authorization_state_hash_idx" ON "linkedin_authorization_requests" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "linkedin_authorization_org_expiry_idx" ON "linkedin_authorization_requests" USING btree ("org_id","expires_at");--> statement-breakpoint
ALTER TABLE "editorial_placeholders" ADD CONSTRAINT "editorial_placeholders_platform_check" CHECK ("editorial_placeholders"."platform" in ('telegram', 'vk', 'dzen', 'vc_ru', 'instagram', 'youtube', 'rutube', 'tenchat', 't_j', 'max', 'bluesky', 'mastodon', 'x', 'wordpress', 'linkedin'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_connection_generation_check" CHECK ("channels"."connection_generation" >= 0);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_connection_account_check" CHECK ("channels"."connection_account" is null or length("channels"."connection_account") between 1 and 300);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_connection_scopes_check" CHECK ("channels"."connection_scopes" is null or length("channels"."connection_scopes") <= 2048);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_linkedin_target_check" CHECK ("channels"."platform" <> 'linkedin' or ("channels"."connection_target" is not null and "channels"."connection_target" ~ '^urn:li:person:[A-Za-z0-9_-]{1,200}$'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_platform_check" CHECK ("channels"."platform" in ('telegram', 'vk', 'dzen', 'vc_ru', 'instagram', 'youtube', 'rutube', 'tenchat', 't_j', 'max', 'bluesky', 'mastodon', 'x', 'wordpress', 'linkedin'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_credentials_mode_check" CHECK ("channels"."platform" in ('dzen', 'linkedin') or (("channels"."platform" in ('vc_ru', 'instagram', 'youtube', 'rutube', 'tenchat', 't_j')) = ("channels"."credentials_encrypted" is null)));