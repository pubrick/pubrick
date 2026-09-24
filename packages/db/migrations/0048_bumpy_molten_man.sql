CREATE TABLE "editorial_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"body_hash" text NOT NULL,
	"note" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "editorial_notes" ADD CONSTRAINT "editorial_notes_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_notes" ADD CONSTRAINT "editorial_notes_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_notes" ADD CONSTRAINT "editorial_notes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "editorial_notes_org_id_idx" ON "editorial_notes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "editorial_notes_item_created_idx" ON "editorial_notes" USING btree ("org_id","content_item_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
