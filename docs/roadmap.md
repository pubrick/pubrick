# Development roadmap

Updated: 2026-10-01.

This is the current execution plan. The original [product design](specs/0001-product-design.md)
records the P0–P5 scope; [porting status](porting-status.md) describes today's
capabilities and their exact limits. Neither a planned feature nor a manual
platform handoff should be described as automatic delivery.

## Current position

| Original phase | Current implementation | Remaining scope |
| --- | --- | --- |
| P0 — foundation | Monorepo, CI, organizations, brands, channels, review queue, Docker Compose, basic publishing and documentation | Public release packaging and repeatable installation/upgrade verification |
| P1 — generation | Five-role generation, source repurposing, reviewed revisions/history, calendar, media/video, roles, Bluesky/Mastodon | Private inbox sources and transcription are extensions of the current bounded source import |
| P2 — inbound | Feeds, public/private Telegram monitoring, relevance, topic suggestions, hybrid knowledge retrieval, images, reviewed website-to-brand import | X integration and verified social-profile import; richer retrieval evaluation |
| P3 — feedback and automation | Activity/results, VK metrics, comment analysis, draft Autopilot and digest, prompt revision observations, client review links, read API/MCP, scoped write API/MCP (integrated at `81b346fb`), webhooks, UTM | Controlled prompt experiments, stock media, evergreen recycling, Telegram decision bot, recurring plans/channel scheduling signals, additional platform metrics |
| P4 — hosted SaaS | Tenant isolation, usage ledger, public site, verified registration/recovery, durable mail, sandbox subscriptions, plans and resource/dispatch admission | Real payment sandbox verification, operations and support; platform-paid AI is a later extension |
| P5 — platform breadth | Several platforms have explicit manual publication workflows | Verified native integrations and broader media formats |

The working reference functionality has been ported across the areas described
in the inventory. Remaining reference placeholders, design-only video flows,
unverified native VC.ru delivery, arbitrary feedback scores, and forced automatic
publication are not evidence of working functionality to reproduce. Human review
before delivery remains a product rule in both self-hosted and hosted modes.

## Iteration 1 — a reproducible open-source release

Goal: a new maintainer or user can install, try, upgrade, and recover Pubrick
without relying on undocumented developer setup.

Deliverables:

