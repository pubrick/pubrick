CREATE INDEX IF NOT EXISTS "usage_ledger_org_recent_idx" ON "usage_ledger" USING btree ("org_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
