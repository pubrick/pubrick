CREATE TABLE "search_credentials" (
	"org_id" text PRIMARY KEY NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"folder_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"claim_review_id" uuid,
	"status" text DEFAULT 'reserved' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "search_requests_status_check" CHECK ("search_requests"."status" in ('reserved', 'succeeded', 'failed')),
	CONSTRAINT "search_requests_result_check" CHECK (("search_requests"."status" = 'reserved' AND "search_requests"."completed_at" IS NULL AND "search_requests"."error_code" IS NULL) OR ("search_requests"."status" = 'succeeded' AND "search_requests"."completed_at" IS NOT NULL AND "search_requests"."error_code" IS NULL) OR ("search_requests"."status" = 'failed' AND "search_requests"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "search_credentials" ADD CONSTRAINT "search_credentials_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_requests" ADD CONSTRAINT "search_requests_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_requests_org_created_idx" ON "search_requests" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "search_requests_claim_review_idx" ON "search_requests" USING btree ("claim_review_id");