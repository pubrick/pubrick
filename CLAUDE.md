# CLAUDE.md

Pubrick — open-source AI content factory (AGPL-3.0). TypeScript monorepo:
pnpm + Turborepo. Everything — code, comments, commits, docs — is in English.

## Commands

- Install: `pnpm install`
- Build all: `pnpm build` (turbo; packages build before apps)
- Typecheck: `pnpm typecheck`
- Lint/format: `pnpm lint` / `pnpm format` (Biome; formatting is hook-enforced, don't hand-format)
- Test all: `pnpm test`; single package: `pnpm --filter @pubrick/db test`;
  single file: `pnpm --filter @pubrick/db exec vitest run src/migrate.test.ts --reporter=dot`
- DB integration tests need `TEST_DATABASE_URL` (any Postgres with pgvector, e.g. a throwaway docker container), plus `BETTER_AUTH_SECRET` and `APP_ENCRYPTION_KEY` (auth/crypto e2e specs); all three are declared in turbo.json's test env — declare any new env-gated test vars there too.
- Dev stack: `./init.sh` (starts postgres via docker, runs migrations, boots web+api+worker)

## Architecture

- `apps/web` — Next.js UI only (next-intl, EN source of truth + es/ru/pt).
  Note: `apps/web/CLAUDE.md` and `apps/web/AGENTS.md` are gitignored —
  reserved for Next 16's `next dev` agent-rules auto-generation
  (`node_modules/next/dist/server/lib/generate-agent-files.js`). Don't
  hand-author content there; web-specific rules for Claude live in this
  file, under "Testing apps/web" below.
- `apps/api` — NestJS: one module per domain; runs DB migrations on boot.
- `apps/worker` — NestJS standalone context: pg-boss consumers (jobs, cron). No HTTP.
- `packages/db` — Drizzle schema + SQL migrations (applied programmatically; never edit applied migrations).
- `packages/shared` — zod schemas, env parsing, types. No runtime deps beyond zod.
- Queue is pg-boss on Postgres. There is NO Redis; do not add one.

## Conventions

- TS strict; no `any` without a comment explaining why.
- Org scoping: every tenant-owned table carries `org_id NOT NULL`; all DB access
  goes through repositories whose every method takes `orgId` first (controllers
  never touch `db`, never inline SQL). Repositories select an explicit column
  allowlist, not `select()`. Org-scoped controllers use `ActiveOrgGuard` +
  `@OrgId()`. Channel credentials only via `encryptJson`/`decryptJson` — never
  returned by any endpoint.
- Enqueue jobs in the same transaction as the domain write.
- Publishing: a permanent platform error (bad credentials, content rejected by
  the platform, no adapter for the platform) is recorded on the adaptation and
  the job completes — it must never be rethrown, or pg-boss will retry a job
  that can never succeed. Only a transient error (rate limit, timeout, 5xx) is
  rethrown so pg-boss retries it; once a publish call has actually succeeded,
  the handler must never throw again, since a retry at that point would post a
  duplicate.
- Conventional commits. One logical change per commit.
- TypeScript stays on the 5.x line workspace-wide until tsup/NestJS fully support 7.x; one compiler version for the whole monorepo — never pin a different major in an individual package.

## Testing apps/web

- RTL. Most page tests mock `@/lib/api` at the module boundary
  (`vi.mock("@/lib/api", ...)` via `importOriginal` so the rest of the
  module's exports stay real). Two other boundaries are in use on purpose,
  and neither is a mistake to "fix": `brands/[id]/page.test.tsx` stubs global
  `fetch` and runs the REAL `api.ts`, which is what lets it assert the
  page's behaviour on a genuine `ApiError` (status classification,
  `noActiveOrg`) instead of one the test constructed; and the auth screens
  (`[locale]/page`, `onboarding/page`, `AuthForm`) mock `@/lib/auth-client`,
  since better-auth's client is the boundary there, not `api.ts`. Pick the
  boundary the screen actually talks to. `api.ts` itself is unit-tested
  directly against a stubbed `fetch` — never left uncovered because pages
  mock it away.
- Request bodies are pinned twice: a literal `toEqual`/`toBe` for what the
  screen sends, plus `<schema>.safeParse(payload).success` against the
  `@pubrick/shared` schema the API validates with (`contentCreateSchema`,
  `contentApproveSchema`, `adaptationUpdateSchema`). The literal alone can't
  see a server-side field rename — both stay green while production breaks.
  Fixtures therefore use real UUIDs where a schema demands them.
- `messages/*.json` key parity across `en`/`es`/`ru`/`pt` is enforced by
  `src/test/messages-parity.test.ts` (full dotted paths). Add a key to `en`
  only and three languages render the raw key path to users; the suite would
  otherwise stay green.
- Any page using `use(params)` (currently `content/[id]`, `brands/[id]`)
  MUST render with `renderAsync` (`src/test/render.tsx`), not `render`. The
  render call has to be inside the async `act()`; render-then-flush hangs
  in the Suspense fallback until timeout. Undocumented upstream — found by
  bisection, don't "simplify" it back.
- Assertions read the real `messages/en.json`; a renamed/removed key breaks
  a test on purpose.
- `PLATFORM_FIELDS` / `NON_SECRET_FIELDS` live in `@pubrick/shared` — don't
  re-export something from a page just to make it importable for a test.
- `proxy.ts` keeps an inline `config.matcher` literal (Turbopack rejects an
  imported identifier or local variable there); `proxy-matcher.ts` holds
  the same array plus a type used to annotate `proxy.ts`'s literal, so the
  two can't silently diverge — a mismatch fails `tsc`/`next build`, not
  `vitest`. `proxy.test.ts` imports `proxy-matcher.ts` directly rather than
  executing `proxy.ts` (which pulls in next-intl's middleware and crashes
  under vitest's ESM resolver).
- The suite runs with ZERO `act()` warnings — if you see one, it is a signal,
  not background noise. `src/test/render.tsx` imports `act` from
  `@testing-library/react` (RTL's wrapper sets `IS_REACT_ACT_ENVIRONMENT`);
  importing it from `react` instead brings back ~50 "environment is not
  configured to support act(...)" lines. Keep assertions on async data going
  through `findBy*`/`waitFor`, never a synchronous `getBy*`.
- `layout.tsx` and `i18n/*` are deliberately untested (server component
  unsupported by Vitest; i18n config is declaration-only).

## Verifying your work

Before reporting any task complete: run `pnpm typecheck && pnpm lint && pnpm test`
and paste the tail of the output. Failing tests are reported as failing —
never edit or delete a failing test to make it pass (see CONTRIBUTING.md
bug-fix protocol).

## Things Claude gets wrong

(grown from repeated mistakes — add an entry when a correction happens twice)

## Compact instructions

When compacting, always preserve: the list of modified files, the task being
executed and its remaining steps, and the exact test commands being used.
