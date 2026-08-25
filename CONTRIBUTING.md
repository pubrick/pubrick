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

- React Testing Library, with `@/lib/api` mocked at the module boundary
  (`vi.mock("@/lib/api", ...)`, keeping the rest of the module's exports
  intact via `importOriginal`). `api.ts` itself is unit-tested separately
  against a stubbed global `fetch`, so mocking it away in page tests never
  leaves its own logic (error classification, `ApiError` construction)
  uncovered.
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
- Known-benign `act()` warnings can show up from `use(params)`'s internal
  suspended-root ping and from fire-and-forget refetches. They're cosmetic
  here specifically because every assertion goes through `findBy*` /
  `waitFor` rather than a synchronous `getBy*` — don't chase them, and
  don't assume every act warning in this app is automatically safe; if a
  test starts using `getBy*` on data that loads asynchronously, an act
  warning there is a real signal, not noise.
