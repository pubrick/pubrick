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
- Proving a guard is pinned (break the line, watch the suite go red): never from ONE run — `node scripts/mutation-check.mjs @pubrick/api --runs 3` reports a verdict only when every run agreed. See `docs/mutation-testing.md`, including what a unanimous verdict does not prove and the isolation rules a new database-backed test has to earn.
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
- `packages/shared` — the rule book: zod DTOs and the closed status/error lists, the provenance and refine-merge rules, credential crypto and the key ring, the ledger's cost buckets, the queue contract. No runtime deps beyond zod; the web imports it in the browser. Map: `docs/architecture.md`.
- Queue is pg-boss on Postgres. There is NO Redis; do not add one.

## UX constitution

Every screen shares one design direction (`app/globals.css` + `components/ui/*`). New UI must keep these rules:
- **One place** — a setting/action lives at exactly one fixed location, never duplicated: Settings pins to the sidebar bottom (mobile: rightmost tab), with the user/workspace block under it (mobile: inside Settings); the one primary action is a top-right brick-colored button (mobile: round button beside the title) — on forms that means top-right in the toolbar, NEVER a submit/save button at the bottom of the form, and never two primary buttons on one screen; search sits immediately left of the primary action.
- **Advanced-only disclosure** — extra options hide behind the shared `Advanced` component, never a bespoke "show more".
- **One verb, one word** — a recurring action keeps one fixed one-word verb everywhere (Add, Remove, Approve, Test), never rotating synonyms.
- **Five statuses** — `StatusBadge`'s five colors are the only status colors that exist; no screen invents a sixth.
- **Empty states teach** — an empty list names the one next action via `EmptyState`, never a bare "no results".
- **No dead nav** — every `AppShell` nav entry points at a real, working screen.

Pattern reference for new features: `docs/ux-patterns.md`.

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
- Prefer a maintained library to hand-rolled code when one fits (owner's
  standing rule, 2026-09-05). Before writing a parser, a sanitiser, a retry
  loop, a diff, a date/URL/HTML helper, a sentence splitter, a rate limiter or
  a queue, check what the workspace already depends on (`pnpm why`, the
  lockfile) and what the ecosystem has; add a dependency when it is
  maintained, licence-compatible with AGPL, and smaller than the code it
  replaces. Say in the commit which library was chosen and which alternative
  was rejected. Hand-rolling is right only where the rule book
  (`packages/shared`) must own the exact semantics — provenance, the closed
  status lists, the crypto envelope — and the commit says so.
- TypeScript stays on the 5.x line workspace-wide until tsup/NestJS fully support 7.x; one compiler version for the whole monorepo — never pin a different major in an individual package.

## Generation (`packages/ai`, `apps/worker/src/generate`)

- **Ledger before checkpoint.** Every *physical* model call writes its
  `usage_ledger` row in its own transaction, before the step's checkpoint: a run
  that dies mid-step has still spent the org's money, and a ledger that records
  only finished steps under-reports every failure. Metering hooks
  `executeLanguageModelCall`, passed per call as `telemetry: { integrations }` —
  never `registerTelemetry` (global, no unregister, leaks between test files),
  and never `onLanguageModelCallEnd`, which fires *after* the SDK's retry loop:
  once per step, and not at all when every attempt failed.
