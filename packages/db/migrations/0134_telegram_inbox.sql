CREATE TABLE "inbox_activities" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"activity_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_collection_claims" (
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"publication_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"post_url" text NOT NULL,
	"title" text NOT NULL,
	"peer_id" bigint NOT NULL,
	"root_id" integer NOT NULL,
	"activity_revision" integer DEFAULT 0 NOT NULL,
	"read_revision" integer DEFAULT 0 NOT NULL,
	"resolved_revision" integer,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collection_revision" integer DEFAULT 0 NOT NULL,
	"collected_at" timestamp with time zone,
	"older_offset_id" integer,
	"window_max_id" integer,
	"has_older" boolean DEFAULT false NOT NULL,
	"collection_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_conversations_scope_id_idx" UNIQUE("org_id","brand_id","id"),
	CONSTRAINT "inbox_conversations_revisions_check" CHECK ("inbox_conversations"."activity_revision" >= 0 and "inbox_conversations"."read_revision" between 0 and "inbox_conversations"."activity_revision" and ("inbox_conversations"."resolved_revision" is null or "inbox_conversations"."resolved_revision" between 0 and "inbox_conversations"."activity_revision") and "inbox_conversations"."collection_revision" >= 0),
	CONSTRAINT "inbox_conversations_target_check" CHECK ("inbox_conversations"."root_id" > 0 and abs("inbox_conversations"."peer_id") <= 9007199254740991 and "inbox_conversations"."peer_id" <> 0 and length("inbox_conversations"."post_url") between 1 and 2048 and length("inbox_conversations"."title") <= 512),
	CONSTRAINT "inbox_conversations_window_check" CHECK (("inbox_conversations"."older_offset_id" is null or "inbox_conversations"."older_offset_id" > 0) and ("inbox_conversations"."window_max_id" is null or "inbox_conversations"."window_max_id" > 0) and (not "inbox_conversations"."has_older" or "inbox_conversations"."older_offset_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider_message_id" integer NOT NULL,
	"body" text NOT NULL,
	"body_truncated" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	CONSTRAINT "inbox_messages_scope_id_idx" UNIQUE("org_id","brand_id","conversation_id","id"),
	CONSTRAINT "inbox_messages_text_check" CHECK (length(trim("inbox_messages"."body")) between 1 and 4000 and "inbox_messages"."revision" >= 0 and "inbox_messages"."provider_message_id" > 0)
);
--> statement-breakpoint
CREATE TABLE "inbox_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"operation_key" uuid NOT NULL,
	"sender_preview_id" uuid NOT NULL,
	"message_revision" integer NOT NULL,
	"target_body" text NOT NULL,
	"target_provider_message_id" integer NOT NULL,
	"message_fingerprint" text NOT NULL,
	"body" text NOT NULL,
	"sender_label" text NOT NULL,
	"account_id" bigint NOT NULL,
	"account_generation" text NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"external_message_id" integer,
	"external_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "inbox_replies_scope_id_idx" UNIQUE("org_id","brand_id","conversation_id","id"),
	CONSTRAINT "inbox_replies_status_check" CHECK ("inbox_replies"."status" in ('sending', 'sent', 'failed', 'unknown', 'confirmed_sent', 'confirmed_not_sent')),
	CONSTRAINT "inbox_replies_body_check" CHECK (length(trim("inbox_replies"."body")) between 1 and 4000 and "inbox_replies"."message_revision" >= 0 and length("inbox_replies"."sender_label") between 1 and 256 and length("inbox_replies"."account_generation") = 64 and length("inbox_replies"."message_fingerprint") = 64 and length(trim("inbox_replies"."target_body")) between 1 and 4000 and "inbox_replies"."target_provider_message_id" > 0 and "inbox_replies"."account_id" > 0 and "inbox_replies"."account_id" <= 9007199254740991),
	CONSTRAINT "inbox_replies_receipt_check" CHECK (("inbox_replies"."external_message_id" is null or "inbox_replies"."external_message_id" > 0) and ("inbox_replies"."external_url" is null or ("inbox_replies"."external_message_id" is not null and length("inbox_replies"."external_url") between 1 and 2048)) and ("inbox_replies"."status" <> 'sent' or "inbox_replies"."external_message_id" is not null)),
	CONSTRAINT "inbox_replies_resolution_check" CHECK (("inbox_replies"."resolved_by" is null) = ("inbox_replies"."resolved_at" is null) and ("inbox_replies"."status" in ('confirmed_sent', 'confirmed_not_sent')) = ("inbox_replies"."resolved_at" is not null) and ("inbox_replies"."status" = 'sending') = ("inbox_replies"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "inbox_reply_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"reply_id" uuid NOT NULL,
	"evidence_key" text NOT NULL,
	"provider_message_id" integer NOT NULL,
	"external_url" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_reply_evidence_bounds_check" CHECK ("inbox_reply_evidence"."provider_message_id" > 0 and length("inbox_reply_evidence"."evidence_key") = 64 and ("inbox_reply_evidence"."external_url" is null or length("inbox_reply_evidence"."external_url") between 1 and 2048))
);
--> statement-breakpoint
CREATE TABLE "inbox_sender_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text NOT NULL,
	"account_generation" text NOT NULL,
	"account_id" bigint NOT NULL,
	"account_label" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "inbox_sender_previews_account_check" CHECK ("inbox_sender_previews"."account_id" > 0 and "inbox_sender_previews"."account_id" <= 9007199254740991 and length("inbox_sender_previews"."account_label") between 1 and 256 and length("inbox_sender_previews"."account_generation") = 64)
);
--> statement-breakpoint
ALTER TABLE "inbox_activities" ADD CONSTRAINT "inbox_activities_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_activities" ADD CONSTRAINT "inbox_activities_conversation_fk" FOREIGN KEY ("org_id","brand_id","conversation_id") REFERENCES "public"."inbox_conversations"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_collection_claims" ADD CONSTRAINT "inbox_collection_claims_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_collection_claims" ADD CONSTRAINT "inbox_collection_claims_brand_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_brand_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_conversation_fk" FOREIGN KEY ("org_id","brand_id","conversation_id") REFERENCES "public"."inbox_conversations"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_replies" ADD CONSTRAINT "inbox_replies_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_replies" ADD CONSTRAINT "inbox_replies_message_fk" FOREIGN KEY ("org_id","brand_id","conversation_id","message_id") REFERENCES "public"."inbox_messages"("org_id","brand_id","conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_reply_evidence" ADD CONSTRAINT "inbox_reply_evidence_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_reply_evidence" ADD CONSTRAINT "inbox_reply_evidence_reply_fk" FOREIGN KEY ("org_id","brand_id","conversation_id","reply_id") REFERENCES "public"."inbox_replies"("org_id","brand_id","conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_sender_previews" ADD CONSTRAINT "inbox_sender_previews_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_sender_previews" ADD CONSTRAINT "inbox_sender_previews_brand_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_activities_scope_seq_idx" ON "inbox_activities" USING btree ("org_id","brand_id","seq");--> statement-breakpoint
CREATE INDEX "inbox_activities_latest_idx" ON "inbox_activities" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_conversations_provider_idx" ON "inbox_conversations" USING btree ("org_id","brand_id","publication_id","peer_id","root_id");--> statement-breakpoint
CREATE INDEX "inbox_conversations_activity_idx" ON "inbox_conversations" USING btree ("org_id","brand_id","last_activity_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_messages_provider_idx" ON "inbox_messages" USING btree ("conversation_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_replies_operation_idx" ON "inbox_replies" USING btree ("org_id","actor_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_replies_unsettled_idx" ON "inbox_replies" USING btree ("conversation_id") WHERE "inbox_replies"."status" in ('sending', 'unknown');--> statement-breakpoint
CREATE INDEX "inbox_replies_conversation_idx" ON "inbox_replies" USING btree ("org_id","brand_id","conversation_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_reply_evidence_identity_idx" ON "inbox_reply_evidence" USING btree ("reply_id","evidence_key");--> statement-breakpoint
CREATE INDEX "inbox_reply_evidence_claim_idx" ON "inbox_reply_evidence" USING btree ("org_id","brand_id","conversation_id","reply_id","received_at");--> statement-breakpoint
CREATE INDEX "inbox_sender_previews_expiry_idx" ON "inbox_sender_previews" USING btree ("expires_at");