CREATE TABLE "publication_metrics" (
	"publication_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"status" text NOT NULL,
	"views" integer,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_metrics_status_check" CHECK ("publication_metrics"."status" in ('refreshing', 'available', 'unavailable', 'error')),
	CONSTRAINT "publication_metrics_counts_check" CHECK (("publication_metrics"."views" is null or "publication_metrics"."views" >= 0) and ("publication_metrics"."likes" is null or "publication_metrics"."likes" >= 0) and ("publication_metrics"."comments" is null or "publication_metrics"."comments" >= 0) and ("publication_metrics"."shares" is null or "publication_metrics"."shares" >= 0))
);
--> statement-breakpoint
ALTER TABLE "publication_metrics" ADD CONSTRAINT "publication_metrics_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_metrics" ADD CONSTRAINT "publication_metrics_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_metrics_org_id_idx" ON "publication_metrics" USING btree ("org_id");