- **Every model call runs under the run's fence.** Re-take it immediately before
  the call (`beginStep`), never only after — a handler that checks at the end has
  already spent the money it had lost the right to spend. The token is
  `<jobId>#<per-delivery nonce>`, because pg-boss deletes and re-inserts a
  retried job under the *same* id, so `active_job_id = jobId` would admit a retry
  alongside a live handler and fence nothing. The claim matches the job half
  (`split_part`), is guarded on `status in ('queued','running')`, and every write
  a HANDLER makes while it believes it owns the run — each checkpoint and the
  terminal write — carries `status = 'running' AND active_job_id = $fence`.
  The claim also writes `lease_expires_at`, and every fenced write renews it; the
  lease length is `GENERATE_QUEUE_OPTIONS.expireInSeconds`, read from that
  constant rather than restated, so the run goes stale at the same moment pg-boss
  is willing to re-dispatch it.
  Writes made by code that is NOT a handler are deliberately UNFENCED, and
  fencing them would be a bug rather than a tightening: `markExhausted` (the DLQ
  consumer), `RunsRepository.cancel`/`dismiss`, and the queued-run failure
  `AiCredentialsRepository.delete` writes all act precisely when the handler that
  held the fence is gone, or when the user is overruling it. A fenced
  `markExhausted` would match no row and leave every exhausted run at `running`
  forever with no job left to move it — the silent stall the queue strip exists
  to prevent. Each is scoped by `org_id` and by the statuses it is allowed to
  move (`markExhausted`: `queued | running`; `delete`: `queued`), never by
  `active_job_id`.
- **Failure policy mirrors publishing, and costs more here.** A permanent
  generation error is recorded on the run and the handler returns normally
  (completing the job); only a transient one is rethrown for pg-boss, which
  resumes from the last checkpoint. Each pointless retry is another paid call.
  Losing the fence, being cancelled, and finding the run row gone (a deleted
  brand cascades) are all ordinary outcomes: log and return, never throw.
- **The publish promise is enforced server-side.** `ContentRepository` refuses
  approval of an `ai` item that nobody opened and nobody touched — body *and*
  every adaptation judged with `allSentencesAi` against that level's `ai`
  `content_versions` rows, missing **or partial** evidence refusing (a level
  whose only rows are fragments has no countable reference and refuses too, and
  so does one holding a `fragment` row that cannot say what it replaced).
  Never move this check into
  the UI, and never weaken it to the master body alone: `adaptations.body ??
  contentItems.body` is what actually ships. `first_opened_at` is stamped only by
  `POST /api/content/:id/opened`, never as a side effect of a GET (the public API
  and the MCP server would trip it), and the run screen must not auto-forward to
  the finished draft — that would satisfy the read signal with no human present.
