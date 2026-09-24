CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_http_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_event_check" CHECK ("webhook_deliveries"."event" in ('publication.succeeded', 'publication.failed', 'publication.unknown')),
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending', 'attempting', 'sent', 'failed', 'unknown')),
	CONSTRAINT "webhook_deliveries_attempts_check" CHECK ("webhook_deliveries"."attempts" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"endpoint_encrypted" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"on_succeeded" boolean DEFAULT true NOT NULL,
	"on_failed" boolean DEFAULT true NOT NULL,
	"on_unknown" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "webhook_subscriptions_name_check" CHECK (char_length("webhook_subscriptions"."name") between 1 and 80),
	CONSTRAINT "webhook_subscriptions_endpoint_check" CHECK (char_length("webhook_subscriptions"."endpoint_encrypted") between 1 and 4096)
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("subscription_id","publication_id","event");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_org_idx" ON "webhook_subscriptions" USING btree ("org_id");
--> statement-breakpoint
CREATE FUNCTION pubrick_queue_publication_webhooks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  subscription_record record;
  event_name text;
BEGIN
  IF NEW.status NOT IN ('published', 'failed', 'unknown') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = NEW.status THEN
      RETURN NEW;
    END IF;
  END IF;

  event_name := CASE NEW.status
    WHEN 'published' THEN 'publication.succeeded'
    WHEN 'failed' THEN 'publication.failed'
    ELSE 'publication.unknown'
  END;

  FOR subscription_record IN
    SELECT id FROM webhook_subscriptions
    WHERE org_id = NEW.org_id AND revoked_at IS NULL
      AND (CASE NEW.status
        WHEN 'published' THEN on_succeeded
        WHEN 'failed' THEN on_failed
        ELSE on_unknown
      END)
  LOOP
    INSERT INTO webhook_deliveries
      (org_id, subscription_id, publication_id, event, payload)
    VALUES
      (NEW.org_id, subscription_record.id, NEW.id, event_name,
       jsonb_build_object(
         'publicationId', NEW.id,
         'adaptationId', NEW.adaptation_id,
         'channelId', NEW.channel_id,
         'status', NEW.status,
         'attempt', NEW.attempt
       ))
    ON CONFLICT (subscription_id, publication_id, event) DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER publications_queue_webhooks
AFTER INSERT OR UPDATE OF status ON publications
FOR EACH ROW EXECUTE FUNCTION pubrick_queue_publication_webhooks();
