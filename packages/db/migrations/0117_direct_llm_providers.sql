ALTER TABLE "ai_credentials" DROP CONSTRAINT "ai_credentials_provider_check";--> statement-breakpoint
ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_ledger_provider_check";--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_provider_check" CHECK ("ai_credentials"."provider" in ('google', 'openrouter', 'openai', 'anthropic', 'deepseek')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_provider_check" CHECK ("usage_ledger"."provider" in ('google', 'openrouter', 'openai', 'anthropic', 'deepseek')) NOT VALID;