- **One provenance question, two references.** The question is "is every
  sentence of this text still one the model wrote", and it is asked at two
  grains — never as separate rules that could answer differently on one screen:
  - **whole text** — the gate ("may this be approved?") and the origin badge
    ("AI-drafted or Human-edited?"): `allSentencesAi(current, aiRows,
    firstFullRow)` (`@pubrick/shared`), over **all** of that level's `ai` rows
    for the mask, plus — for the deletion clause — the level's **first
    `scope = 'full'`** row as the anchor **and the sum of every `fragment`
    row's `unit_delta`**. Run by `ContentRepository` in
    `requireHumanInvolvement`, in `get` and in `list`, and delivered to the web
    as the boolean `bodyIsAiVerbatim` on **both** `GET /api/content/:id` and the
    LIST rows, so a queue card shows the same badge as the screen it opens. Ship
    the verdict, never the version text: a badge has no use for the bodies, and
    a list that carried them would be shipping every version of every item to
    draw four words;
  - **per sentence** — the lens, which sentences dim — **all** `ai` rows:
    `aiSentenceMaskAny`, an index-wise OR of one `aiSentenceMask` per version.
    `allSentencesAi` reads this same mask, so the two cannot drift.

  There used to be a third reference — "does the body equal ANY `ai` row"
  (`matchesAnyAiVersion`, deleted). A refine's fragment can never EQUAL a whole
  body, so that formula captions the model's own words "Human-edited" the first
  time a proposal is accepted. If you find yourself adding a reference, you are
  about to ship a screen that answers one question twice.

  **The count is against the anchor PLUS what the fragments changed, and the
  fragments' half is stored, never recomputed.** A refine replaces units, so a
  successful *shorten* — two of the model's sentences returned as one — leaves
  the body a unit short of the anchor: counted against the anchor alone that is
  a human deletion, and the gate opens on an unread draft while the badge
  captions the model's own words "Human-edited". Each `fragment` row therefore
  carries `unit_delta`, the signed `n(merged) − n(pre-merge)`, written **once,
  at Accept, by `planRefineAccept`** and never re-derived from the fragment's
  text at read time. A `fragment` whose `unit_delta` is null is *missing*
  evidence, not a zero, and refuses. This composes only while a level has **at
  most one `ai` `full` row** — a second makes the anchor and the deltas describe
  different bodies, and it fails unsafe; nothing writes one today, and 2c's
  re-adaptation owns that decision.

  **Equality with the anchor answers first, and it is not an optimisation.** A
  human deletion is permanent in that sum — nothing subtracts it back out — so a
  later refine that RESTORES the deleted sentence pushes the expectation up
  instead: the body is the model's draft character for character while the count
  says a unit is owed, and the count alone captions the model's own words
  "Human-edited" and opens the gate. `allSentencesAi` therefore answers `true`
  when `current` IS the anchor's text (newlines canonicalised) before it counts
  anything. It is also the invariant this formula owes the whole-body equality
  it replaced — never laxer than that rule was — which had held only while no
  fragment was in play. Byte-identity, and the ANCHOR rather than any `full`
  row: the narrowest closure, and 2c still owns what a second `full` row means.

  Three traps, all silent. **`aiRows[0]` is not the first `full` row** — a
  fragment can sort first, and counting against a one-sentence fragment makes
  the deletion clause a no-op, so every deletion reads as untouched AI; any
  query feeding this must order by `created_at, id` and select `scope` **and
  `unit_delta`** — the two are read together or not at all, because `scope`
  without the delta is exactly the shape that reads a shorten as a deletion.
  **Pass the ROWS, never `rows.map((r) => r.body)`** — a bare body is read as a
  `full` row (which is what the browser's `aiVersionBodies` holds, and all it
  can hold), so flattening rows that include a fragment silently restores the
  old, unsafe clause. And while a level has exactly one `full` row and no
  fragments — every row on live data today — every wrong choice here coincides
  with the right one, so it looks right in each test you would think to write.

  **The badge and the lens can disagree on one screen, honestly.** The whole-text
  grain knows what is no longer there: delete a sentence and every sentence left
  is dimmed while the badge reads "Human-edited". The lens legend says so; do not
  "fix" it by making the badge ignore deletions.
- **Never mask against a concatenation of versions.** `aiSentenceMask` consumes
  each AI sentence at most once on purpose — a human's second copy of a sentence
  the AI wrote once stays human — and joining the versions destroys that count,
  dimming the human's own duplicate. That is why the multi-version helper is
  `aiSentenceMaskAny(current, versions)`, OR-ing per-version masks so each keeps
  its own multiset; replacing it with `aiSentenceMask(current, versions.join())`
  is a silent provenance inversion, not a simplification. The whole-text grain
  cannot take a joined reference either: `allSentencesAi` masks through that same
  helper, and its deletion clause counts against ONE row — the first `full` one,
  moved by the fragments' deltas — so joining the versions would measure the text
  against every version at once and read every AI draft as human-edited.
- **Pair spans with flags only through `dimSpans`.** The partition and the mask
  do not index-align — `splitSentences` drops blank pieces, so
  `"\n\nHello. World."` is three spans and two sentences, and zipping the mask on
  by index dims the blank line and never dims the last sentence. Silent, and
  plausible enough to survive review. `dimSpans(current, aiVersions)` decides
  that alignment once, in `@pubrick/shared` (a blank span consumes no flag and is
  never dimmed, "blank" being the module's own whitespace class, which includes
  U+200B). No consumer may re-zip `aiSentenceMaskAny` onto `splitSentenceSpans`
  itself.
