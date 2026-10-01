CREATE TABLE "editorial_plan_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"local_time" text NOT NULL,
	"timezone" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"offset_minutes" double precision,
	"plan_revision" integer NOT NULL,
	"brief" text NOT NULL,
	"channel_ids" jsonb NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"slot_id" uuid,
	"run_id" uuid,
	"dispatched_at" timestamp with time zone,
	"consent_version" text,
	"consenting_actor_id" text,
	"consented_at" timestamp with time zone,
	"consented_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editorial_plan_occurrences_state_check" CHECK ("editorial_plan_occurrences"."state" in ('planned', 'suspended', 'dispatched', 'skipped', 'cancelled')),
	CONSTRAINT "editorial_plan_occurrences_reason_check" CHECK ("editorial_plan_occurrences"."reason" in ('manual_skip', 'plan_paused', 'plan_removed', 'dst_gap', 'generation_window_expired', 'channels_missing', 'provider_not_configured', 'retention_capacity_reached')),
	CONSTRAINT "editorial_plan_occurrences_revision_check" CHECK ("editorial_plan_occurrences"."plan_revision" > 0),
	CONSTRAINT "editorial_plan_occurrences_dispatch_check" CHECK (("editorial_plan_occurrences"."state" = 'dispatched') = ("editorial_plan_occurrences"."dispatched_at" is not null) and ("editorial_plan_occurrences"."dispatched_at" is not null or "editorial_plan_occurrences"."run_id" is null)),
	CONSTRAINT "editorial_plan_occurrences_time_check" CHECK ("editorial_plan_occurrences"."local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and length("editorial_plan_occurrences"."timezone") between 1 and 100 and ("editorial_plan_occurrences"."offset_minutes" is null or "editorial_plan_occurrences"."offset_minutes" between -1440 and 1440)),
	CONSTRAINT "editorial_plan_occurrences_instant_check" CHECK (("editorial_plan_occurrences"."scheduled_at" is null) = ("editorial_plan_occurrences"."offset_minutes" is null) and ("editorial_plan_occurrences"."scheduled_at" is not null or ("editorial_plan_occurrences"."state" = 'skipped' and "editorial_plan_occurrences"."reason" is not null and "editorial_plan_occurrences"."reason" = 'dst_gap'))),
	CONSTRAINT "editorial_plan_occurrences_consent_check" CHECK (("editorial_plan_occurrences"."consent_version" is null and "editorial_plan_occurrences"."consenting_actor_id" is null and "editorial_plan_occurrences"."consented_at" is null and "editorial_plan_occurrences"."consented_revision" is null and "editorial_plan_occurrences"."dispatched_at" is null) or ("editorial_plan_occurrences"."consent_version" is not null and "editorial_plan_occurrences"."consent_version" = 'byok-paid-generation-v1' and "editorial_plan_occurrences"."consenting_actor_id" is not null and length("editorial_plan_occurrences"."consenting_actor_id") between 1 and 255 and "editorial_plan_occurrences"."consented_at" is not null and "editorial_plan_occurrences"."consented_revision" is not null and "editorial_plan_occurrences"."consented_revision" = "editorial_plan_occurrences"."plan_revision"))
);
--> statement-breakpoint
CREATE TABLE "editorial_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brief" text NOT NULL,
	"channel_ids" jsonb NOT NULL,
	"weekdays" jsonb NOT NULL,
	"local_time" text NOT NULL,
	"timezone" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"consent_version" text,
	"consenting_actor_id" text,
	"consented_at" timestamp with time zone,
	"consented_revision" integer,
	"blocked_reason" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editorial_plans_revision_check" CHECK ("editorial_plans"."revision" > 0),
	CONSTRAINT "editorial_plans_text_check" CHECK (length(trim("editorial_plans"."name")) between 1 and 120 and length(trim("editorial_plans"."brief")) between 1 and 2000),
	CONSTRAINT "editorial_plans_time_check" CHECK ("editorial_plans"."local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and length("editorial_plans"."timezone") between 1 and 100),
	CONSTRAINT "editorial_plans_dates_check" CHECK ("editorial_plans"."end_date" >= "editorial_plans"."start_date" and "editorial_plans"."end_date" - "editorial_plans"."start_date" <= 366),
	CONSTRAINT "editorial_plans_arrays_check" CHECK (jsonb_typeof("editorial_plans"."weekdays") = 'array' and jsonb_array_length("editorial_plans"."weekdays") between 1 and 7 and jsonb_typeof("editorial_plans"."channel_ids") = 'array' and jsonb_array_length("editorial_plans"."channel_ids") between 1 and 20),
	CONSTRAINT "editorial_plans_consent_check" CHECK (("editorial_plans"."enabled" and "editorial_plans"."removed_at" is null and "editorial_plans"."consent_version" = 'byok-paid-generation-v1' and "editorial_plans"."consent_version" is not null and "editorial_plans"."consenting_actor_id" is not null and length("editorial_plans"."consenting_actor_id") between 1 and 255 and "editorial_plans"."consented_at" is not null and "editorial_plans"."consented_revision" is not null and "editorial_plans"."consented_revision" = "editorial_plans"."revision") or (not "editorial_plans"."enabled" and "editorial_plans"."consent_version" is null and "editorial_plans"."consenting_actor_id" is null and "editorial_plans"."consented_at" is null and "editorial_plans"."consented_revision" is null)),
	CONSTRAINT "editorial_plans_blocked_reason_check" CHECK ("editorial_plans"."blocked_reason" in ('manual_skip', 'plan_paused', 'plan_removed', 'dst_gap', 'generation_window_expired', 'channels_missing', 'provider_not_configured', 'retention_capacity_reached'))
);
--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD COLUMN "recurring_occurrence_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "editorial_plans_scope_id_idx" ON "editorial_plans" USING btree ("org_id","brand_id","id");--> statement-breakpoint
ALTER TABLE "editorial_plan_occurrences" ADD CONSTRAINT "editorial_plan_occurrences_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_plan_occurrences" ADD CONSTRAINT "editorial_plan_occurrences_plan_fk" FOREIGN KEY ("org_id","brand_id","plan_id") REFERENCES "public"."editorial_plans"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_plans" ADD CONSTRAINT "editorial_plans_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_plans" ADD CONSTRAINT "editorial_plans_brand_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "editorial_plan_occurrences_identity_idx" ON "editorial_plan_occurrences" USING btree ("plan_id","local_date");--> statement-breakpoint
CREATE UNIQUE INDEX "editorial_plan_occurrences_scope_id_idx" ON "editorial_plan_occurrences" USING btree ("org_id","brand_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "editorial_plan_occurrences_slot_idx" ON "editorial_plan_occurrences" USING btree ("slot_id") WHERE "editorial_plan_occurrences"."slot_id" is not null;--> statement-breakpoint
CREATE INDEX "editorial_plan_occurrences_history_idx" ON "editorial_plan_occurrences" USING btree ("org_id","brand_id","plan_id","id");--> statement-breakpoint
CREATE INDEX "editorial_plans_scan_idx" ON "editorial_plans" USING btree ("enabled","id") WHERE "editorial_plans"."removed_at" is null;--> statement-breakpoint
ALTER TABLE "calendar_slots" ADD CONSTRAINT "calendar_slots_recurring_occurrence_fk" FOREIGN KEY ("org_id","brand_id","recurring_occurrence_id") REFERENCES "public"."editorial_plan_occurrences"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_slots_scope_id_idx" ON "calendar_slots" USING btree ("org_id","brand_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_slots_recurring_occurrence_idx" ON "calendar_slots" USING btree ("recurring_occurrence_id") WHERE "calendar_slots"."recurring_occurrence_id" is not null;
--> statement-breakpoint
CREATE FUNCTION editorial_plan_occurrence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.brand_id, NEW.plan_id, NEW.local_date) IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.brand_id, OLD.plan_id, OLD.local_date) THEN
    RAISE EXCEPTION 'Editorial occurrence identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.dispatched_at IS NOT NULL AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'Dispatched editorial occurrence is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.plan_revision = OLD.plan_revision AND
     (NEW.brief, NEW.channel_ids, NEW.local_time, NEW.timezone, NEW.scheduled_at, NEW.offset_minutes,
      NEW.consent_version, NEW.consenting_actor_id, NEW.consented_at, NEW.consented_revision) IS DISTINCT FROM
     (OLD.brief, OLD.channel_ids, OLD.local_time, OLD.timezone, OLD.scheduled_at, OLD.offset_minutes,
      OLD.consent_version, OLD.consenting_actor_id, OLD.consented_at, OLD.consented_revision) THEN
    RAISE EXCEPTION 'Editorial snapshot changes require an explicit revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER editorial_plan_occurrence_immutable BEFORE UPDATE ON editorial_plan_occurrences
FOR EACH ROW EXECUTE FUNCTION editorial_plan_occurrence_immutable();
--> statement-breakpoint
CREATE FUNCTION editorial_plan_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision < OLD.revision OR (OLD.removed_at IS NOT NULL AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at')) THEN
    RAISE EXCEPTION 'Editorial plan revision cannot regress and removal is terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER editorial_plan_terminal BEFORE UPDATE ON editorial_plans
FOR EACH ROW EXECUTE FUNCTION editorial_plan_terminal();
--> statement-breakpoint
CREATE FUNCTION calendar_recurring_attribution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recurring_occurrence_id IS DISTINCT FROM OLD.recurring_occurrence_id OR
     (OLD.recurring_occurrence_id IS NOT NULL AND (NEW.org_id, NEW.brand_id) IS DISTINCT FROM (OLD.org_id, OLD.brand_id)) THEN
    RAISE EXCEPTION 'Recurring slot attribution is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER calendar_recurring_attribution_immutable BEFORE UPDATE ON calendar_slots
FOR EACH ROW EXECUTE FUNCTION calendar_recurring_attribution_immutable();