- Local real-browser journeys against a built stack: account/workspace creation,
  brand and manual channel setup, draft editing/review, and organization switching.
  Keep external delivery/model calls mocked at their transport boundary. Run
  locally first; [issue #14](https://github.com/pubrick/pubrick/issues/14) does not
  authorize adding this expensive tier to every CI run.
- Fresh-install and upgrade smoke checks with database migrations, correct
  browser origin, durable media storage, and readiness checks.
- Backup/restore instructions and a tested recovery path for database, media,
  and credential encryption keys.
- Versioned releases, a concise user-facing changelog, and source-linked multi-arch
  GHCR images for the existing API, worker, and web services.
- Clear self-hosting quick start, troubleshooting, support/contribution guidance,
  and a usable private security-reporting channel.

Acceptance: pass these journeys on a disposable installation; verify upgrade
and restore with fixture data; publish an explicitly versioned release whose
images and documentation refer to the same source revision. A local passing
build alone does not satisfy release acceptance. Image reproducibility here
means a recorded source revision and deployable digest; byte-identical rebuilds
require additional base-image and toolchain pinning.

Implementation progress: release image tooling, consistent Compose recovery,
security reporting and the production browser runner are implemented and
integrated in `main` at `474e28a4`. The built browser journey and native recovery
round trip passed locally. See the [verification record](reviews/2026-09-30-release-foundation.md)
for test scope and follow-up fixes. The current-schema hosted recovery extension also passed locally, including
rotated encryption keys, retained storage and billing receipts; see the
[recovery acceptance record](reviews/2026-09-30-hosted-recovery.md). No versioned
images or release have been published yet, so release acceptance remains pending.

## Iteration 2 — common LLM providers

Extend the existing AI SDK resolver rather than adding a second gateway:
[issue #150](https://github.com/pubrick/pubrick/issues/150).

- Direct OpenAI, Anthropic, and DeepSeek BYOK adapters.
- Google Vertex as a separate credential mode, based on supported authentication.
- OpenAI-compatible endpoints with validated outbound network destinations.
- Explicit provider/model capabilities and consistent settings, error reporting,
  accounting, and unknown-cost handling.

Acceptance: credential replacement/testing, generation and metering work through
one pipeline; secrets never return to clients; unsupported embeddings/images or
structured output are stated explicitly. Provider support is not equivalent to
supporting every model and modality.

Direct OpenAI, Anthropic and DeepSeek adapters are implemented alongside Google
and OpenRouter. See [provider setup](llm-providers.md) and the
[foundation verification record](reviews/2026-09-30-hosted-foundation.md). Explicit workspace provider/model selection and revision-pinned run credentials
are implemented. Vertex (Express and service-account modes) and guarded public
OpenAI-compatible endpoints are also implemented. See the
[platform integration record](reviews/2026-09-30-hosted-platform.md) for the
local transport verification and capability limits; live provider access still
depends on valid operator credentials.

The existing local self-hosted installation has also been upgraded to the current
application artifacts and migrations. Its saved Google connection passed a real
provider probe through its saved proxy. See the
[local upgrade record](reviews/2026-10-01-local-upgrade.md) for the verification
scope and the unavailable interactive browser check.

## Iteration 3 — hosted SaaS beta (P4)

The owner confirmed the hosted paid service as a product direction on 2026-09-30.
Users should be able to use Pubrick without installing their own server.

Keep one open-source product and shared services. Cloud features should be
explicitly configured: an installation without billing configuration keeps its
self-hosted behavior and must not depend on a billing service to generate drafts.
Use a replaceable billing driver rather than coupling domain code to one payment
vendor. `packages/billing` now provides official-SDK sandbox and offline fixture
drivers. Application subscription storage, custom hosted organization routes,
resource quotas and physical model-call concurrency admission are implemented
in `main` at `474e28a4`. Encrypted durable authentication mail and manager-only
workspace data exports are implemented. The integrated hosted browser journey
passed against a disposable built stack with a fixture entitlement; this is not
checkout settlement. Real payment sandbox verification and deployment operations
remain required before a hosted beta is declared. The read-only
[operator status command](hosted-operations.md) is implemented in `main` at `81b346fb`; it reports bounded aggregate queue, subscription, cleanup and
physical-call facts and does not certify provider readiness.

Delivery slices:

1. **Hosted entry point:** public product site, sign-up/sign-in, workspace
   onboarding, and the first draft journey. State actual platform and AI limits.
2. **Plans and entitlements:** subscription lifecycle, seat/storage/concurrency
   limits, server-side admission, and clear usage screens. Client-side gating is
   not authorization.
3. **Payment integration:** checkout, verified/idempotent webhooks, reconciliation,
   cancellation and failed-payment states; validate with provider test mode before
   accepting live payments.
4. **AI funding:** BYOK subscriptions and/or included platform-paid AI credits.
   The initial offering is an owner decision. Platform-key calls need explicit
   routing and funding ownership, pre-dispatch reservations, durable settlement,
   failed-call accounting, and concurrency-safe admission. Estimated ledger costs
   must not be presented as exact invoices or hard charge caps.
5. **Hosted operations:** backups and restore drills, queue/database/provider
   monitoring, abuse controls, tenant data export/deletion, published support and
   data-handling policies, and a controlled beta before general availability.

Decisions before live launch: operating entity and payment-provider availability,
offered plans/limits, deployment region, and support/data retention policy. The
development beta uses BYOK with trials disabled; the commercial offering is
still unconfigured. Platform-paid AI is a later extension.
The remaining launch decisions are unresolved, not implementation promises.

Acceptance: an external user can register, activate a test subscription, create
and review a draft, inspect usage, change/cancel a plan, and export their data;
verified payment events and concurrent AI admission cannot grant duplicate or
unfunded usage. Self-hosted workflows remain usable with billing disabled.

## Later P3 and P5 work

After the release foundation and provider iteration, prioritize these against
observed usage and SaaS demand:

- Scoped write API/MCP for draft creation and generation; retain human delivery
  approval, explicit consent, idempotency, and auditable costs. Implementation
  and local acceptance are integrated in `main` at `81b346fb`, following the
  reviewed [v2 design](specs/0010-scoped-draft-write-api.md) and
  [execution plan](plans/scoped-draft-write-api.md).
  [Verification](reviews/2026-10-01-scoped-draft-writes.md) includes browser
  import/edit/revoke and native queued generation; main integration is complete.
- Recurring editorial plans and evergreen reuse before speculative best-time
  claims; collect evidence before suggesting optimal publication times.
- Telegram decisions only after account binding, authorization, snapshot checks,
  and callback replay protection are designed.
- Controlled prompt experiments, useful outcome attribution and retrieval
  evaluation; observational revision cohorts are not causal A/B results.
- Stock-media integration, additional measured platform metrics, and verified
  native publishing adapters. Do not promote unverified/manual integrations as
  native automation.

## Execution rules

Use coherent iterations. During implementation run focused checks; after
integration run the relevant full gate and independently review the combined
diff. Repeat checks only for affected code or a concrete remaining risk. Keep
English documentation and conventional commits. Preserve test-first bug
reproductions and the published authorization/accounting contracts. Record a
milestone as delivered only after its acceptance criteria are demonstrated.
