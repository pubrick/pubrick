# Production browser journeys

The opt-in Playwright tier runs against a **built** Next.js application and the
compiled NestJS API, with real authentication cookies, PostgreSQL migrations,
and the same-origin `/api` rewrite. It is separate from Vitest component tests
and is not part of CI by default (issue #14).

## Run locally

Requirements: Node.js 22.12 or newer, the pinned pnpm version, Docker, and enough
free disk space for the Chromium download and a workspace production build.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm exec tsc --noEmit -p scripts/e2e
node scripts/e2e/run.mjs
```

On Linux, install Playwright's browser system dependencies as documented by
[Playwright](https://playwright.dev/docs/browsers#install-system-dependencies).

The runner creates a uniquely named `pubrick-browser-*` PostgreSQL container
with an automatically allocated loopback port, a temporary media directory,
fresh encryption/authentication secrets, and dedicated loopback ports (web 31300, API 31301). It refuses occupied
ports and never reuses another server. Stable ports let Turbo reuse an unchanged
production build with its baked-in API rewrite. It builds the API, web application and their dependencies, starts their
production entry points, waits for readiness and then runs Chromium. It does
not start a worker, configure LLM credentials, or publish to an external service.
Its child environment does not inherit your application secrets or database URL.
The container (including its anonymous volumes), media and servers are removed
on completion, including test failure. Build outputs remain available locally.

Do not aim these mutating tests at a normal development or production instance.
The Playwright configuration refuses execution without the runner's disposable
marker and loopback origin; there is no external target URL option. Keep the
runner in the foreground until cleanup completes. If the OS kills it forcibly,
remove only the exact `pubrick-browser-*` container printed by that run, never
prune unrelated containers or volumes.

Check the browser TypeScript fixtures before rebuilding the stack. Their separate
configuration covers files outside the normal application typecheck. The manual
channel fixture is typed against the shared `ManualPlatformId` contract.

## Coverage

The journey creates an account and workspace through the browser, creates a
brand and manual channel, writes and saves a draft, reloads it and checks the
review action without approving or publishing. It checks the HttpOnly session
cookie, creates a second workspace through the actual first-party auth endpoint,
switches through the Settings workspace selector, verifies brand isolation on
the Russian route, and switches back through the Russian Settings selector to
verify the saved draft. Requests are not intercepted or mocked. The second-
workspace fixture and UI switches exercise the same-origin auth rewrite and
cookie updates.

Failure screenshots and traces live under `.data/browser-tests` (gitignored).
Open a trace using `pnpm exec playwright show-trace <trace.zip>`. These artifacts
contain disposable account/session data; do not upload them from a real instance.

The scoped-write journey creates a separate account, workspace and manual
channel, then issues read and import keys through Settings. A cookie-free
Playwright request context exercises concurrent import replay, read/write scope
separation, v1 exclusion of imported drafts, changed-payload conflicts and key
revocation. The owner opens the imported draft through the editor, sees its
intake history, edits the body and reloads it. Replaying the original import
returns the original acknowledgement without replacing those edits. The journey
does not approve, publish, run a worker or call an LLM. Actual queued generation
and metering are covered by the native public-write integration tier with the
existing scripted model, independently of this browser journey.

Playwright is the maintained browser automation library (Apache-2.0); the suite
uses its assertions and runner instead of a custom polling/browser harness.

## Hosted BYOK fixture journey

```sh
node scripts/e2e/hosted.run.mjs
```

This opt-in runner owns different ports (31310–31313), disposable PostgreSQL,
media, synthetic secrets, and authenticated loopback-only SMTP capture. It uses
compiled API/worker with `NODE_ENV=test` and a production-built Next application.
The fixture billing driver is intentionally refused by a production API; this
journey does not establish readiness for live payments or real email delivery.
No Google, public SMTP, publishing, or payment requests are made.

The fixture control server seeds identity-scoped subscription facts against the
runtime-created test catalog. These facts represent test access only. The
journey covers verified signup, hosted workspace creation, unpaid refusal,
manual draft and knowledge editing, queued invitation mail and acceptance,
seat limits, expired growth refusal, and retained read/export/deletion access.
Each mode skips the other mode's journey. Neither runner accepts an external
application URL or reuses the normal developer stack. All fixture listeners and
database/media resources are closed on normal completion or startup failure.

## Docker context isolation

```sh
PUBRICK_DOCKER_CONTEXT_TEST=1 node --test scripts/docker-context.test.mjs
```

This opt-in probe uses the maintained Docker builder with a synthetic context
and a `FROM scratch` image. It verifies that the repository's `.dockerignore`
excludes root and nested environment secrets and local data while retaining
`.env.example` files. It never copies the operator checkout or configuration,
requires no downloaded base image, and removes its temporary fixture afterward.

## Weekly plan generation journey

```sh
node --test scripts/recurring-model-fixture.test.mjs
node scripts/e2e/recurring.run.mjs
```

This manual runner owns web/API ports 31320/31321, a fresh PostgreSQL 16
container, media directory and random authentication/encryption secrets. It
builds API, worker and web from the same checkout and verifies the latest
migration before starting the journey. Application environment variables and
real provider keys are not inherited. Before build and runtime, the runner
refuses Next.js environment files in the web project and standalone directory;
it checks file metadata without reading or changing those files.

A test-only Node preload intercepts the compiled worker's Google SDK fetch
transport. It accepts only the synthetic key, exact Gemini model endpoint,
structured generation request and unique journey marker. It returns five
schema-valid role outputs. A runner-owned channel context file correlates the
adapter receipt with the actual channel created through the UI; its marker, UUID,
manual platform and prompt are checked. Unexpected requests are durably recorded before
throwing, and the runner checks this failure latch even when the SDK catches an
error. Worker exit and failed/cancelled generation are monitored outside browser
poll assertions, so swallowed polling errors cannot consume the full deadline. There is no forwarding to the original fetch. This covers the Google
transport, rather than all possible Node networking APIs; the fresh brand has
no knowledge, news, images or webhooks, and its manual channel has no publishing
credentials. No production endpoint or provider hook is added.

The actual browser signs up, configures the synthetic Google key and selected
model without testing the provider, saves a disabled weekly plan, previews it
and authorizes paid generation. The real planner, calendar dispatcher and
compiled pipeline generate one draft at a UTC minute two to three minutes
away. The journey verifies five role calls, checkpoints and metered calls,
opens and edits the draft without approving it, pauses/resumes the plan, skips
a future date and observes a completed planner pass before checking that skip
is permanent. Removing the plan retains the immutable dispatch evidence. No
publication record or publish job may exist.

The journey deadline is eight minutes after build/readiness, generation is
bounded to the due time plus two minutes and post-generation actions to three
minutes. Failures retain synthetic browser traces/screenshots under
`.data/recurring-browser-tests` and a printed bounded receipt path. Successful
runs remove the receipt directory. Child process groups are stopped before
owned container volumes and media are removed; build outputs remain reusable.
This acceptance complements native concurrency tests and does not replace them.
