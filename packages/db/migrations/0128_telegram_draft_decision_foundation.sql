CREATE TABLE "telegram_actor_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"bot_identity_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"content_item_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"snapshot_hash" text NOT NULL,
	"snapshot_version" text NOT NULL,
	"token_hash" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"send_state" text DEFAULT 'pending' NOT NULL,
	"send_attempted_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"initial_capability_id" uuid NOT NULL,
	"initial_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_actor_confirmations_state_check" CHECK ("telegram_actor_confirmations"."state" in ('pending', 'consumed', 'revoked', 'expired')),
	CONSTRAINT "telegram_actor_confirmations_send_state_check" CHECK ("telegram_actor_confirmations"."send_state" in ('pending', 'attempted', 'sent', 'rejected', 'unknown')),
	CONSTRAINT "telegram_actor_confirmations_bounds_check" CHECK (length("telegram_actor_confirmations"."user_id") between 1 and 255 AND "telegram_actor_confirmations"."generation" > 0 AND "telegram_actor_confirmations"."token_hash" ~ '^[a-f0-9]{64}$' AND "telegram_actor_confirmations"."snapshot_hash" ~ '^[a-f0-9]{64}$' AND "telegram_actor_confirmations"."snapshot_version" = 'client-review-v1' AND "telegram_actor_confirmations"."chat_id" ~ '^[1-9][0-9]{0,19}$' AND ("telegram_actor_confirmations"."message_id" IS NULL OR "telegram_actor_confirmations"."message_id" ~ '^[1-9][0-9]{0,19}$') AND "telegram_actor_confirmations"."expires_at" > "telegram_actor_confirmations"."created_at" AND "telegram_actor_confirmations"."expires_at" <= "telegram_actor_confirmations"."created_at" + interval '30 minutes' AND "telegram_actor_confirmations"."expires_at" <= "telegram_actor_confirmations"."initial_expires_at"),
	CONSTRAINT "telegram_actor_confirmations_terminal_check" CHECK (("telegram_actor_confirmations"."state" = 'pending') = ("telegram_actor_confirmations"."terminal_at" IS NULL)),
	CONSTRAINT "telegram_actor_confirmations_send_check" CHECK (("telegram_actor_confirmations"."send_state" = 'pending' AND "telegram_actor_confirmations"."send_attempted_at" IS NULL AND "telegram_actor_confirmations"."message_id" IS NULL) OR ("telegram_actor_confirmations"."send_state" <> 'pending' AND "telegram_actor_confirmations"."send_attempted_at" IS NOT NULL AND ("telegram_actor_confirmations"."send_state" <> 'sent' OR "telegram_actor_confirmations"."message_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "telegram_binding_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bot_identity_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"code_hash" text NOT NULL,
	"state" text DEFAULT 'awaiting_telegram' NOT NULL,
	"candidate_telegram_user_id" text,
	"candidate_chat_id" text,
	"candidate_display_name" text,
	"claimed_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_binding_challenges_state_check" CHECK ("telegram_binding_challenges"."state" in ('awaiting_telegram', 'awaiting_web_confirmation', 'consumed', 'revoked', 'expired')),
	CONSTRAINT "telegram_binding_challenges_bounds_check" CHECK (length("telegram_binding_challenges"."user_id") between 1 and 255 AND "telegram_binding_challenges"."generation" > 0 AND "telegram_binding_challenges"."code_hash" ~ '^[a-f0-9]{64}$' AND "telegram_binding_challenges"."expires_at" > "telegram_binding_challenges"."created_at" AND "telegram_binding_challenges"."expires_at" <= "telegram_binding_challenges"."created_at" + interval '5 minutes'),
	CONSTRAINT "telegram_binding_challenges_candidate_check" CHECK (("telegram_binding_challenges"."candidate_telegram_user_id" IS NULL AND "telegram_binding_challenges"."candidate_chat_id" IS NULL AND "telegram_binding_challenges"."candidate_display_name" IS NULL AND "telegram_binding_challenges"."claimed_at" IS NULL AND "telegram_binding_challenges"."state" <> 'awaiting_web_confirmation' AND "telegram_binding_challenges"."state" <> 'consumed') OR ("telegram_binding_challenges"."candidate_telegram_user_id" IS NOT NULL AND "telegram_binding_challenges"."candidate_telegram_user_id" ~ '^[1-9][0-9]{0,19}$' AND "telegram_binding_challenges"."candidate_chat_id" IS NOT NULL AND "telegram_binding_challenges"."candidate_chat_id" = "telegram_binding_challenges"."candidate_telegram_user_id" AND "telegram_binding_challenges"."candidate_display_name" IS NOT NULL AND length("telegram_binding_challenges"."candidate_display_name") <= 256 AND "telegram_binding_challenges"."claimed_at" IS NOT NULL AND "telegram_binding_challenges"."state" <> 'awaiting_telegram')),
	CONSTRAINT "telegram_binding_challenges_terminal_check" CHECK (("telegram_binding_challenges"."state" IN ('awaiting_telegram', 'awaiting_web_confirmation') AND "telegram_binding_challenges"."terminal_at" IS NULL) OR ("telegram_binding_challenges"."state" IN ('consumed', 'revoked', 'expired') AND "telegram_binding_challenges"."terminal_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "telegram_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bot_identity_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"telegram_user_id" text NOT NULL,
	"private_chat_id" text NOT NULL,
	"state" text DEFAULT 'linked' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bindings_state_check" CHECK ("telegram_bindings"."state" in ('linked', 'revoked')),
	CONSTRAINT "telegram_bindings_identity_check" CHECK (length("telegram_bindings"."user_id") between 1 and 255 AND "telegram_bindings"."generation" > 0 AND "telegram_bindings"."telegram_user_id" ~ '^[1-9][0-9]{0,19}$' AND "telegram_bindings"."private_chat_id" = "telegram_bindings"."telegram_user_id"),
	CONSTRAINT "telegram_bindings_revocation_check" CHECK (("telegram_bindings"."state" = 'linked' AND "telegram_bindings"."revoked_at" IS NULL) OR ("telegram_bindings"."state" = 'revoked' AND "telegram_bindings"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "telegram_bot_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" text NOT NULL,
	"owner_org_id" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"remote_state" text DEFAULT 'idle' NOT NULL,
	"remote_mutation" text,
	"remote_generation" integer,
	"request_fingerprint" text,
	"attempt_id" uuid,
	"unresolved_attempts" integer DEFAULT 0 NOT NULL,
	"attempted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_bot_identities_owner_id_idx" UNIQUE("owner_org_id","id"),
	CONSTRAINT "telegram_bot_identities_bot_check" CHECK ("telegram_bot_identities"."bot_id" ~ '^[1-9][0-9]{0,19}$'),
	CONSTRAINT "telegram_bot_identities_generation_check" CHECK ("telegram_bot_identities"."generation" > 0 AND ("telegram_bot_identities"."remote_generation" IS NULL OR "telegram_bot_identities"."remote_generation" > 0)),
	CONSTRAINT "telegram_bot_identities_remote_state_check" CHECK ("telegram_bot_identities"."remote_state" in ('idle', 'attempted', 'confirmed', 'rejected', 'unknown')),
	CONSTRAINT "telegram_bot_identities_remote_mutation_check" CHECK ("telegram_bot_identities"."remote_mutation" in ('install', 'delete')),
	CONSTRAINT "telegram_bot_identities_authority_check" CHECK (NOT "telegram_bot_identities"."enabled" OR ("telegram_bot_identities"."owner_org_id" IS NOT NULL AND NOT "telegram_bot_identities"."quarantined")),
	CONSTRAINT "telegram_bot_identities_lane_check" CHECK ("telegram_bot_identities"."unresolved_attempts" >= 0 AND (("telegram_bot_identities"."remote_state" = 'idle' AND "telegram_bot_identities"."remote_mutation" IS NULL AND "telegram_bot_identities"."remote_generation" IS NULL AND "telegram_bot_identities"."request_fingerprint" IS NULL AND "telegram_bot_identities"."attempt_id" IS NULL AND "telegram_bot_identities"."attempted_at" IS NULL AND "telegram_bot_identities"."unresolved_attempts" = 0) OR ("telegram_bot_identities"."remote_state" <> 'idle' AND "telegram_bot_identities"."remote_mutation" IS NOT NULL AND "telegram_bot_identities"."remote_generation" IS NOT NULL AND "telegram_bot_identities"."request_fingerprint" IS NOT NULL AND "telegram_bot_identities"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND "telegram_bot_identities"."attempt_id" IS NOT NULL AND "telegram_bot_identities"."attempted_at" IS NOT NULL)) AND ("telegram_bot_identities"."remote_state" NOT IN ('attempted', 'unknown') OR "telegram_bot_identities"."unresolved_attempts" > 0))
);
--> statement-breakpoint
CREATE TABLE "telegram_decision_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"bot_identity_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"capability_id" uuid NOT NULL,
	"update_id" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"snapshot_version" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_decision_audit_action_check" CHECK ("telegram_decision_audit"."action" in ('reject')),
	CONSTRAINT "telegram_decision_audit_outcome_check" CHECK ("telegram_decision_audit"."outcome" in ('rejected')),
	CONSTRAINT "telegram_decision_audit_shape_check" CHECK (length("telegram_decision_audit"."actor_user_id") between 1 and 255 AND "telegram_decision_audit"."generation" > 0 AND "telegram_decision_audit"."update_id" ~ '^(0|[1-9][0-9]{0,19})$' AND "telegram_decision_audit"."snapshot_hash" ~ '^[a-f0-9]{64}$' AND "telegram_decision_audit"."snapshot_version" = 'client-review-v1')
);
--> statement-breakpoint
CREATE TABLE "telegram_decision_configs" (
	"org_id" text PRIMARY KEY NOT NULL,
	"bot_identity_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'disabled' NOT NULL,
	"route_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"retry_payload_encrypted" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_decision_configs_revision_check" CHECK ("telegram_decision_configs"."revision" > 0 AND "telegram_decision_configs"."generation" > 0),
	CONSTRAINT "telegram_decision_configs_secret_check" CHECK ("telegram_decision_configs"."route_id" ~ '^[A-Za-z0-9_-]{43}$' AND "telegram_decision_configs"."secret_hash" ~ '^[a-f0-9]{64}$' AND length("telegram_decision_configs"."credentials_encrypted") between 1 and 16384 AND length("telegram_decision_configs"."retry_payload_encrypted") between 1 and 16384),
	CONSTRAINT "telegram_decision_configs_state_check" CHECK ("telegram_decision_configs"."state" in ('disabled', 'validating', 'ownership_conflict', 'setup_uncertain', 'active', 'disconnect_uncertain'))
);
--> statement-breakpoint
CREATE TABLE "telegram_initial_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"bot_identity_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"content_item_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"snapshot_hash" text NOT NULL,
	"snapshot_version" text NOT NULL,
	"token_hash" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"send_state" text DEFAULT 'pending' NOT NULL,
	"send_attempted_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_initial_capabilities_state_check" CHECK ("telegram_initial_capabilities"."state" in ('pending', 'consumed', 'revoked', 'expired')),
	CONSTRAINT "telegram_initial_capabilities_send_state_check" CHECK ("telegram_initial_capabilities"."send_state" in ('pending', 'attempted', 'sent', 'rejected', 'unknown')),
	CONSTRAINT "telegram_initial_capabilities_bounds_check" CHECK ("telegram_initial_capabilities"."generation" > 0 AND "telegram_initial_capabilities"."token_hash" ~ '^[a-f0-9]{64}$' AND "telegram_initial_capabilities"."snapshot_hash" ~ '^[a-f0-9]{64}$' AND "telegram_initial_capabilities"."snapshot_version" = 'client-review-v1' AND "telegram_initial_capabilities"."chat_id" ~ '^-?[1-9][0-9]{0,19}$' AND ("telegram_initial_capabilities"."message_id" IS NULL OR "telegram_initial_capabilities"."message_id" ~ '^[1-9][0-9]{0,19}$') AND "telegram_initial_capabilities"."expires_at" > "telegram_initial_capabilities"."created_at" AND "telegram_initial_capabilities"."expires_at" <= "telegram_initial_capabilities"."created_at" + interval '30 minutes'),
	CONSTRAINT "telegram_initial_capabilities_terminal_check" CHECK (("telegram_initial_capabilities"."state" = 'pending') = ("telegram_initial_capabilities"."terminal_at" IS NULL)),
	CONSTRAINT "telegram_initial_capabilities_send_check" CHECK (("telegram_initial_capabilities"."send_state" = 'pending' AND "telegram_initial_capabilities"."send_attempted_at" IS NULL AND "telegram_initial_capabilities"."message_id" IS NULL) OR ("telegram_initial_capabilities"."send_state" <> 'pending' AND "telegram_initial_capabilities"."send_attempted_at" IS NOT NULL AND ("telegram_initial_capabilities"."send_state" <> 'sent' OR "telegram_initial_capabilities"."message_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "telegram_remote_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_identity_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"mutation" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"outcome" text DEFAULT 'attempted' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "telegram_remote_attempts_mutation_check" CHECK ("telegram_remote_attempts"."mutation" in ('install', 'delete')),
	CONSTRAINT "telegram_remote_attempts_outcome_check" CHECK ("telegram_remote_attempts"."outcome" in ('attempted', 'confirmed', 'rejected', 'unknown')),
	CONSTRAINT "telegram_remote_attempts_shape_check" CHECK ("telegram_remote_attempts"."generation" > 0 AND "telegram_remote_attempts"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND (("telegram_remote_attempts"."outcome" IN ('attempted', 'unknown') AND "telegram_remote_attempts"."completed_at" IS NULL) OR ("telegram_remote_attempts"."outcome" IN ('confirmed', 'rejected') AND "telegram_remote_attempts"."completed_at" IS NOT NULL AND "telegram_remote_attempts"."completed_at" >= "telegram_remote_attempts"."started_at")))
);
--> statement-breakpoint
CREATE TABLE "telegram_update_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"bot_identity_id" uuid NOT NULL,
	"update_id" text NOT NULL,
	"generation" integer NOT NULL,
	"request_fingerprint" text NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_user_id" text,
	"capability_id" uuid,
	"decision_id" uuid,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_update_receipts_operation_check" CHECK ("telegram_update_receipts"."operation" in ('binding_start', 'probe_start', 'initial_reject', 'confirm_reject', 'cancel')),
	CONSTRAINT "telegram_update_receipts_outcome_check" CHECK ("telegram_update_receipts"."outcome" in ('accepted', 'refused')),
	CONSTRAINT "telegram_update_receipts_shape_check" CHECK ("telegram_update_receipts"."generation" > 0 AND "telegram_update_receipts"."update_id" ~ '^(0|[1-9][0-9]{0,19})$' AND "telegram_update_receipts"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND ("telegram_update_receipts"."actor_user_id" IS NULL OR length("telegram_update_receipts"."actor_user_id") between 1 and 255) AND ("telegram_update_receipts"."decision_id" IS NULL OR ("telegram_update_receipts"."operation" = 'confirm_reject' AND "telegram_update_receipts"."outcome" = 'accepted' AND "telegram_update_receipts"."actor_user_id" IS NOT NULL AND "telegram_update_receipts"."capability_id" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "telegram_actor_confirmations" ADD CONSTRAINT "telegram_actor_confirmations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_actor_confirmations" ADD CONSTRAINT "telegram_actor_confirmations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_binding_challenges" ADD CONSTRAINT "telegram_binding_challenges_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_binding_challenges" ADD CONSTRAINT "telegram_binding_challenges_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bindings" ADD CONSTRAINT "telegram_bindings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bindings" ADD CONSTRAINT "telegram_bindings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_bot_identities" ADD CONSTRAINT "telegram_bot_identities_owner_org_id_organization_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_decision_audit" ADD CONSTRAINT "telegram_decision_audit_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_decision_configs" ADD CONSTRAINT "telegram_decision_configs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_decision_configs" ADD CONSTRAINT "telegram_decision_configs_owned_bot_fk" FOREIGN KEY ("org_id","bot_identity_id") REFERENCES "public"."telegram_bot_identities"("owner_org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_initial_capabilities" ADD CONSTRAINT "telegram_initial_capabilities_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_remote_attempts" ADD CONSTRAINT "telegram_remote_attempts_bot_identity_id_telegram_bot_identities_id_fk" FOREIGN KEY ("bot_identity_id") REFERENCES "public"."telegram_bot_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_update_receipts" ADD CONSTRAINT "telegram_update_receipts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_actor_confirmations_token_idx" ON "telegram_actor_confirmations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_actor_confirmations_pending_actor_idx" ON "telegram_actor_confirmations" USING btree ("org_id","content_item_id","user_id") WHERE "telegram_actor_confirmations"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "telegram_actor_confirmations_org_idx" ON "telegram_actor_confirmations" USING btree ("org_id","id");--> statement-breakpoint
CREATE INDEX "telegram_actor_confirmations_user_idx" ON "telegram_actor_confirmations" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "telegram_actor_confirmations_cleanup_idx" ON "telegram_actor_confirmations" USING btree ("expires_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_binding_challenges_code_idx" ON "telegram_binding_challenges" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "telegram_binding_challenges_issuance_idx" ON "telegram_binding_challenges" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "telegram_binding_challenges_cleanup_idx" ON "telegram_binding_challenges" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "telegram_binding_challenges_user_idx" ON "telegram_binding_challenges" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_bindings_live_user_idx" ON "telegram_bindings" USING btree ("org_id","bot_identity_id","user_id") WHERE "telegram_bindings"."state" = 'linked';--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_bindings_live_telegram_idx" ON "telegram_bindings" USING btree ("org_id","bot_identity_id","telegram_user_id") WHERE "telegram_bindings"."state" = 'linked';--> statement-breakpoint
CREATE INDEX "telegram_bindings_org_idx" ON "telegram_bindings" USING btree ("org_id","id");--> statement-breakpoint
CREATE INDEX "telegram_bindings_user_idx" ON "telegram_bindings" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_bot_identities_bot_idx" ON "telegram_bot_identities" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "telegram_bot_identities_owner_idx" ON "telegram_bot_identities" USING btree ("owner_org_id","bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_decision_audit_capability_idx" ON "telegram_decision_audit" USING btree ("capability_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_decision_audit_update_idx" ON "telegram_decision_audit" USING btree ("bot_identity_id","update_id");--> statement-breakpoint
CREATE INDEX "telegram_decision_audit_org_item_idx" ON "telegram_decision_audit" USING btree ("org_id","content_item_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_decision_configs_route_idx" ON "telegram_decision_configs" USING btree ("route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_initial_capabilities_token_idx" ON "telegram_initial_capabilities" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "telegram_initial_capabilities_item_idx" ON "telegram_initial_capabilities" USING btree ("org_id","content_item_id","id");--> statement-breakpoint
CREATE INDEX "telegram_initial_capabilities_cleanup_idx" ON "telegram_initial_capabilities" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "telegram_remote_attempts_bot_idx" ON "telegram_remote_attempts" USING btree ("bot_identity_id","started_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_update_receipts_replay_idx" ON "telegram_update_receipts" USING btree ("bot_identity_id","update_id");--> statement-breakpoint
CREATE INDEX "telegram_update_receipts_admission_idx" ON "telegram_update_receipts" USING btree ("org_id","accepted_at","id");--> statement-breakpoint
CREATE INDEX "telegram_update_receipts_cleanup_idx" ON "telegram_update_receipts" USING btree ("accepted_at","id");--> statement-breakpoint
-- Tenant inserts acquire their deleting parents before the global registry.
-- No deletion trigger below ever takes a user or organization parent lock.
CREATE FUNCTION telegram_owned_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; bot_generation integer;
BEGIN
  PERFORM 1 FROM organization WHERE id = NEW.org_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown organization' USING ERRCODE = '23503'; END IF;
  IF TG_TABLE_NAME IN ('telegram_binding_challenges', 'telegram_bindings', 'telegram_actor_confirmations') THEN
    PERFORM 1 FROM "user" WHERE id = NEW.user_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unknown user' USING ERRCODE = '23503'; END IF;
  END IF;
  SELECT owner_org_id, generation INTO owner_id, bot_generation
    FROM telegram_bot_identities WHERE id = NEW.bot_identity_id FOR SHARE;
  IF NOT FOUND OR owner_id IS DISTINCT FROM NEW.org_id OR bot_generation <> NEW.generation THEN
    RAISE EXCEPTION 'Bot generation is not owned by organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER telegram_decision_configs_owner_guard BEFORE INSERT ON telegram_decision_configs FOR EACH ROW EXECUTE FUNCTION telegram_owned_generation_guard();
--> statement-breakpoint
CREATE TRIGGER telegram_binding_challenges_owner_guard BEFORE INSERT ON telegram_binding_challenges FOR EACH ROW EXECUTE FUNCTION telegram_owned_generation_guard();
--> statement-breakpoint
CREATE TRIGGER telegram_bindings_owner_guard BEFORE INSERT ON telegram_bindings FOR EACH ROW EXECUTE FUNCTION telegram_owned_generation_guard();
--> statement-breakpoint
CREATE TRIGGER telegram_initial_capabilities_owner_guard BEFORE INSERT ON telegram_initial_capabilities FOR EACH ROW EXECUTE FUNCTION telegram_owned_generation_guard();
--> statement-breakpoint
CREATE TRIGGER telegram_actor_confirmations_owner_guard BEFORE INSERT ON telegram_actor_confirmations FOR EACH ROW EXECUTE FUNCTION telegram_owned_generation_guard();
--> statement-breakpoint
CREATE FUNCTION telegram_record_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.bot_identity_id, NEW.generation) IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.bot_identity_id, OLD.generation) THEN
    RAISE EXCEPTION 'Telegram scoped identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('telegram_binding_challenges', 'telegram_bindings', 'telegram_actor_confirmations') THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Telegram actor identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'telegram_bindings' THEN
    IF (NEW.telegram_user_id, NEW.private_chat_id, NEW.created_at) IS DISTINCT FROM (OLD.telegram_user_id, OLD.private_chat_id, OLD.created_at)
       OR (OLD.state = 'revoked' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'Binding identity and revocation are immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'telegram_binding_challenges' THEN
    IF (NEW.code_hash, NEW.created_at, NEW.expires_at) IS DISTINCT FROM (OLD.code_hash, OLD.created_at, OLD.expires_at)
       OR (OLD.claimed_at IS NOT NULL AND (NEW.candidate_telegram_user_id, NEW.candidate_chat_id, NEW.candidate_display_name, NEW.claimed_at) IS DISTINCT FROM (OLD.candidate_telegram_user_id, OLD.candidate_chat_id, OLD.candidate_display_name, OLD.claimed_at))
       OR (OLD.terminal_at IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'Challenge claim and terminal result are immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.content_item_id, NEW.brand_id, NEW.snapshot_hash, NEW.snapshot_version, NEW.token_hash, NEW.chat_id, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM (OLD.content_item_id, OLD.brand_id, OLD.snapshot_hash, OLD.snapshot_version, OLD.token_hash, OLD.chat_id, OLD.created_at, OLD.expires_at)
       OR (OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id)
       OR (OLD.send_attempted_at IS NOT NULL AND NEW.send_attempted_at IS DISTINCT FROM OLD.send_attempted_at)
       OR (OLD.terminal_at IS NOT NULL AND (NEW.state, NEW.terminal_at) IS DISTINCT FROM (OLD.state, OLD.terminal_at)) THEN
      RAISE EXCEPTION 'Capability snapshot and terminal result are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'telegram_actor_confirmations' THEN
      IF (NEW.binding_id, NEW.initial_capability_id, NEW.initial_expires_at)
         IS DISTINCT FROM (OLD.binding_id, OLD.initial_capability_id, OLD.initial_expires_at) THEN
        RAISE EXCEPTION 'Confirmation actor is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER telegram_binding_challenges_identity_guard BEFORE UPDATE ON telegram_binding_challenges FOR EACH ROW EXECUTE FUNCTION telegram_record_identity_immutable();
--> statement-breakpoint
CREATE TRIGGER telegram_bindings_identity_guard BEFORE UPDATE ON telegram_bindings FOR EACH ROW EXECUTE FUNCTION telegram_record_identity_immutable();
--> statement-breakpoint
CREATE TRIGGER telegram_initial_capabilities_identity_guard BEFORE UPDATE ON telegram_initial_capabilities FOR EACH ROW EXECUTE FUNCTION telegram_record_identity_immutable();
--> statement-breakpoint
CREATE TRIGGER telegram_actor_confirmations_identity_guard BEFORE UPDATE ON telegram_actor_confirmations FOR EACH ROW EXECUTE FUNCTION telegram_record_identity_immutable();
--> statement-breakpoint
CREATE FUNCTION telegram_remote_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bot telegram_bot_identities%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Remote mutation evidence has no routine erasure' USING ERRCODE = '23514';
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.bot_identity_id, NEW.generation, NEW.mutation, NEW.request_fingerprint, NEW.started_at)
       IS DISTINCT FROM
       (OLD.id, OLD.bot_identity_id, OLD.generation, OLD.mutation, OLD.request_fingerprint, OLD.started_at)
       OR (OLD.outcome IN ('confirmed', 'rejected') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
       OR (OLD.outcome = 'unknown' AND NEW.outcome = 'attempted') THEN
      RAISE EXCEPTION 'Remote attempt evidence is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO bot FROM telegram_bot_identities WHERE id = NEW.bot_identity_id FOR UPDATE;
    IF NOT FOUND OR NEW.id IS DISTINCT FROM bot.attempt_id OR bot.owner_org_id IS NULL OR bot.quarantined OR NEW.generation <> bot.generation
       OR NEW.generation IS DISTINCT FROM bot.remote_generation OR NEW.mutation IS DISTINCT FROM bot.remote_mutation
       OR NEW.request_fingerprint IS DISTINCT FROM bot.request_fingerprint OR NEW.outcome <> 'attempted' THEN
      RAISE EXCEPTION 'Remote attempt does not match frozen lane' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM telegram_remote_attempts WHERE bot_identity_id = NEW.bot_identity_id AND outcome IN ('attempted', 'unknown') AND
       (generation, mutation, request_fingerprint) IS DISTINCT FROM (NEW.generation, NEW.mutation, NEW.request_fingerprint)) THEN
      RAISE EXCEPTION 'Unresolved predecessor blocks incompatible mutation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER telegram_remote_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON telegram_remote_attempts FOR EACH ROW EXECUTE FUNCTION telegram_remote_attempt_guard();
--> statement-breakpoint
CREATE FUNCTION telegram_bot_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bot reservation requires reviewed explicit recovery' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.bot_id IS DISTINCT FROM OLD.bot_id THEN
    RAISE EXCEPTION 'Verified bot identity is immutable' USING ERRCODE = '23514';
  END IF;
  -- No owner transfer/release shortcut: only parent deletion may erase an
  -- existing owner. A future release requires a separately reviewed proof.
  IF OLD.owner_org_id IS NOT NULL AND NEW.owner_org_id IS DISTINCT FROM OLD.owner_org_id AND
     (NEW.owner_org_id IS NOT NULL OR OLD.enabled OR NOT OLD.quarantined OR EXISTS (SELECT 1 FROM organization WHERE id = OLD.owner_org_id)) THEN
    RAISE EXCEPTION 'Bot ownership release requires reviewed provider recovery' USING ERRCODE = '23514';
  END IF;
  IF OLD.owner_org_id IS NULL AND OLD.quarantined AND
     (NEW.owner_org_id IS NOT NULL OR NEW.enabled OR NOT NEW.quarantined) THEN
    RAISE EXCEPTION 'Deleted owner cannot be reactivated' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM telegram_remote_attempts WHERE bot_identity_id = OLD.id AND outcome IN ('attempted', 'unknown')) AND
     (NEW.generation IS DISTINCT FROM OLD.generation OR NEW.remote_generation IS DISTINCT FROM OLD.remote_generation OR
      NEW.remote_mutation IS DISTINCT FROM OLD.remote_mutation OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint OR
      NEW.remote_state = 'idle' OR NEW.unresolved_attempts = 0 OR NOT NEW.quarantined AND OLD.quarantined OR
      (NEW.owner_org_id IS DISTINCT FROM OLD.owner_org_id AND NEW.owner_org_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Unresolved remote lane cannot be released or replaced' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER telegram_bot_identity_guard BEFORE UPDATE OR DELETE ON telegram_bot_identities FOR EACH ROW EXECUTE FUNCTION telegram_bot_identity_guard();
--> statement-breakpoint
CREATE FUNCTION telegram_config_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.revision < OLD.revision OR NEW.generation < OLD.generation THEN
    RAISE EXCEPTION 'Configuration revision cannot move backwards' USING ERRCODE = '23514';
  END IF;
  IF (NEW.bot_identity_id, NEW.generation, NEW.route_id, NEW.secret_hash, NEW.credentials_encrypted, NEW.retry_payload_encrypted)
     IS DISTINCT FROM (OLD.bot_identity_id, OLD.generation, OLD.route_id, OLD.secret_hash, OLD.credentials_encrypted, OLD.retry_payload_encrypted) THEN
    IF NEW.revision <= OLD.revision OR NEW.generation <= OLD.generation OR
       EXISTS (SELECT 1 FROM telegram_remote_attempts WHERE bot_identity_id = OLD.bot_identity_id AND outcome IN ('attempted', 'unknown')) THEN
      RAISE EXCEPTION 'Frozen generation cannot change with unresolved mutation' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM telegram_bot_identities WHERE id = NEW.bot_identity_id AND owner_org_id = NEW.org_id AND generation = NEW.generation) THEN
      RAISE EXCEPTION 'Bot generation is not owned by organization' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER telegram_config_frozen_guard BEFORE UPDATE ON telegram_decision_configs FOR EACH ROW EXECUTE FUNCTION telegram_config_frozen_guard();
--> statement-breakpoint
CREATE FUNCTION telegram_minimal_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Telegram minimal evidence is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM organization WHERE id = OLD.org_id) THEN
      RAISE EXCEPTION 'Decision evidence survives until organization deletion' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER telegram_update_receipts_immutable BEFORE UPDATE ON telegram_update_receipts FOR EACH ROW EXECUTE FUNCTION telegram_minimal_evidence_immutable();
--> statement-breakpoint
CREATE TRIGGER telegram_decision_audit_immutable BEFORE UPDATE OR DELETE ON telegram_decision_audit FOR EACH ROW EXECUTE FUNCTION telegram_minimal_evidence_immutable();
--> statement-breakpoint
-- Registry -> config secrets -> challenges -> bindings -> initial -> private
-- confirmations -> replay -> audit (the audit's direct FK runs after parent removal).
-- Sorted rows prevent overlap from choosing different child lock orders.
CREATE FUNCTION telegram_organization_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_id uuid;
BEGIN
  FOR row_id IN SELECT id FROM telegram_bot_identities WHERE owner_org_id = OLD.id ORDER BY length(bot_id), bot_id FOR UPDATE LOOP
    UPDATE telegram_bot_identities SET enabled = false, quarantined = true, updated_at = now() WHERE id = row_id;
  END LOOP;
  DELETE FROM telegram_decision_configs WHERE org_id = OLD.id;
  FOR row_id IN SELECT id FROM telegram_binding_challenges WHERE org_id = OLD.id ORDER BY id FOR UPDATE LOOP
    DELETE FROM telegram_binding_challenges WHERE id = row_id;
  END LOOP;
  FOR row_id IN SELECT id FROM telegram_bindings WHERE org_id = OLD.id ORDER BY id FOR UPDATE LOOP
    DELETE FROM telegram_bindings WHERE id = row_id;
  END LOOP;
  FOR row_id IN SELECT id FROM telegram_initial_capabilities WHERE org_id = OLD.id ORDER BY id FOR UPDATE LOOP
    DELETE FROM telegram_initial_capabilities WHERE id = row_id;
  END LOOP;
  FOR row_id IN SELECT id FROM telegram_actor_confirmations WHERE org_id = OLD.id ORDER BY id FOR UPDATE LOOP
    DELETE FROM telegram_actor_confirmations WHERE id = row_id;
  END LOOP;
  FOR row_id IN SELECT id FROM telegram_update_receipts WHERE org_id = OLD.id ORDER BY id FOR UPDATE LOOP
    DELETE FROM telegram_update_receipts WHERE id = row_id;
  END LOOP;
  PERFORM id FROM telegram_decision_audit WHERE org_id = OLD.id ORDER BY id FOR UPDATE;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER telegram_organization_delete BEFORE DELETE ON organization FOR EACH ROW EXECUTE FUNCTION telegram_organization_delete();
--> statement-breakpoint
CREATE FUNCTION telegram_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_id uuid;
BEGIN
  FOR row_id IN SELECT id FROM telegram_binding_challenges WHERE user_id = OLD.id ORDER BY id FOR UPDATE LOOP
    DELETE FROM telegram_binding_challenges WHERE id = row_id;
  END LOOP;
  FOR row_id IN SELECT id FROM telegram_bindings WHERE user_id = OLD.id ORDER BY id FOR UPDATE LOOP
    DELETE FROM telegram_bindings WHERE id = row_id;
  END LOOP;
  FOR row_id IN SELECT id FROM telegram_actor_confirmations WHERE user_id = OLD.id ORDER BY id FOR UPDATE LOOP
    DELETE FROM telegram_actor_confirmations WHERE id = row_id;
  END LOOP;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER telegram_user_delete BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION telegram_user_delete();
