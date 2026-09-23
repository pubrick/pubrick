CREATE TABLE "memorable_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"month_day" text NOT NULL,
	"title" text NOT NULL,
	"lead_days" integer DEFAULT 14 NOT NULL,
	"suggested_content_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memorable_dates_month_day_check" CHECK (case when "memorable_dates"."month_day" ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then to_char(to_date('2000-' || "memorable_dates"."month_day", 'YYYY-MM-DD'), 'MM-DD') = "memorable_dates"."month_day" else false end),
	CONSTRAINT "memorable_dates_title_nonempty" CHECK (length(trim("memorable_dates"."title")) > 0),
	CONSTRAINT "memorable_dates_lead_days_range" CHECK ("memorable_dates"."lead_days" between 0 and 365)
);
--> statement-breakpoint
ALTER TABLE "memorable_dates" ADD CONSTRAINT "memorable_dates_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memorable_dates" ADD CONSTRAINT "memorable_dates_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memorable_dates_org_brand_day_idx" ON "memorable_dates" USING btree ("org_id","brand_id","month_day");