- **`splitSentenceSpans` is a lossless partition, and anything rendering text
  beside a textarea must render from it.** Every character of the input belongs
  to exactly one span — separators included, each attached to the span it ends —
  so the spans rejoin into the input character for character; `splitSentences` is
  the trimmed, blank-dropping view derived from it, never a second splitter.
  `DimmedTextarea`'s overlay renders `text.slice(start, end)` per span for that
  reason: a dropped space or newline moves the overlay's wrap points and slides
  every highlight off the words it describes. jsdom has no layout, so the tests
  can prove the character-identity of overlay and value but not the alignment —
  which is exactly why the lossless property is the thing to protect. Those
  offsets are recomputed from the current text on every render and never
  persisted; a stored offset rots on the first edit, a derived one is a loop
  index.
- **A body's newlines are U+000A, and that is settled at the DTO.** A
  `<textarea>` strips CR from its API value while a React string keeps it, so a
  stored CR makes the overlay render more characters than the field holds —
  highlights slide, the counter reports a length no deleting can reach, and the
  first keystroke anywhere rewrites every CR out of the document through
  `onChange`. `contentCreateSchema`, `contentUpdateSchema` and
  `adaptationUpdateSchema` pipe their `body` through `normalizeNewlines`
  (`@pubrick/shared`) — normalise first, bound by `MAX_BODY_LENGTH` second, so
  the limit measures what is stored. Any new body-bearing DTO does the same;
  `DimmedTextarea` normalises again on the way to the screen for text that
  arrived by another road, and that belt is not a substitute for the boundary.
- **The fact-checker verifies nothing** until increment 3 gives it sources: it
  lists claims. No instruction, schema, endpoint or UI string may suggest a check
  happened. `CLAIMS_TO_VERIFY_LABEL` (`@pubrick/shared`, re-exported by
  `@pubrick/ai`) is the phrase: the step's own prompt interpolates it, and the
  English label `Runs.step.factcheck` is pinned to it — case-insensitively — by
  `apps/web/src/test/factcheck-label.test.ts`. `es`/`ru`/`pt` are translations of
  that label and cannot be pinned by equality; the same test holds them to the
  half that matters, that none of them reads as a past participle ("verified
  claims").
- **Untrusted text never reaches `instructions`.** The brief, earlier steps'
  output, and (increment 3) fetched article text are nonce-fenced material in
  `prompt`; only org configuration and this package's step rules are
  instructions. Define steps with `defineStep` — it is what keeps that boundary,
  the schema sent to the model, and the ledger attribution from drifting apart.
- **No test may call a provider.** Use `MockLanguageModelV4` from `ai/test`
  (its `doGenerate` must return TEXT content, or the `Output.object` path throws
  `NoOutputGeneratedError`) or the worker's `test/scripted-model`; the single
  method that reaches a provider (`AiCredentialProbe.call`) is overridden in the
  probe's own spec, so the classification around it stays real.

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
- **A refusal must reach the reader in the reader's language.** Anything a
  screen shows for a failed request goes through `errorMessage(err, fallback,
  t)`, and the third argument — `useTranslations("Errors")` — is REQUIRED, so
  forgetting it is a build failure rather than a screen that quietly shows the
  api's English. Passing it is not the same as using it: prove the refusal on
  each rendered error site, driven by a real HTTP body built with `refusalBody`
  and rendered in a non-English locale (`render`/`renderAsync` take
  `{ locale }`). `src/app/[locale]/refusals.test.tsx` is where those live, and
  why — a screen with two error sites has two calls, and a mutation drops one
  at a time.
- Request bodies are pinned twice: a literal `toEqual`/`toBe` for what the
  screen sends, plus a parse against the `@pubrick/shared` schema the API
  validates with (`contentCreateSchema`, `contentApproveSchema`,
  `adaptationUpdateSchema`). The literal alone can't see a server-side field
  rename — both stay green while production breaks. Fixtures therefore use
  real UUIDs where a schema demands them.
  - Where every field of a schema is optional (`contentApproveSchema`), assert
    the ROUND TRIP — `expect(schema.parse(body)).toEqual(body)` — not
    `safeParse(...).success`. `z.object()` strips unknown keys, so a renamed
    optional field parses happily and silently yields `{}`; only comparing the
    result back to the payload catches it.
  - ⚠ This only bites after `@pubrick/shared` is rebuilt: web resolves the
    package from `dist`, not `src`. `pnpm test` and CI are fine (turbo's
    `test` task `dependsOn: ["^build"]`), but a bare
    `pnpm --filter @pubrick/web test` against a stale `dist` validates the
    OLD schema and stays green through a rename. Rebuild shared, or run the
    root `pnpm test`, before trusting a schema assertion.
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
bug-fix protocol). If you run `apps/web`'s vitest directly instead of via
`pnpm test` (e.g. `pnpm exec vitest run`, or a single-file invocation), you
MUST prefix it with `NODE_OPTIONS=--no-experimental-webstorage` — only the
package's own `test` script sets that, and without it 8 tests fail on Node ≥24.

