CREATE TABLE "adaptation_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"adaptation_id" uuid NOT NULL,
	"created_by" text,
	"master_body" text NOT NULL,
	"previous_body" text,
	"proposal" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "adaptation_proposals_proposal_nonblank" CHECK (length(btrim("adaptation_proposals"."proposal")) > 0)
);
--> statement-breakpoint
ALTER TABLE "adaptation_proposals" ADD CONSTRAINT "adaptation_proposals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptation_proposals" ADD CONSTRAINT "adaptation_proposals_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptation_proposals" ADD CONSTRAINT "adaptation_proposals_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptation_proposals" ADD CONSTRAINT "adaptation_proposals_adaptation_item_fk" FOREIGN KEY ("adaptation_id","content_item_id") REFERENCES "public"."adaptations"("id","content_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adaptation_proposals_adaptation_id_idx" ON "adaptation_proposals" USING btree ("adaptation_id");