CREATE TABLE "adaptations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"body" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_at" timestamp,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"adaptation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text NOT NULL,
	"external_id" text,
	"external_url" text,
	"error" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_adaptation_id_adaptations_id_fk" FOREIGN KEY ("adaptation_id") REFERENCES "public"."adaptations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adaptations_org_id_idx" ON "adaptations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "adaptations_content_item_id_idx" ON "adaptations" USING btree ("content_item_id");--> statement-breakpoint
CREATE INDEX "adaptations_channel_id_idx" ON "adaptations" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "content_items_org_id_idx" ON "content_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "content_items_brand_id_idx" ON "content_items" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "publications_org_id_idx" ON "publications" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "publications_adaptation_id_idx" ON "publications" USING btree ("adaptation_id");