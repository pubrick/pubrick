CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"event" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"target_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_event_check" CHECK ("notification_events"."event" in ('draft_ready', 'delivery_failed', 'delivery_unknown')),
	CONSTRAINT "notification_events_status_check" CHECK ("notification_events"."status" in ('pending', 'attempted', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"draft_ready" boolean DEFAULT false NOT NULL,
	"delivery_problem" boolean DEFAULT true NOT NULL,
	"credentials_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_events_pending_idx" ON "notification_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_unique_idx" ON "notification_events" USING btree ("org_id","event","subject_id","attempt");