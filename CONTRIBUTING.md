# Contributing

Humans and AI agents follow the same gates.

## Quality gates (all PRs)

`pnpm typecheck && pnpm lint && pnpm test` must pass. CI runs exactly these.

## Bug-fix protocol

1. Write a failing test that reproduces the bug. Commit it first.
2. Fix the bug without touching the test.
3. It is unacceptable to remove or weaken a test to make it pass.

## Commits

Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`), English only.

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
  `toBe`) pinning what the screen sends, and
  `expect(<schema>.safeParse(payload).success).toBe(true)` against the
  `@pubrick/shared` schema the API validates that endpoint with —
  `contentCreateSchema`, `contentApproveSchema`, `adaptationUpdateSchema`.
  The literal is written by hand and cannot notice a field being renamed
  server-side: without the schema line, a rename leaves every web test green
  and fails only in production. Fixtures use real UUIDs wherever a schema
  requires them, or the parse is vacuous.
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
