CREATE TABLE "hosted_account_creation_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosted_invitation_acceptances" (
	"invitation_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hosted_account_creation_claims" ADD CONSTRAINT "hosted_account_creation_claims_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_invitation_acceptances" ADD CONSTRAINT "hosted_invitation_acceptances_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_invitation_acceptances" ADD CONSTRAINT "hosted_invitation_acceptances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hosted_account_creation_user_time_idx" ON "hosted_account_creation_claims" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "hosted_account_creation_time_idx" ON "hosted_account_creation_claims" USING btree ("created_at");