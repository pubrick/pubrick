CREATE TABLE "notification_digest_configs" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"local_hour" integer DEFAULT 9 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_digest_configs_hour_check" CHECK ("notification_digest_configs"."local_hour" between 0 and 23)
);
--> statement-breakpoint
CREATE TABLE "notification_digest_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"local_date" text NOT NULL,
	"timezone" text NOT NULL,
	"summary" jsonb NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_event_check";--> statement-breakpoint
ALTER TABLE "notification_digest_configs" ADD CONSTRAINT "notification_digest_configs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_configs" ADD CONSTRAINT "notification_digest_configs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_snapshots" ADD CONSTRAINT "notification_digest_snapshots_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_digest_snapshots" ADD CONSTRAINT "notification_digest_snapshots_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_digest_configs_org_idx" ON "notification_digest_configs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_digest_snapshots_brand_day_idx" ON "notification_digest_snapshots" USING btree ("org_id","brand_id","local_date");--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_event_check" CHECK ("notification_events"."event" in ('draft_ready', 'delivery_failed', 'delivery_unknown', 'morning_digest'));