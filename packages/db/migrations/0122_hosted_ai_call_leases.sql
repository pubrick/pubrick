CREATE TABLE "hosted_ai_call_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_deadline_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosted_ai_call_kind_check" CHECK ("hosted_ai_call_leases"."kind" in ('text', 'image', 'embedding', 'probe')),
	CONSTRAINT "hosted_ai_call_deadline_check" CHECK ("hosted_ai_call_leases"."dispatch_deadline_at" > "hosted_ai_call_leases"."created_at" and "hosted_ai_call_leases"."lease_expires_at" = "hosted_ai_call_leases"."dispatch_deadline_at" + interval '60 seconds')
);
--> statement-breakpoint
ALTER TABLE "hosted_ai_call_leases" ADD CONSTRAINT "hosted_ai_call_leases_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hosted_ai_call_org_expiry_idx" ON "hosted_ai_call_leases" USING btree ("org_id","lease_expires_at");--> statement-breakpoint
CREATE INDEX "hosted_ai_call_org_kind_expiry_idx" ON "hosted_ai_call_leases" USING btree ("org_id","kind","lease_expires_at");