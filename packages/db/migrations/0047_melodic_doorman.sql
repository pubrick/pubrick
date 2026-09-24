CREATE TABLE "client_review_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"verdict" text,
	"comment" text,
	"reviewed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_review_links_token_hash_check" CHECK (length("client_review_links"."token_hash") = 64),
	CONSTRAINT "client_review_links_snapshot_hash_check" CHECK (length("client_review_links"."snapshot_hash") = 64),
	CONSTRAINT "client_review_links_verdict_check" CHECK ("client_review_links"."verdict" IS NULL OR "client_review_links"."verdict" IN ('approved', 'changes_requested')),
	CONSTRAINT "client_review_links_comment_length_check" CHECK (length("client_review_links"."comment") <= 2000),
	CONSTRAINT "client_review_links_review_pair_check" CHECK (("client_review_links"."verdict" IS NULL AND "client_review_links"."reviewed_at" IS NULL AND "client_review_links"."comment" IS NULL) OR ("client_review_links"."verdict" IS NOT NULL AND "client_review_links"."reviewed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "client_review_links" ADD CONSTRAINT "client_review_links_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_review_links" ADD CONSTRAINT "client_review_links_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_review_links" ADD CONSTRAINT "client_review_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_review_links_token_hash_idx" ON "client_review_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "client_review_links_org_item_created_idx" ON "client_review_links" USING btree ("org_id","content_item_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "client_review_links_one_live_per_item_idx" ON "client_review_links" USING btree ("org_id","content_item_id") WHERE "client_review_links"."revoked_at" IS NULL;
