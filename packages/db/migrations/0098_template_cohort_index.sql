-- Fresh installs build on an empty table. Existing installs build this online
-- through runMigrations before reaching this transaction.
CREATE INDEX IF NOT EXISTS "pipeline_runs_template_cohort_idx" ON "pipeline_runs" USING btree ("org_id","brand_id","created_at","id") WHERE "pipeline_runs"."template_snapshot" IS NOT NULL;
