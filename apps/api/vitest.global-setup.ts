import { runMigrations } from "@pubrick/db";

/**
 * Runs once, in the main vitest process, before any test file starts — as opposed to
 * each of the six *.e2e.spec.ts files calling runMigrations() from its own beforeAll.
 *
 * That per-file pattern is what caused the "beforeAll hook timed out in 10000ms" flake:
 * every e2e file's beforeAll independently (a) dynamically imports "@pubrick/db" and
 * "./app.module" — real work (module evaluation of drizzle-orm/pg/the whole Nest app
 * graph), not a syscall — and (b) calls runMigrations(), which opens its own throwaway
 * pg.Pool and serialises on a pg_advisory_lock. With up to six of those bootstraps
 * racing for the CPU at once (vitest defaults to one worker per file, up to the core
 * count), step (a) alone was measured taking 3-4s under contention — vs low hundreds of
 * ms run alone — before any DB call even starts; runMigrations()'s advisory-lock queue
 * then stacked more delay on top. Six files paying both costs concurrently blew past the
 * 10s hook timeout on the majority of runs (measured: see docs/.../e2e-flake investigation
 * notes referenced from the fix commit).
 *
 * A single barrier here removes the redundant 6x import+migrate work and the lock queue
 * entirely — migrations are applied exactly once, before any spec file's beforeAll even
 * starts, so each file's own (now-removed) runMigrations() call was pure overhead.
 */
export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  await runMigrations(url);
}
