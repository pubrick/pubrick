ALTER TABLE "organization_api_keys" DROP CONSTRAINT "organization_api_keys_scope_check";--> statement-breakpoint
-- Existing keys already satisfy the wider set; enforce new writes without a table scan.
ALTER TABLE "organization_api_keys" ADD CONSTRAINT "organization_api_keys_scope_check" CHECK ("organization_api_keys"."scope" in ('content:read', 'publications:read')) NOT VALID;
