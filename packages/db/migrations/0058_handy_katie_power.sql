CREATE TABLE "telegram_login_attempts" (
	"org_id" text PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"phone_encrypted" text NOT NULL,
	"session_encrypted" text,
	"phone_code_hash_encrypted" text,
	"stage" text DEFAULT 'begin' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts_used" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_begin_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_login_attempts_stage_check" CHECK ("telegram_login_attempts"."stage" in ('begin', 'code', 'password', 'verifying_code', 'verifying_password', 'failed', 'complete')),
	CONSTRAINT "telegram_login_attempts_attempts_check" CHECK ("telegram_login_attempts"."attempts_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "telegram_login_attempts" ADD CONSTRAINT "telegram_login_attempts_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_login_attempts" ADD CONSTRAINT "telegram_login_attempts_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_login_attempts_id_idx" ON "telegram_login_attempts" USING btree ("id");--> statement-breakpoint
CREATE INDEX "telegram_login_attempts_expires_idx" ON "telegram_login_attempts" USING btree ("expires_at");