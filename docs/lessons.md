# Lessons log

Append-only. When something bites us (agent or human), record it here:
date, what happened, root cause, rule to prevent it. Recurring entries get
promoted into CLAUDE.md ("Things Claude gets wrong") or a skill.

## 2026-08-29 — supertest owns the listener unless the suite does, and closes it mid-flight

`socket hang up` / `ECONNRESET` appeared in api e2e runs — rare, only in full
monorepo runs, in a different test each time. Root cause is in the harness, not
in any test: supertest's `Test` calls `app.listen(0)` when it finds the server
not listening and `server.close()` when THAT request ends (`supertest/lib/test.js`
`serverAddress` / `end`). Our specs only called `app.init()`, so every request
started and stopped the server — 125–339 listen/close cycles per file — and
whenever requests overlapped, the first to finish tore the listener down under
the others. Measured on the real app: 60 rounds of 8 concurrent `GET /api/health`
lost **259 of 480** requests to `ECONNRESET`; with `await app.listen(0)` in
`beforeAll`, **0 of 480**, and supertest never sets `_server` at all.
`runs.e2e.spec.ts`'s admission-cap test (`Promise.all` of 10 `POST /api/runs`) is
the suite's genuine concurrency, and instrumenting `http.Server.prototype.close`
caught it live: `server.close {connections: 9}`. Whether the losers die depends on
whether Node (≥19 destroys idle connections on `close()`) considers them idle at
that instant — hence rare, and load-dependent. Rule: an e2e suite that hands
`app.getHttpServer()` to supertest must `await app.listen(0)` in `beforeAll`; the
listener belongs to the file, never to one request.

## 2026-08-29 — an unchecked request in an e2e test reports the wrong bug later

`content.e2e.spec.ts`'s rescheduling test issued its FIRST `approve` with no
`.expect()`. That request is the test's premise (it is what makes the adaptation
`scheduled`), so a transient failure there did not fail the test — it changed
what the second approve did: with the adaptation still `pending` nothing is
cancelled and one job is enqueued, and the test died twenty lines later on
`expect(rows).toHaveLength(2)`. The symptom that reaches a reader is "a pg-boss
job disappeared", which sends them hunting a queue race that cannot happen: the
cancel and the re-enqueue share one transaction, so "cancelled with no
replacement" cannot survive a commit (verified by forcing the re-enqueue to be
suppressed — the cancel rolls back with it), and pg-boss maintenance only
deletes `state < 'active' AND keep_until < now()` (here: +48 h + 14 days) or
terminal jobs older than `deletion_seconds` (7 days). Rule: every HTTP call in
an e2e spec asserts its status — `.expect(...)` inline, or `expect(res.status)`
on the next line — and calls the test depends on for its SETUP also pin the
state they were supposed to produce. An unasserted request is not a cheap line;
it is a misdiagnosis waiting to happen.

## 2026-08-24 — turbo strict env mode silently strips undeclared env vars

Turborepo's strict env mode only passes through env vars a task explicitly
declares in `turbo.json`. The `test` task didn't declare `TEST_DATABASE_URL`,
so turbo stripped it before the db package's tests ran — the integration
test's `TEST_DATABASE_URL` guard read as unset and the test skipped itself.
CI stayed green the whole time because a skipped test still exits 0.
Root cause: any env-gated test whose variable isn't declared in the task's
`env` list will silently skip under turbo, with no warning. Rule: any new
env-gated test must declare its variable in `turbo.json`'s `test.env`.

## 2026-08-24 — biome's `useImportType` safe fix breaks NestJS constructor DI

`pnpm format` (`biome check --write`) rewrote a plain `import { BrandsRepository }`
into `import type { BrandsRepository }` in a Nest controller; with
`emitDecoratorMetadata: true` that elides the runtime value, so Nest's
`design:paramtypes` reflection has nothing to inject and app bootstrap fails
("Nest can't resolve dependencies..."). Rule disabled via `biome.json`
`overrides` scoped to `apps/api/src/**/*.ts` and `apps/worker/src/**/*.ts`
(the two Nest apps with `emitDecoratorMetadata` on) — never let biome
auto-fix touch import styles in those trees.

## 2026-08-24 — integration suites must be verified against a FRESH database

