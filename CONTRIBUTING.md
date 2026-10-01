# Contributing

Humans and AI agents follow the same gates.

## Choose and discuss work

See the [development roadmap](docs/roadmap.md) and
[open issues](https://github.com/pubrick/pubrick/issues). For a substantial feature,
explain the user problem, proposed scope, and acceptance criteria before coding.
Report bugs with the revision, installation mode, reproduction steps, and
sanitized logs. Use synthetic data; do not include API keys, proxy passwords,
session cookies, customer content, or `.env` files.

Security vulnerabilities use the [private reporting process](SECURITY.md).
Document visible behavior and limitations in English, and update the relevant
user guide when a change affects setup, recovery, or a workflow.

## Quality gates (all PRs)

`pnpm typecheck && pnpm lint && pnpm test` must pass. CI also builds the complete
workspace and runs the database test tier without cached results. Bootstrap
script tests run locally through `pnpm test` and as a separate CI step.

Develop in coherent, reviewable slices. During a slice, run focused checks for
the code being changed. After the slice is integrated, run the full local gate
once and review the combined diff once before opening a PR. A small follow-up
fix needs the affected checks; repeat the full gate only if the fix changes a
shared contract or leaves a concrete integration risk. Let one CI run verify
the final PR head instead of pushing every intermediate commit to trigger CI.

### Native database checks

Set `TEST_DATABASE_URL` to a disposable PostgreSQL 16 database. Billing
persistence also requires a separate `BILLING_TEST_DATABASE_URL` and
`PUBRICK_BILLING_DISPOSABLE=1`. Without these settings, a passing unit run does
not establish database acceptance. Use synthetic `BETTER_AUTH_SECRET` and
`APP_ENCRYPTION_KEY` values; the test database role must be able to create and
drop its owned fixture databases. Run the workspace test tier without cached
results and with one package and test worker at a time on a shared machine:

```sh
pnpm test --force --concurrency=1 -- --maxWorkers=1
```

The migration matrix clones and upgrades every historical schema. Docker
Desktop volume I/O can exceed its existing timeout even when individual
upgrades pass. For that disposable fixture, a PostgreSQL container with
`--tmpfs /var/lib/postgresql/data:rw,size=512m` avoids repeated disk flushes.
Keep the full matrix, assertions and time limits unchanged; record the server
version and fixture storage with the result. The tmpfs data is temporary and
disappears when its test container is removed.

## Production browser journeys

[Browser testing](docs/browser-testing.md) runs a disposable PostgreSQL instance
and the compiled API/Next standalone application. It refuses occupied dedicated
ports and never reuses a developer's live stack. Run it locally for changes to
authentication, rewrites, workspace navigation, or release packaging. This tier
is kept out of routine CI until its cost and stability justify adding it.

Run heavyweight builds and integration gates sequentially on a shared host;
parallel checkouts isolate files/databases, but not available CPU and memory.
Use focused TypeScript checks before booting a full browser stack so fixture
errors do not require another cold production build.

## Bug-fix protocol

1. Write a failing test that reproduces the bug. Commit it first.
2. Fix the bug without touching the test.
3. It is unacceptable to remove or weaken a test to make it pass.

## Commits

Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`), English only.

## Lock order

Row locks across `brands`, `adaptations`, `channels` and `content_items` are
taken in that order, product-wide. Before adding a lock — including the ones you
do not write, like a foreign key's `FOR KEY SHARE` on an insert or a cascading
delete's — read `docs/lock-order.md` and add yours to it. Two deadlocks got in
because each side documented its order against a different counterparty; a lock
order cannot be stated correctly in a comment that can only see one side.

## Migrations

Never edit an applied migration. See `.claude/skills/db-migrations/SKILL.md`.

## Testing `apps/web`

- React Testing Library. Most page tests mock `@/lib/api` at the module
  boundary (`vi.mock("@/lib/api", ...)`, keeping the rest of the module's
  exports intact via `importOriginal`). That is the common case, not a
  universal rule — two other boundaries are deliberate:
  - `brands/[id]/page.test.tsx` stubs global `fetch` and exercises the REAL
    `api.ts`. That is what lets it drive the page with a genuine `ApiError`
    built by the real status classification (including the `noActiveOrg`
    403), rather than one the test hand-constructed. Don't rewrite it into
    a module mock — that would be the weaker test.
  - The auth screens (`[locale]/page.test.tsx`,
    `onboarding/page.test.tsx`, `components/AuthForm.test.tsx`) mock
    `@/lib/auth-client`, because better-auth's client — not `api.ts` — is
    the boundary those screens talk to.

  Pick the boundary the screen under test actually depends on. `api.ts`
  itself is unit-tested separately against a stubbed global `fetch`, so
  mocking it away in page tests never leaves its own logic (error
  classification, `ApiError` construction) uncovered.
- A request body gets **two** assertions: the literal one (`toEqual` /
  `toBe`) pinning what the screen sends, and a parse against the
  `@pubrick/shared` schema the API validates that endpoint with —
  `contentCreateSchema`, `contentApproveSchema`, `adaptationUpdateSchema`.
  The literal is written by hand and cannot notice a field being renamed
  server-side: without the schema line, a rename leaves every web test green
  and fails only in production. Fixtures use real UUIDs wherever a schema
  requires them, or the parse is vacuous. Two things to get right:
  - `expect(schema.safeParse(payload).success).toBe(true)` is enough only
    when the schema has a **required** field, which is what a rename then
    breaks. For a schema whose fields are all optional —
    `contentApproveSchema` is one — assert the round trip instead:
    `expect(schema.parse(payload)).toEqual(payload)`. `z.object()` strips
    unknown keys, so after a rename `{scheduledAt: "…"}` still parses
    successfully, just into `{}`; only comparing the parse result back
    against the payload notices the field vanished.
  - **The schema assertion reads `packages/shared/dist`, not `src`.** Turbo's
    `test` task declares `dependsOn: ["^build"]`, so the root `pnpm test` and
    CI always parse against a freshly built schema. A bare
    `pnpm --filter @pubrick/web test` does not: it validates against whatever
    `dist` happens to hold, so a schema change you just made in `src` is
    invisible and the suite stays green. Run `pnpm --filter @pubrick/shared
    build` first, or use the root `pnpm test`, whenever a schema is in play.
- Message-file key parity across `en`/`es`/`ru`/`pt` is enforced by
  `src/test/messages-parity.test.ts`, comparing full dotted key paths. Adding
  a key to `en.json` alone would ship as the raw key path rendered on screen
  in three languages, with nothing else in the suite objecting.
- Any page that calls `use(params)` (a Suspense-triggering read) — currently
  `content/[id]` and `brands/[id]` — must be rendered with `renderAsync`
  from `src/test/render.tsx`, not the plain `render`. The render call has to
  happen *inside* the async `act()`; rendering first and flushing after
  does not work — the component stays stuck in the Suspense fallback until
  the test times out. This is undocumented upstream (found by bisection),
  so don't "simplify" a `renderAsync` call back to `render` without
  re-reading `src/test/render.tsx`'s comment.
- Assertions read the real `messages/en.json` rather than a hand-rolled
  fixture, so renaming or removing a translation key breaks a test. That's
  deliberate — a key rename should fail in CI, not ship as missing text a
  user reports later.
- The suite runs clean: **zero** `act()` warnings. `src/test/render.tsx`
  imports `act` from `@testing-library/react`, not from `react` — RTL's
  re-export is the wrapper that sets `IS_REACT_ACT_ENVIRONMENT` around the
  callback, and importing straight from `react` makes React print "The
  current testing environment is not configured to support act(...)" for
  every flush (~50 lines). If you see act warnings, something regressed;
  don't treat them as an inherent cost of testing Suspense. Keep every
  assertion on asynchronously loaded data going through `findBy*` /
  `waitFor` rather than a synchronous `getBy*` — an act warning from a
  `getBy*` on async data is a real signal, not noise.
