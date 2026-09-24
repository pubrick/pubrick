CREATE TABLE "draft_revision_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"source_body" text NOT NULL,
	"instruction" text NOT NULL,
	"proposal" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_revision_proposals" ADD CONSTRAINT "draft_revision_proposals_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revision_proposals" ADD CONSTRAINT "draft_revision_proposals_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_revision_proposals" ADD CONSTRAINT "draft_revision_proposals_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_revision_proposals_org_id_idx" ON "draft_revision_proposals" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_revision_proposals_item_id_idx" ON "draft_revision_proposals" USING btree ("content_item_id");