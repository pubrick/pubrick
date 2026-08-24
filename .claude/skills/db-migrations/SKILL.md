---
name: db-migrations
description: Use when changing the database schema in packages/db — Drizzle workflow, pgvector notes, and migration rules.
---

# DB migrations (Drizzle)

1. Edit the schema in `packages/db/src/schema/`.
2. Generate: `pnpm --filter @pubrick/db exec drizzle-kit generate` (SQL lands in `packages/db/migrations/`).
3. Review the generated SQL by hand before committing. Watch for: accidental
   drops on renames (use `generate --custom` + hand-written SQL for renames),
   HNSW indexes missing an operator class.
4. Migrations are applied programmatically on api boot (`runMigrations`).
   Never run them by hand in production; never edit an applied migration —
   write a new one.
5. Custom SQL (extensions, data fixes): `drizzle-kit generate --custom --name <slug>`.
6. `migrations/meta/` is generated state — never hand-edit (hook-blocked).
