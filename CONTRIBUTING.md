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