## Things Claude gets wrong

(grown from repeated mistakes — add an entry when a correction happens twice)

- **Running several agents in one checkout.** Every batch of parallel agents in
  the shared tree has cost something: a commit that swallowed another agent's
  staged files; a repo-wide formatter rewriting a file mid-edit; the shared test
  database polluted by one agent's migration while another ran the suite;
  mutation verdicts reading INCONCLUSIVE from load rather than from code. **Rule:
  one agent per checkout.** Parallel work runs in separate `git worktree`s, each
  with its own database, and lands by rebase. If two tasks must share files,
  they are one task.
- **Launching a task whose predecessor has not landed.** A migration shipped
  ahead of the fixture that feeds it and left the gate red for an hour. **Rule:**
  before dispatching a task, ask whether the gate is green with *only* this task
  applied. If the plan says two tasks are independent and they touch the same
  test file, the plan is wrong.
- **Relaying a claim as a premise without checking it.** Agents were sent to fix
  "a connection drop in CI" (a deliberately thrown mock error), "two foreign keys
  closing a lock cycle" (the pre-locks, not the keys), "any HTTP status is a
  refusal" (the SDK throws with status 200), and model ids that do not exist.
  Each cost the agent time to disprove. **Rule:** a claim about the code goes
  through one grep or read before it goes into a prompt. A claim from a reviewer
  is a claim, not a fact.
- **Committing without a test, because the change was "just a mount".** The one
  hand-written commit in the hardening pass was the one with a Critical finding:
  deleting the line it added left every test green. **Rule:** no commit without
  the test that dies when the change is reverted — including the orchestrator's
  own.
- **Writing the plan fast and reviewing it after.** Implementers found seven
  errors in one plan; a spec review found eight criticals in another. **Rule:**
  a spec gets its adversarial review before a plan is written from it; a plan
  gets a fresh read for hidden dependencies before its first task is
  dispatched. Both are cheaper than the third fix-up wave.
- **Trusting an author's mutation log.** Fifteen guards reported pinned by their
  authors were not. **Rule:** a task is done when a *different* agent has
  re-run the mutations and read the tests for the "wrong cause" shape — a
  guard's test input must be wrong in exactly one way.
- **`rm -rf` on a directory in a repository.** Twice, tracked files went with
  the scratch. **Rule:** `git status` first; `git clean -n` before any deletion
  wider than a file you created.
- **An agent ending its turn on a background wait.** Dozens of "Waiting…"
  wake-ups, each a full model turn. **Rule:** verification runs in the
  foreground with a timeout; a background process is for something the agent
  does not need to act on.
- **Not writing the lesson down.** `docs/lessons.md` has no entry for the three
  days in which every one of the above repeated. **Rule:** a correction that
  happens twice is written into this section the same day, not at the end.

## Compact instructions

When compacting, always preserve: the list of modified files, the task being
executed and its remaining steps, and the exact test commands being used.