`pnpm test` was green locally and red on CI for anyone starting from an empty
volume: four api e2e specs run in separate vitest workers and each calls
`runMigrations()`, so on a database with nothing applied yet they raced on
`CREATE EXTENSION vector` / `CREATE SCHEMA drizzle` / the migrations table and
died with `duplicate key value violates unique constraint
"pg_extension_name_index"`. On a warm database every migration is a no-op, so
the race has no window and the suite passes — which is exactly why every
per-task verification during the plan missed it. Root cause: concurrent
migrators with no mutual exclusion (the same hazard as two api replicas booting
together in production). Fixed at the root with `pg_advisory_lock` around
`migrate()` in `packages/db/src/migrate.ts`. Rules: (1) any migration runner
must hold an advisory lock; (2) verify integration suites against a database
created moments ago, not the one left over from the last run — "it passed
locally" is not evidence until the DB was fresh.

## 2026-09-02 → 09-05 — a shared checkout turns parallel agents into a collision

Ten agents worked in `~/Projects/pubrick` at once over three days. Observed:
`git commit` in one agent swallowed another's staged hunks (recovered by
splitting, twice); a repo-wide `biome check --write` reformatted two files
another agent was mid-edit on; the shared `pubrick_test` database accumulated
~6 900 stale pg-boss jobs across tiers until the worker suite went red for
reasons unrelated to any change; one agent's migration was applied to the
shared database while another ran the api suite against it; `mutation-check`
read INCONCLUSIVE in every whole-package run under the load, so authors fell
back to narrowed runs. Root cause: one working tree and one database for N
writers. Rule: one agent per checkout; parallelism only across worktrees, each
with its own database; land by rebase; a verdict measured while another agent
was running is not a verdict.

## 2026-09-04 — a task that is not independently shippable leaves the gate red

Task 1 of the refine-verbs plan added a strict CHECK on `content_versions`;
Task 2 owned the fixture helper that writes the rows the CHECK refuses. The
plan listed them as separate tasks; dispatched alone, Task 1 broke six tests
in a file it was told not to touch, and the tree was red until Task 2 landed.
The implementer saw it and recorded it in the commit body for the next agent,
which is the right recovery — but the dispatcher should have caught it. Rule:
before dispatching, apply the task mentally and ask whether the gate is green
with only it. Two tasks that share a test file are one task.

## 2026-09-04 — a premise relayed into a prompt is a claim, not a fact

Three agents were sent to fix something that did not exist as described: a CI
failure attributed to `Connection terminated unexpectedly` (a mock error a test
throws on purpose; the real failure was a missing queue schema in a different
file); a deadlock attributed to two foreign keys (the two pre-locks were the
mechanism, and the FKs alone were safe); a classifier told that any HTTP status
means refusal (the SDK throws with status 200 on an unparseable body). Each
agent disproved the premise and did the right thing, at the cost of the time
to disprove it. Rule: every claim about code in a prompt is checked with one
read first, and a reviewer's finding is passed on as "the review claims", not
as established.

## 2026-09-04 — the one hand-written commit was the one with the hole

The orchestrator mounted a component into a page by hand, without a test, in
a pass whose whole subject was guards nobody had pinned. The verification round
found it: deleting the mount left the web suite green. Rule: the standard is
the same for the orchestrator as for the agents — no commit without the test
that dies on revert.

## 2026-09-04 — a guard's test that is wrong in two ways pins nothing

Twice in two days: the bot-token redaction's apparent test fed a URL, the one
shape both redaction passes strip, so either pass could be deleted alone; the
crypto envelope's version check was "tested" with an input whose key id was
also unknown, so the version was never examined. Rule: the property under test
must be the *only* thing wrong with the input, and the assertion must name the
guard's own refusal, not merely that it threw.

## 2026-09-05 — "restore with `git checkout`" wipes uncommitted work

A task brief told the implementer to restore each mutated file with
`git checkout -- <file>`. The task's own change was not yet committed, so the
first restore reverted the implementation together with the mutation; the
agent noticed only because the build hash came back identical to `main`. Rule:
mutations run against a *committed* tree — commit the task (or a WIP) first —
or restore from a `cp` backup taken after the change. The brief names which.

## 2026-09-05 — a scratch directory shared between agents forges verdicts

Two agents in different checkouts both wrote their mutation scripts to
`/tmp/muts`. One overwrote the other's mid-run; the mutation never applied and
the log recorded two SURVIVED verdicts for a mutation that had not happened.
It was caught because the script crashed visibly, not because the verdict
looked wrong. Rule: every agent's scratch lives in a directory named for its
task; a mutation log states the path it ran from.
