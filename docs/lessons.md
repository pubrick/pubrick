# Lessons log

Append-only. When something bites us (agent or human), record it here:
date, what happened, root cause, rule to prevent it. Recurring entries get
promoted into CLAUDE.md ("Things Claude gets wrong") or a skill.

## 2026-08-24 — turbo strict env mode silently strips undeclared env vars

Turborepo's strict env mode only passes through env vars a task explicitly
declares in `turbo.json`. The `test` task didn't declare `TEST_DATABASE_URL`,
so turbo stripped it before the db package's tests ran — the integration
test's `TEST_DATABASE_URL` guard read as unset and the test skipped itself.
CI stayed green the whole time because a skipped test still exits 0.
Root cause: any env-gated test whose variable isn't declared in the task's
`env` list will silently skip under turbo, with no warning. Rule: any new
env-gated test must declare its variable in `turbo.json`'s `test.env`.
