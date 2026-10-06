CREATE TABLE "content_assignment_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_member_id" text,
	"previous_name" text,
	"assignee_member_id" text,
	"assignee_name" text,
	"actor_user_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_assignment_history_revision_check" CHECK ("content_assignment_history"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "content_assignments" (
	"content_item_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"assignee_member_id" text,
	"assignee_user_id" text,
	"assignee_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_assignments_revision_check" CHECK ("content_assignments"."revision" >= 0),
	CONSTRAINT "content_assignments_identity_check" CHECK (("content_assignments"."assignee_member_id" is null and "content_assignments"."assignee_user_id" is null and "content_assignments"."assignee_name" is null) or ("content_assignments"."assignee_member_id" is not null and length("content_assignments"."assignee_member_id") between 1 and 255 and "content_assignments"."assignee_user_id" is not null and "content_assignments"."assignee_name" is not null))
);
--> statement-breakpoint
ALTER TABLE "content_assignment_history" ADD CONSTRAINT "content_assignment_history_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assignment_history" ADD CONSTRAINT "content_assignment_history_item_org_brand_fk" FOREIGN KEY ("org_id","brand_id","content_item_id") REFERENCES "public"."content_items"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assignments" ADD CONSTRAINT "content_assignments_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assignments" ADD CONSTRAINT "content_assignments_item_org_brand_fk" FOREIGN KEY ("org_id","brand_id","content_item_id") REFERENCES "public"."content_items"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_assignment_history_org_id_idx" ON "content_assignment_history" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_assignment_history_item_revision_idx" ON "content_assignment_history" USING btree ("org_id","content_item_id","revision");--> statement-breakpoint
CREATE INDEX "content_assignments_org_assignee_idx" ON "content_assignments" USING btree ("org_id","assignee_user_id","content_item_id");