import { runMigrations } from "@pubrick/db";

/**
 * Runs once, in the main vitest process, before any test file starts. See the matching
 * comment in apps/api/vitest.global-setup.ts: apps/api and apps/worker's e2e specs
 * target the SAME real TEST_DATABASE_URL, and turbo runs both packages' `test` tasks
 * concurrently — every process calling runMigrations() adds another bootstrap racing
 * the others for CPU and another (brief) queue on the migration advisory lock. One
 * barrier per package keeps that to two calls total instead of one per e2e file.
 */
export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  await runMigrations(url);
}
