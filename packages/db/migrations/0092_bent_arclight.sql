CREATE TABLE "brand_paid_reply_settings" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_enabled" boolean DEFAULT false NOT NULL,
	"source_revision" integer DEFAULT 0 NOT NULL,
	"publication_enabled" boolean DEFAULT false NOT NULL,
	"publication_revision" integer DEFAULT 0 NOT NULL,
	"daily_threshold_usd" numeric(10, 6) DEFAULT '1.000000' NOT NULL,
	"threshold_revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_paid_reply_settings_threshold_check" CHECK ("brand_paid_reply_settings"."daily_threshold_usd" > 0 AND "brand_paid_reply_settings"."daily_threshold_usd" <= 5),
	CONSTRAINT "brand_paid_reply_settings_revisions_check" CHECK ("brand_paid_reply_settings"."source_revision" >= 0 AND "brand_paid_reply_settings"."publication_revision" >= 0 AND "brand_paid_reply_settings"."threshold_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "organization_paid_reply_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"daily_threshold_usd" numeric(10, 6) DEFAULT '5.000000' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_paid_reply_settings_threshold_check" CHECK ("organization_paid_reply_settings"."daily_threshold_usd" > 0 AND "organization_paid_reply_settings"."daily_threshold_usd" <= 5),
	CONSTRAINT "organization_paid_reply_settings_revision_check" CHECK ("organization_paid_reply_settings"."revision" >= 0),
	CONSTRAINT "organization_paid_reply_settings_timezone_check" CHECK (length(btrim("organization_paid_reply_settings"."timezone")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "paid_reply_analysis_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"sample_version" uuid NOT NULL,
	"admission_id" uuid,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"prompt_digest" text,
	"prompt_encrypted" text,
	"sample_size" integer,
	"model_id" text,
	"price_window" text,
	"free_revision" integer,
	"paid_revision" integer,
	"org_settings_revision" integer,
	"brand_threshold_revision" integer,
	"admission_local_date" text,
	"admission_timezone" text,
	"day_start_utc" timestamp with time zone,
	"day_end_utc" timestamp with time zone,
	"reserved_max_usd" numeric(10, 6),
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "paid_reply_analysis_attempts_target_kind_check" CHECK ("paid_reply_analysis_attempts"."target_kind" in ('source_comment', 'publication_comment')),
	CONSTRAINT "paid_reply_analysis_attempts_origin_check" CHECK ("paid_reply_analysis_attempts"."origin" in ('automatic', 'manual', 'legacy')),
	CONSTRAINT "paid_reply_analysis_attempts_status_check" CHECK ("paid_reply_analysis_attempts"."status" in ('queued', 'dispatching', 'ready', 'failed', 'unknown', 'canceled', 'stale', 'legacy_consumed')),
	CONSTRAINT "paid_reply_analysis_attempts_live_fields_check" CHECK ("paid_reply_analysis_attempts"."origin" = 'legacy' OR ("paid_reply_analysis_attempts"."admission_id" IS NOT NULL AND "paid_reply_analysis_attempts"."prompt_digest" IS NOT NULL AND ("paid_reply_analysis_attempts"."status" NOT IN ('queued', 'dispatching') OR "paid_reply_analysis_attempts"."prompt_encrypted" IS NOT NULL) AND "paid_reply_analysis_attempts"."sample_size" BETWEEN 1 AND 30 AND "paid_reply_analysis_attempts"."model_id" IS NOT NULL AND "paid_reply_analysis_attempts"."price_window" IS NOT NULL AND "paid_reply_analysis_attempts"."admission_local_date" IS NOT NULL AND "paid_reply_analysis_attempts"."admission_timezone" IS NOT NULL AND "paid_reply_analysis_attempts"."day_start_utc" IS NOT NULL AND "paid_reply_analysis_attempts"."day_end_utc" IS NOT NULL AND "paid_reply_analysis_attempts"."day_start_utc" < "paid_reply_analysis_attempts"."day_end_utc" AND "paid_reply_analysis_attempts"."reserved_max_usd" > 0)),
	CONSTRAINT "paid_reply_analysis_attempts_legacy_check" CHECK ("paid_reply_analysis_attempts"."origin" <> 'legacy' OR ("paid_reply_analysis_attempts"."status" = 'legacy_consumed' AND "paid_reply_analysis_attempts"."reserved_max_usd" IS NULL AND "paid_reply_analysis_attempts"."prompt_encrypted" IS NULL)),
	CONSTRAINT "paid_reply_analysis_attempts_dispatch_check" CHECK (("paid_reply_analysis_attempts"."status" = 'queued' AND "paid_reply_analysis_attempts"."dispatch_started_at" IS NULL AND "paid_reply_analysis_attempts"."completed_at" IS NULL) OR ("paid_reply_analysis_attempts"."status" = 'dispatching' AND "paid_reply_analysis_attempts"."dispatch_started_at" IS NOT NULL AND "paid_reply_analysis_attempts"."completed_at" IS NULL) OR ("paid_reply_analysis_attempts"."status" IN ('ready', 'failed', 'unknown', 'canceled', 'stale', 'legacy_consumed') AND "paid_reply_analysis_attempts"."completed_at" IS NOT NULL)),
	CONSTRAINT "paid_reply_analysis_attempts_revisions_check" CHECK (("paid_reply_analysis_attempts"."free_revision" IS NULL OR "paid_reply_analysis_attempts"."free_revision" >= 0) AND ("paid_reply_analysis_attempts"."paid_revision" IS NULL OR "paid_reply_analysis_attempts"."paid_revision" >= 0) AND ("paid_reply_analysis_attempts"."org_settings_revision" IS NULL OR "paid_reply_analysis_attempts"."org_settings_revision" >= 0) AND ("paid_reply_analysis_attempts"."brand_threshold_revision" IS NULL OR "paid_reply_analysis_attempts"."brand_threshold_revision" >= 0))
);
--> statement-breakpoint
CREATE TABLE "paid_reply_analysis_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"sample_version" uuid NOT NULL,
	"free_revision" integer NOT NULL,
	"paid_revision" integer NOT NULL,
	"org_settings_revision" integer NOT NULL,
	"brand_threshold_revision" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paid_reply_analysis_handoffs_target_kind_check" CHECK ("paid_reply_analysis_handoffs"."target_kind" in ('source_comment', 'publication_comment')),
	CONSTRAINT "paid_reply_analysis_handoffs_status_check" CHECK ("paid_reply_analysis_handoffs"."status" in ('pending', 'dispatched', 'blocked', 'canceled')),
	CONSTRAINT "paid_reply_analysis_handoffs_revisions_check" CHECK ("paid_reply_analysis_handoffs"."free_revision" >= 0 AND "paid_reply_analysis_handoffs"."paid_revision" >= 0 AND "paid_reply_analysis_handoffs"."org_settings_revision" >= 0 AND "paid_reply_analysis_handoffs"."brand_threshold_revision" >= 0),
	CONSTRAINT "paid_reply_analysis_handoffs_reason_check" CHECK (("paid_reply_analysis_handoffs"."status" IN ('blocked', 'canceled')) = ("paid_reply_analysis_handoffs"."reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "publication_comment_analyses" ADD COLUMN "sample_version" uuid;--> statement-breakpoint
ALTER TABLE "publication_comment_samples" ADD COLUMN "sample_version" uuid;--> statement-breakpoint
ALTER TABLE "news_comment_analyses" ADD COLUMN "sample_version" uuid;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "comments_sample_version" uuid;--> statement-breakpoint
ALTER TABLE "brand_paid_reply_settings" ADD CONSTRAINT "brand_paid_reply_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_paid_reply_settings" ADD CONSTRAINT "brand_paid_reply_settings_brand_org_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_paid_reply_settings" ADD CONSTRAINT "organization_paid_reply_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reply_analysis_attempts" ADD CONSTRAINT "paid_reply_analysis_attempts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reply_analysis_attempts" ADD CONSTRAINT "paid_reply_analysis_attempts_admission_id_analysis_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."analysis_admissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paid_reply_analysis_handoffs" ADD CONSTRAINT "paid_reply_analysis_handoffs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paid_reply_analysis_attempts_sample_idx" ON "paid_reply_analysis_attempts" USING btree ("org_id","target_kind","target_id","sample_version");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_reply_analysis_attempts_admission_idx" ON "paid_reply_analysis_attempts" USING btree ("admission_id") WHERE "paid_reply_analysis_attempts"."admission_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "paid_reply_analysis_attempts_org_day_idx" ON "paid_reply_analysis_attempts" USING btree ("org_id","day_start_utc","day_end_utc");--> statement-breakpoint
CREATE INDEX "paid_reply_analysis_attempts_brand_day_idx" ON "paid_reply_analysis_attempts" USING btree ("org_id","brand_id","day_start_utc");--> statement-breakpoint
CREATE INDEX "paid_reply_analysis_attempts_dispatch_idx" ON "paid_reply_analysis_attempts" USING btree ("status","dispatch_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "paid_reply_analysis_handoffs_sample_idx" ON "paid_reply_analysis_handoffs" USING btree ("org_id","target_kind","target_id","sample_version");--> statement-breakpoint
CREATE INDEX "paid_reply_analysis_handoffs_pending_idx" ON "paid_reply_analysis_handoffs" USING btree ("org_id","created_at") WHERE "paid_reply_analysis_handoffs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "usage_ledger_org_brand_created_idx" ON "usage_ledger" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
-- Install explicit default-off settings without inferring consent from free collection.
INSERT INTO organization_paid_reply_settings (org_id)
SELECT id FROM organization ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO brand_paid_reply_settings (org_id, brand_id)
SELECT org_id, id FROM brands ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE FUNCTION paid_reply_org_settings_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO organization_paid_reply_settings (org_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER paid_reply_org_settings_default AFTER INSERT ON organization
FOR EACH ROW EXECUTE FUNCTION paid_reply_org_settings_default();--> statement-breakpoint
CREATE FUNCTION paid_reply_brand_settings_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO brand_paid_reply_settings (org_id, brand_id) VALUES (NEW.org_id, NEW.id);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER paid_reply_brand_settings_default AFTER INSERT ON brands
FOR EACH ROW EXECUTE FUNCTION paid_reply_brand_settings_default();--> statement-breakpoint
-- Only persisted row sets receive versions. A failed check may retain rows.
UPDATE news_items i SET comments_sample_version = gen_random_uuid()
WHERE EXISTS (SELECT 1 FROM news_comments c WHERE c.item_id = i.id);--> statement-breakpoint
UPDATE publication_comment_samples s SET sample_version = gen_random_uuid()
WHERE EXISTS (SELECT 1 FROM publication_comments c WHERE c.publication_id = s.publication_id);--> statement-breakpoint
-- Preserve an old ready aggregate against its exact current rows when the
-- checked timestamps match. Otherwise label it as an earlier version.
UPDATE news_comment_analyses a SET sample_version =
  CASE WHEN (a.sample_checked_at = i.comments_checked_at OR i.comments_status IN ('error', 'unavailable')) AND i.comments_sample_version IS NOT NULL
    THEN i.comments_sample_version ELSE gen_random_uuid() END
FROM news_items i WHERE i.id = a.item_id;--> statement-breakpoint
UPDATE publication_comment_analyses a SET sample_version =
  CASE WHEN (a.sample_checked_at = s.checked_at OR s.status IN ('error', 'unavailable')) AND s.sample_version IS NOT NULL
    THEN s.sample_version ELSE gen_random_uuid() END
FROM publication_comment_samples s WHERE s.publication_id = a.publication_id;--> statement-breakpoint
-- One old manual admission is enough to permanently consume the current
-- sample. It does not create a handoff, reservation, or new provider call.
INSERT INTO paid_reply_analysis_attempts
  (org_id, brand_id, target_kind, target_id, sample_version, admission_id,
   origin, status, completed_at)
SELECT i.org_id, i.brand_id, 'source_comment', i.id, i.comments_sample_version,
  a.id, 'legacy', 'legacy_consumed', now()
FROM news_items i
JOIN LATERAL (
  SELECT id FROM analysis_admissions
  WHERE org_id = i.org_id AND target_kind = 'source_comment' AND target_id = i.id
  ORDER BY requested_at DESC, id DESC LIMIT 1
) a ON true
WHERE i.comments_sample_version IS NOT NULL;--> statement-breakpoint
INSERT INTO paid_reply_analysis_attempts
  (org_id, brand_id, target_kind, target_id, sample_version, admission_id,
   origin, status, completed_at)
SELECT s.org_id, s.brand_id, 'publication_comment', s.publication_id, s.sample_version,
  a.id, 'legacy', 'legacy_consumed', now()
FROM publication_comment_samples s
JOIN LATERAL (
  SELECT id FROM analysis_admissions
  WHERE org_id = s.org_id AND target_kind = 'publication_comment' AND target_id = s.publication_id
  ORDER BY requested_at DESC, id DESC LIMIT 1
) a ON true
WHERE s.sample_version IS NOT NULL;
