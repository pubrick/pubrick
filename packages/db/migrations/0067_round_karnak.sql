CREATE TABLE "publication_comment_analyses" (
	"publication_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"sample_checked_at" timestamp with time zone NOT NULL,
	"sample_size" integer NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_comment_analyses_sample_size_check" CHECK ("publication_comment_analyses"."sample_size" BETWEEN 1 AND 30)
);
--> statement-breakpoint
ALTER TABLE "publication_comment_analyses" ADD CONSTRAINT "publication_comment_analyses_sample_scope_fk" FOREIGN KEY ("org_id","brand_id","publication_id") REFERENCES "public"."publication_comment_samples"("org_id","brand_id","publication_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_comment_analyses_org_brand_idx" ON "publication_comment_analyses" USING btree ("org_id","brand_id");