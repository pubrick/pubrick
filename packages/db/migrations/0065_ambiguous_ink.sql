CREATE UNIQUE INDEX "publications_org_id_id_idx" ON "publications" USING btree ("org_id","id");--> statement-breakpoint
CREATE TABLE "publication_comment_samples" (
	"publication_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "publication_comment_samples_status_check" CHECK ("publication_comment_samples"."status" in ('pending', 'available', 'no_comments', 'unavailable', 'error')),
	CONSTRAINT "publication_comment_samples_error_check" CHECK (("publication_comment_samples"."status" = 'error') = ("publication_comment_samples"."error_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "publication_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"telegram_message_id" integer NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "publication_comments_message_id_check" CHECK ("publication_comments"."telegram_message_id" > 0),
	CONSTRAINT "publication_comments_body_check" CHECK (length(btrim("publication_comments"."body")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "publication_comment_samples_org_brand_pub_idx" ON "publication_comment_samples" USING btree ("org_id","brand_id","publication_id");--> statement-breakpoint
ALTER TABLE "publication_comment_samples" ADD CONSTRAINT "publication_comment_samples_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_comment_samples" ADD CONSTRAINT "publication_comment_samples_publication_org_fk" FOREIGN KEY ("org_id","publication_id") REFERENCES "public"."publications"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_comment_samples" ADD CONSTRAINT "publication_comment_samples_brand_org_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_comments" ADD CONSTRAINT "publication_comments_sample_scope_fk" FOREIGN KEY ("org_id","brand_id","publication_id") REFERENCES "public"."publication_comment_samples"("org_id","brand_id","publication_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_comment_samples_brand_idx" ON "publication_comment_samples" USING btree ("org_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_comments_pub_message_idx" ON "publication_comments" USING btree ("publication_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "publication_comments_org_brand_pub_idx" ON "publication_comments" USING btree ("org_id","brand_id","publication_id");
