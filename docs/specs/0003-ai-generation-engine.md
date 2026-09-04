# Pubrick AI Generation Engine (Design)

**Date:** 2026-08-28
**Status:** Historical record of a decision the codebase still lives with —
not living documentation. Increment 1 shipped; where this document and the
code disagree, the code is right. See the editorial notes marking the two
places later work (outside the five specs in this directory) changed the
schema this document describes.
**Covers:** increment 1 of the generation phase — the engine plus the minimum
UI that lets a human actually run it.

**Provenance:** Copied (front matter and editorial notes added; body
otherwise verbatim) from the project's private planning repository on
2026-09-04.

**Owner decisions (2026-08-28):** watched sources are in this phase, delivered
as increment 3 (§1); BYOK keys only (platform keys stay in P4 with billing);
the full five-role chain, not a lean three-step one; provenance invested in
beyond badges — untouched AI sentences are dimmed in the editor (the dimming UI
itself lands in increment 2; increment 1 produces the data it needs).

**Research basis.** Every version, model id, price and API shape in §4 was
verified against live npm and provider sources on 2026-08-28, not from memory.
They are still re-verified at plan time with named commands (§10), because a
wrong `repairText` claim rewrites §4's central decision and a wrong price
silently corrupts every estimated ledger row.

---

## 1. Shipping order

The owner's answers describe the whole of phase P2 plus the generation engine —
three subsystems that cannot be debugged simultaneously. They ship in this
order, each ending in a working product:

1. **Engine (this spec).** BYOK credentials, the provider layer, usage and cost
   accounting, the run state machine, the five-role chain, content and
   adaptation versions, provenance, and the UI to start a run from a typed
   brief and watch it.
2. **AI in the editor.** Refine verbs on selection and `⌘K`, the
   Accept / Try again / Discard staging loop, the sentence-dimming toggle,
   per-channel re-adaptation, version history and restore.
3. **Watched sources.** RSS and Telegram ingestion, deduplication, relevance
   scoring, the topics bank — a topic becomes the same run input the engine
   already accepts.

The reverse order produces news nobody can turn into a post. Increments 2 and 3
get their own specs; this one deliberately does not design them. "In this
phase" therefore means all three increments; "out of scope" in §11 means out of
increment 1.

Increment 1 is done when the owner can, on a clean install: paste an OpenRouter
or Gemini key, type a brief, watch five steps run, and land on a draft with
per-channel adaptations, an origin badge, a cost in dollars, and a refusal to
publish anything no human has opened or touched.

## 2. Why the existing conveyor needs new pieces

Today `content_items → adaptations → publications` is written only by a human
through the compose form, and `update()` overwrites `body` in place
(`content.repository.ts:248`). Four gaps block AI writing into it:

- **No history.** An AI draft that replaces human text is unrecoverable, and
  provenance has no reference point (§6).
- **No run state.** A five-step chain needs checkpoints; a crashed or retried
  job must not re-spend money on steps that already produced output.
- **No AI credentials and no ledger.** There is nowhere to keep a BYOK key and
  nowhere to record what a generation cost.
- **No async progress in the web app.** Publishing is already asynchronous and
  is observable only by navigating back to the page; there is no polling
  pattern to copy, and the suite's zero-`act()`-warnings rule constrains how
  one may be written (§8).

## 3. Data model additions

All tables carry `org_id NOT NULL` referencing `organization.id` with
`ON DELETE CASCADE` and an `org_id` index, per the house rule. Enums stay
`text` columns backed by exported `as const` arrays — the existing convention,
which keeps status changes free of `ALTER TYPE`.

**`ai_credentials`** — one row per provider per org.
`id`, `org_id`, `provider` (`google | openrouter`), `credentials_encrypted`
(AES-256-GCM via the existing `encryptJson`, same as channels),
`default_model` text, `created_at`, `updated_at`. Unique on
`(org_id, provider)`. The repository's public column allowlist omits
`credentials_encrypted`; one private method decrypts, mirroring
`ChannelsRepository.getDecryptedCredentials`.

**`usage_ledger`** — one row per model call, including calls that failed after
the provider had counted tokens.
`id`, `org_id`, `run_id` (nullable — increment 2's refine calls have no run),
`step` text, `channel_id` uuid null (set for adapter calls), `attempt` int,
`provider`, `model_id`, `input_tokens`, `output_tokens`,
`cached_input_tokens`, `reasoning_tokens`, `cost_usd numeric(12,6) NULL`,
`cost_source` (`provider_reported | price_table | unknown`), `status`
(`ok | errored`), `response_ms`, `key_ownership` (`byok | platform`, always
`byok` here — the column exists now so P4's quota queries need no migration),
`created_at`.

Two rules the accounting depends on: ledger rows are written **in their own
transaction, immediately, before the step's checkpoint** — a failed run must
not lose the record of what it already spent; and `reasoning_tokens` is kept
because on Gemini 3.x thinking tokens bill at the output rate, so dropping it
would understate cost.

**`pipeline_runs`** — one row per generation.
`id`, `org_id`, `brand_id`, `input jsonb` (`{kind: "brief", text, channelIds}`
— `kind` exists so increment 3 adds `"topic"` without a migration),
`status` (`queued | running | succeeded | failed | cancelled`),
`current_step` text, `steps jsonb` (checkpoint map, §5), `content_item_id`
(nullable, set on success), `error` text, `dismissed_at` timestamp null,
`active_job_id` text null, `lease_expires_at` timestamp null, timestamps.

`awaiting_review` is **not** in the enum: nothing in increment 1 transitions
into it, and a status no code can reach is a decision deferred without an
owner. Increment 2 adds it with its own migration. There is no `attempt`
column — pg-boss owns retry state and a second copy would drift.

**`content_versions`** — append-only, covering both levels.
`id`, `org_id`, `content_item_id`, `adaptation_id` uuid null, `body`, `title`,
`origin` (`ai | human`), `run_id` null, `created_by` null, `created_at`.
The first `ai` version of an item (and of each adaptation) is the provenance
reference (§6). Adaptations are versioned in increment 1 — not deferred —
because the adaptation body is what actually reaches the platform, and a
promise about AI text that ignores the shipped text is not a promise.

`content_items` gains `origin` (`ai | human`) and `first_opened_at timestamp
NULL`. `adaptations` gains `origin` (`ai | human`).

> **Editorial note (2026-09-04).** The schema below is what increment 1
> shipped; it has since moved twice, in work outside the five specs kept in
> this directory. `usage_ledger` gained `content_item_id` and
> `adaptation_id` (closing the gap §11 names below — see the
> authorship-per-sentence spec, `0005`, §4) and, later, an `outcome` column
> (`completed | refused | unknown`) that distinguishes a call the provider
> billed in full from one it refused for free — the two failures a
> zero-token row otherwise can't tell apart. `pipeline_runs.error` became a
> closed `RunFailure` code rather than free text (a provider's own error
> prose can quote a submitted API key back at the browser), and
> `pipeline_runs` gained an `unrecorded_calls` counter for ledger writes
> that failed silently. `packages/db/src/schema/generation.ts` is current;
> this section is not.

## 4. The AI layer (`packages/ai`)

A new workspace package, not a folder in `apps/api`: the API and the worker
both need it, and `@pubrick/shared` is contractually zod-only. It depends on
`ai@7`, `@ai-sdk/google`, `@openrouter/ai-sdk-provider`, zod, and
`@pubrick/shared`. It reads `APP_ENCRYPTION_KEY` because provider resolution
decrypts the org's key. (`APP_ENCRYPTION_KEY` later became a comma-separated
key ring, newest first, so a rotated key can still decrypt what an older key
encrypted — see `packages/shared/src/crypto.ts`; this section predates that
change.)

**Version reality, verified 2026-08-28 against the published tarballs and by
running the SDK, not from docs alone.** `ai@7.0.83` is stable (7.0.0 shipped
2026-06-25). It is ESM-only, but `require(esm)` is unflagged on Node ≥22.12 and
the graph has no top-level await, so the CJS NestJS build keeps working; no ESM
migration. `@ai-sdk/google@4.0.56` pins `@ai-sdk/provider@4.0.8`;
`@openrouter/ai-sdk-provider@3.0.0` declares no dependencies at all, only peers,
and the tree dedupes onto the same `4.0.8` because `ai@7` pins it exactly. That
is an outcome of deduplication, not a guarantee the provider makes — so a
lockfile check that all copies dedupe belongs in the first task.

**Structured output.** `generateObject` is deprecated in v7. All structured
calls go through `generateText({ output: Output.object({ schema }) })`. Two
consequences that shape the code:

- The `Output` path has **no `repairText` hook** (it exists only on the
  deprecated API), and a schema violation throws `NoObjectGeneratedError`
  without retrying — `maxRetries` covers transport errors only. The package
  owns a repair-and-retry wrapper: on a violation, one repair attempt feeding
  the offending text and the validation error back to the model, then give up
  as permanent. Both branches are unit-tested, and the repair call is metered
  under its parent step's key with `attempt = 2`.
- Output resolution runs only when the model finished with text: a response
  whose content is a tool call skips resolution entirely and the `.output`
  getter then throws `NoOutputGeneratedError`. A test double must therefore
  return **text** content — this dictates the shape of every mock in §8.

**Four traps found while building this, worth knowing before touching the
package.** `finishReason` on the v4 model spec is an object `{ unified, raw }`,
not a string — a string satisfies vitest at runtime and fails `tsc`, so a mock
copied from an older example does not compile. `ai` does not re-export
`LanguageModelV4`, and its `LanguageModel` union admits a bare gateway string,
so `@ai-sdk/provider` is an explicit dependency for the type. A genuinely
retryable status makes the SDK sit through its real backoff, which blows a
5-second test timeout — test doubles for the transient path pass
`maxRetries: 0`. And `onLanguageModelCallEnd` fires **before** a schema
violation throws, which is exactly what makes the "tokens were billed, then the
call failed" ledger row possible: the recorder buffers the event and decides
`status` once the call's fate is known.

**Prompt boundary.** v7 rejects system messages inside `messages`/`prompt` by
default as prompt-injection hardening; instructions go in the separate
`instructions` field. Brand voice and step instructions are `instructions`; the
brief — and in increment 3 the fetched article text — are `prompt`. That
boundary is established now, before untrusted source text exists.

**Provider resolution.** `resolveModel(credential, modelId?)` builds the model
from an **already-decrypted** credential. An earlier draft had
`providerFor(orgId)` decrypting inside this package, which is impossible:
`packages/ai` has no database dependency and must not acquire one. The decrypt
stays where every other secret's decrypt lives — a private repository method on
the owning module, mirroring `ChannelsRepository.getDecryptedCredentials` — and
the caller hands the result in. Default `@ai-sdk/google` with
`gemini-3.7-flash`. Its price is the Flash tier's $0.75/$3.75 per 1M as of
2026-08-28, explicitly introductory and doubling to $1.50/$7.50 on 2027-01-01 —
so the price table stores rates with effective dates, not bare numbers, and the
same tier rate applies to other Flash models.

Sampling parameters on Gemini 3.x are **deprecated but still functional**
(an earlier draft of this spec said removed — wrong), and Google recommends
leaving `temperature` at its default of 1.0; `thinking_level` is recommended
over the still-supported `thinking_budget`, and sending both is a 400. The
settings UI therefore exposes neither: not because the API forbids them, but
because a knob whose vendor recommends never touching it is chrome that invites
misuse.

OpenRouter ids are `vendor/model`, and roughly a quarter of its catalogue cannot
do structured output — 100 of 387 models on 2026-08-28, a figure that moves
daily and must never be hardcoded.

The model is therefore a free-text field validated by the **Test** action, not a
picker populated from
`GET https://openrouter.ai/api/v1/models?supported_parameters=structured_outputs`.
An earlier draft specified the picker; building it revealed the simpler design
already covers the failure mode, because Test makes a real structured call and
so proves the key, the model id and structured-output support at once — while a
picker would ship a network dependency, a 387-row list, a loading state and an
empty state to prevent an error the user gets anyway, one click later and in
plainer words. The endpoint stays documented here because a picker becomes
worth it the moment users are choosing models rather than pasting one they
already know.

**Usage and cost accounting.** Recorded by passing
`telemetry: { integrations: recorder }` **on each call**, not by
`registerTelemetry`: the global registry has no unregister, and per-call
integrations replace the global list.

The recorder hooks `executeLanguageModelCall`, which the SDK invokes **inside**
its retry closure — not `onLanguageModelCallEnd`, which fires once after the
loop resolves. That distinction is the whole point of the ledger: with the
SDK's default `maxRetries: 2`, three physically billed calls produce one end
event, and three failures produce none at all. A BYOK user pays for every round
trip, so the ledger records every round trip; anything else under-reports spend
by up to three times and reports nothing for the runs that failed most
expensively.

Note what this does *not* say. An earlier draft justified the choice by
claiming `wrapLanguageModel` middleware suffers the same once-per-step
problem — it does not: middleware wraps `doGenerate`, which is exactly what the
SDK retries, so it fires per round trip too. The real reasons to prefer the
telemetry hook are the other two: one model object serves a whole run, so
middleware has no clean place to carry per-step and per-channel attribution,
and it sees a third usage shape again. Getting the reason right matters because
the next person will reason from it. A per-run recorder carries `orgId`,
`runId`, `step` and `channelId` without global state, and tests cannot leak a
sink into the next file.

Hooking inside the retry loop changes which usage shape arrives:
`executeLanguageModelCall` resolves to the **raw provider result**, so the
recorder reads the fully nested shape (`usage.inputTokens.total`,
`usage.outputTokens.reasoning`) — the same shape `MockLanguageModelV4` takes,
and not the flat-totals shape `onLanguageModelCallEnd` carried. Reading the
wrong one yields zeros rather than an error, which is why both shapes are named
here and in §8. That hook also carries no `performance.responseTimeMs`, so
latency is measured around the closure.

This deviates from the product design's §5 ("every call passes through
`wrapLanguageModel` metering middleware"), written before v7 shipped the
telemetry hook. The deviation is deliberate — middleware sees a different usage
shape and no latency — and `docs/specs/0001-product-design.md` is updated to
match.

Cost comes from `providerMetadata.openrouter.usage.cost` — an **optional**
field, so its absence is normal and must not be read as zero (note also that
its sibling is camelCased, `costDetails.upstreamInferenceCost`, and that video
models report cost one level up; neither is used here but both will surprise a
reader who greps) — else from the local price table, else it is `NULL` with
`cost_source = 'unknown'`
(a model absent from the table — OpenRouter's long tail, or a Gemini model
added after the table was written). Display rules, per run and for the
Settings total, are then exactly three: any `unknown` row → `≥ $X (n calls
unpriced)`; any `price_table` row and no `unknown` → `≈ $X`; all
`provider_reported` → `$X`. `SUM()` over a nullable column with no such rule
renders a confident, wrong number.

Metering every physical round trip means failed attempts also produce rows, and
a naive rule would downgrade a whole run to "≥ $X (1 unpriced)" after one
transient blip. The refinement is not to ignore errored rows — a failure that
consumed tokens cost real money and the total genuinely is a floor — but to
count a row as unpriced only when `cost_usd IS NULL` **and** it reports tokens.
A round trip that was rejected before any tokens were counted (a 429, a
connection reset) has a known cost of zero and neither adds to the sum nor
degrades the label.

**Error classification.** `PermanentError` and `TransientError` move to
`@pubrick/shared` (plain `Error` subclasses — no runtime dependency added);
`@pubrick/integrations` re-exports them under the existing
`PermanentPublishError` / `TransientPublishError` names, so its published
surface — which third-party platform adapters implement — is unchanged and no
call site churns. `packages/ai` imports the shared pair.

The AI classifier: `RetryError` → unwrap `.lastError`;
`APICallError.isInstance(e) && e.isRetryable === true` → transient (the SDK's
own predicate; `isRetryable` defaults to status 408/409/429/≥500); everything
else — schema violations, bad prompts, `LoadAPIKeyError`, a provider 401 —
permanent. Always `APICallError.isInstance`, never `instanceof`, because the
marker survives duplicate package copies. Lowercase `retry-after` /
`retry-after-ms` headers supply the backoff hint when present.

**Platform limits.** `Publisher.maxTextLength` exists on the interface but has
zero readers, only telegram implements a publisher at all, and channels can be
created for all eight platforms. So the limits become data:
`PLATFORM_MAX_TEXT_LENGTH: Record<Platform, number>` in `@pubrick/shared`, read
both by `telegramPublisher.maxTextLength` (so the two cannot drift) and by the
Adapter step — which keeps `packages/ai` from importing the publishing package
at all. The adapter's schema enforces
`max(min(platformLimit, MAX_BODY_LENGTH))`; `MAX_BODY_LENGTH` is 4096 and
bounds `adaptationUpdateSchema`, so an adaptation over it would be
un-editable through the API forever. A violation gets one repair retry, then
fails the run with "the model could not fit <channel>'s limit" — never a
silent truncation of text nobody approved.

## 5. The run

**One pg-boss job per run, not per step.** Steps are cheap to resume from
checkpoints and expensive to re-run. `GENERATE_QUEUE`, `GENERATE_DLQ`,
`GenerateJob`, `GENERATE_QUEUE_OPTIONS` and `GENERATE_WORK_OPTIONS` join
`packages/shared/src/jobs.ts` beside the publish contract. Two of those need
saying explicitly: the full option set is `retryLimit 3`, `retryDelay 60`,
`retryBackoff`, `retryDelayMax 3600`, `expireInSeconds 1800`,
`heartbeatSeconds 30`, `deadLetter` — not just an expiry; and
`groupConcurrency` is a `work()` option, **not** a `QueueOptions` field, so it
lives in `GENERATE_WORK_OPTIONS = { batchSize: 1, groupConcurrency: 1 }`,
shared for exactly the reason the publish contract is shared — otherwise the
producer and consumer drift silently.

The job is enqueued **in the same transaction** as the `pipeline_runs` insert,
with a deterministic id `uuidv5(runId)` (a run is enqueued once, so the
publish side's attempt-count complication does not apply), and a `null` return
from `send()` — pg-boss's dedupe — is a 409, never swallowed.

**Fencing.** A pg-boss v12 heartbeat does not extend `expireInSeconds`;
`failJobsByTimeout` fires on `started_on + expire_seconds` regardless, and it
cannot kill the original handler. Without fencing, a run that outlives 1800s
would be executed twice concurrently: both handlers skip the same checkpoints,
both re-run the rest (double spend), and both reach the terminal write —
producing two content items for one run. So the handler **claims** the run:

```
UPDATE pipeline_runs SET active_job_id = $jobId, status = 'running', lease_expires_at = now() + interval '30 minutes'
WHERE id = $1 AND (active_job_id IS NULL OR active_job_id = $jobId OR lease_expires_at < now())
```

**The job id is not a fencing token** — this is the correction that makes the
scheme work. pg-boss's `failJobs` deletes and re-inserts the job under the
*same* id, so `active_job_id = $jobId` admits the retry alongside a first
handler that is still alive: as originally specified the fence did not fence,
and both handlers reached the terminal write, producing two content items for
one run. The token is therefore `<jobId>#<per-delivery nonce>`; the claim
matches on the job half (so a genuine retry still resumes from checkpoints)
while a live handler is displaced, the claim is additionally guarded on
`status IN ('queued','running')`, and the terminal write re-checks status and
fence under `FOR UPDATE`.

Zero rows → we were fenced: log and return without throwing (a retry would
lose again). Every checkpoint write and the terminal write carry
`AND active_job_id = $jobId`, and the fence is re-read **before each model
call** — checking only at the end means the loser still spends the money before
discovering it lost. Checkpoint writes take `SELECT … FOR UPDATE` on the run
row, because a jsonb read-modify-write from two writers silently drops one
side's checkpoints.

Three constraints the schema imposes on every one of those writes. Raw SQL does
not fire Drizzle's `$onUpdate`, so each `UPDATE` sets `updated_at = now()`
itself, and a test asserts the timestamp actually advances across two
checkpoint writes. All lease arithmetic happens **inside one SQL statement**
(`lease_expires_at = now() + interval '30 minutes'`, compared with
`lease_expires_at < now()`) — the columns are `timestamp` without time zone, so
comparing them against a JavaScript `Date` would silently mis-fence on a
non-UTC deployment. And "the run row is gone" is ordinary fence loss, not an
error: `DELETE /api/brands/:id` is an unconditional hard delete today and
cascades to `pipeline_runs`, so a step must never assume its own row still
exists.

**Checkpoints.** `pipeline_runs.steps` maps a step key → `{ status, output,
usage, finishedAt }`. Keys are `researcher | writer | editor | factcheck` plus
one per channel, `adapter:<channelId>` — a single `adapter` key would make a
crash mid-fan-out re-run every channel that already succeeded, which is the
exact re-spend checkpoints exist to prevent. A step whose checkpoint exists is
skipped on resume, and the skip is asserted in a test by proving the model was
not invoked again.

**The five roles.** Each is a class with a name, an input type, a zod output
schema and a `run(ctx)`; the service iterates them.

1. **Researcher** — turns the brief plus brand voice, audience and language
   into a structured angle: key points, what the audience already knows, what
   to avoid. No web access in this increment.
2. **Writer** — produces the master draft body.
3. **Editor** — tightens to the brand voice; returns the edited body plus a
   short list of what it changed, shown to the human.
4. **Fact-checker** — with no sources and no RAG in this increment it verifies
   nothing: it extracts factual claims and flags those that would need
   checking, and that list rides with the draft into the queue. The UI names it
   **claims to verify**, never "fact-checked" — claiming verification that did
   not happen is exactly the slop this product opposes. It becomes real
   verification in increment 3, against the source article.
5. **Adapter** — one call per selected channel, producing the per-channel body
   within that platform's limit (§4), written to `adaptations.body` with
   `origin = 'ai'` and its own first version row.

**Terminal write.** The content item, its adaptations, their first versions and
the run's completion are written in one transaction, respecting the documented
lock order (adaptations before content_items, `ORDER BY id`). While a run is in
flight the queue shows a run strip, not an empty draft — a failure leaves no
orphan card, and no new *content* status is needed, so the exhaustive
per-status editability maps stay untouched.

**Cancellation.** `POST /api/runs/:id/cancel` cancels the pg-boss job by
payload lookup (mirroring `cancelPublish`, which learned not to recompute a
stale job id) and sets `status = 'cancelled'` where the status is still
`queued` or `running`, in one transaction. The worker re-reads status under the
fence before each step and returns without throwing when cancelled. Ledger rows
already written are kept and still displayed: the money was spent.

**Failure.** A permanent error records `error`, sets `failed`, and the job
completes; a transient one is rethrown so pg-boss retries from the last
checkpoint. The DLQ consumer marks runs whose retries ran out, mirroring
`markExhausted`.

**Admission control.** `POST /api/runs` refuses with 409 when the org already
has 3 runs in `queued | running`, naming the number in the message.
`groupConcurrency: 1` serialises execution but does not bound spend — fifty
queued runs still cost fifty runs, and the fiftieth sits for hours behind a
30-minute head. It also refuses (400) a brand with no channels, matching
`contentCreateSchema`'s `channelIds.min(1)`, because the terminal write
otherwise produces an item with zero adaptations that `approve` would happily
mark approved while enqueueing nothing.

## 6. Provenance

**The model: no character offsets.** Offsets rot on the first edit. The AI's
own output is preserved as the first `content_versions` row — for the item and
for each adaptation — and provenance is computed by comparing current text
against it: a sentence still matching the AI version verbatim (after
whitespace normalisation) is untouched AI text; anything else is human.
Matching is by **multiset**: each AI sentence is consumed at most once, so one
original cannot license two human copies. An earlier draft also specified a
positional preference (nearest index first); it was implemented, found to be
dead code — no input distinguishes it from consuming any other slot — and
removed. A documented behaviour that no test can pin is a claim, not a
behaviour.

**The splitter's honest contract.** Split on `[.!?。！？…]+` followed by
whitespace, end-of-string, or a CJK character, and treat a newline-terminated
line as a boundary too (social posts are line-structured). Guard abbreviations
and the two cases that otherwise split mid-token: URLs (`example.com/x`) and
decimals (`2.5x`). Russian is a shipped locale and `т.е.` / `и т.д.` must not
split; Chinese and Japanese have no space after `。`; Thai has no terminator at
all — for a language the splitter cannot segment, the whole body is one
sentence and provenance degrades to whole-body comparison. That degradation is
stated in the spec and surfaced in the UI (the dimming toggle is simply absent
there) rather than silently pretending to sentence granularity.

Two false positives are accepted and written down: a human who retypes a
sentence identically is credited to the AI, and a reordered post reads as
untouched. Both fail safe — they under-claim human authorship, never over-claim
it. That direction is the invariant, and it is what the review battery tests
for: the defects found in the first implementation — Unicode NFD text reading
as edited, and a sentence-final abbreviation fusing two sentences — both failed
the *other* way, and one of them opened the publish gate for an untouched AI
draft. The mask and the publish rule are therefore derived from one split, so
they cannot disagree, and every exported function is mutation-tested. The splitter is a pure function in `@pubrick/shared`, shared by the API and
the web app so badge and dimming can never disagree, and it is tested per
language.

**The badge.** Derived, not stored: `origin = 'human'` → human-written;
`origin = 'ai'` and normalised body identical to the first AI version →
AI-drafted; `origin = 'ai'` and different → human-edited. An item whose
adaptations are AI while its body is human-written reads AI-adapted. This
requires `origin` in the content list's column allowlist — the content endpoint
does change, and the justification for a separate runs endpoint is simply that
a run is not a content item, not that the content endpoint is untouched.

**The publish rule.** Approval is refused — with a message that says why — when
**no human has opened the item and nothing has been touched**: normalised body
identical to the AI version, every adaptation likewise identical to its own AI
version, and `first_opened_at IS NULL`. Both sides use the same normalisation
the provenance function uses, or a single appended space would count as a
touch.

**A gap this rule does not close, recorded rather than left to be rediscovered.**
The check is entered on the *item's* `origin`, so a human-written item carrying
AI-written adaptations — the "AI-adapted" badge this very section anticipates —
never reaches it, and every channel could ship text no human read. It is
unreachable in increment 1, because nothing writes `adaptations.origin = 'ai'`
without the worker also marking the item `ai`. Increment 2's refine verbs create
it, and that is where it must be closed: enter the rule whenever a first `ai`
version row exists at *either* level. The cost of closing it early — refusing a
draft whose body a human typed until they open it — is why it is scheduled
rather than done now.

`first_opened_at` is stamped by an explicit `POST /api/content/:id/opened`
that the item page fires once after render — never as a side effect of the GET,
which the future public API and MCP server would also trip. And the run screen
must **not** auto-forward to the finished draft: it shows a "Draft ready" link
a human clicks. Auto-forwarding would satisfy the read signal on the exact flow
this increment exists to deliver, turning the promise into decoration. This is
enforced in the API, not the UI, and has its own e2e test.

## 7. Web

**Settings gains an AI section** — the one-place rule puts it on the existing
Settings screen, not a new nav entry: provider, key, default model, a **Test**
action (the one-verb rule fixes the word; the channels screen already uses it),
the org's spend to date under the §4 display rules, and a Remove action.
Test issues one minimal structured call — a fixed two-word prompt against a
one-field schema — and reports which model answered and what it cost, proving
the key, the model id and structured-output support in a single act for a
fraction of a cent. Its result is never cached: a key that worked yesterday is
not evidence. For a provider that reports no cost it says so rather than
showing zero. Removing a key fails that org's `queued` runs as permanent with a
message naming the missing key, not a raw 401 the user cannot interpret.
(Test later gained an hourly per-org call budget, `MAX_TEST_CALLS_PER_HOUR`
in `@pubrick/shared` — a repeated Test click is still a real, billed model
call. Not designed here.)

**Brand screen gains Voice & Knowledge.** `voice`, `audience` and
`contentLanguage` already exist in the schema, the DTO, the repository
allowlist and a `PATCH` route that has zero web callers; the create form sends
only `{name}`. Increment 1 makes them editable. The knowledge base itself is a
later phase.

**Generation entry point.** The compose screen keeps exactly one primary
action, "Create post". Above the body it grows a brief field with a
**secondary** Generate action; brief plus the already-selected brand and
channels start a run, under the same preconditions Create post enforces (a
brand and at least one channel, same inline error). Generate does not fill the
form — it **discards** the typed draft and starts a run that produces a
different item minutes later, so a non-empty body is confirmed before it is
thrown away. With no AI credentials configured, Generate is absent and the
brief field carries a one-line link to Settings — an empty state that teaches,
not a disabled control that explains nothing.

This is a third place where AI appears, and the pattern dossier's §5.1
(ADOPT-NOW) says AI lives only in the selection toolbar and `⌘K`. That verdict
governs *refinement of existing text*; whole-draft generation is a compose-time
input, not editor chrome. The dossier exists to prevent bikeshedding, so it is
**amended** to say this, not quietly contradicted. Increment 1 satisfies §5.2's
staging rule for the same reason worth stating: a run lands a `draft`, and
approval remains the explicit human act.

**Progress.** Starting a run navigates to `/[locale]/content/runs/[id]`, which
renders the five steps as a live checklist — the delivery-receipt pattern
already adopted for publishing — and, on success, offers the "Draft ready"
link. The receipt stays reachable from the finished item, so it is not orphaned
in browser history.

The queue lists runs as compact strips above the content cards, from
`GET /api/runs?state=open` (`state` is deliberately not a status-enum value —
the content list 400s unknown statuses by design, and a runs repository copying
that pattern would reject a fake member). Open means `queued`, `running`, and
**`failed` or `cancelled` that nobody has dismissed** — sorted failures first,
carrying the human-readable error and Try again / Dismiss. A failed run creates
no content item, so if its strip vanished the failure would be invisible
everywhere: silent failure is the anti-pattern the dossier names first.

Run statuses map to badge colours through a total
`Record<RunStatus, StatusBadgeStatus>` — the codebase's established way of
making a new status a compile error — with queued and running → scheduled,
succeeded → published, failed → failed, cancelled → draft. The five-colour rule
is absolute.

**Cost** appears on the finished draft as a figure with the model name, summed
from the ledger rows carrying that `run_id` under the three display rules. The
org-wide total in Settings sums by `org_id` alone and never joins through
`run_id` or `brand_id`: those foreign keys are `ON DELETE SET NULL` precisely so
that deleting a brand cannot erase the record of money already spent, which
means a join would quietly drop exactly those rows.

**Polling.** The app has no polling anywhere today. One small shared hook:
poll while a run is non-terminal, stop on any terminal status, clear the timer
on unmount *and* on reaching terminal, back off while the tab is hidden. The
suite runs with zero `act()` warnings by policy, so the hook is tested with
`vi.useFakeTimers()` advanced inside `act()`, and the run page — which reads
`params` — renders through `renderAsync`.

Strings land in `en` plus the three translations together, as the parity test
requires.

## 8. Testing

**No test may call a provider.** Unit tests use `MockLanguageModelV4` from
`ai/test`, whose `doGenerate` must return **text** content for the
`Output.object` path (a tool-call part throws `NoOutputGeneratedError`) and the
V4 nested usage shape. The repair wrapper is tested on both branches: valid
JSON first call, and invalid-then-repaired. Telemetry is asserted per call, so
no global sink leaks between files.

**Steps** are tested individually against a mock model: each asserts its output
schema and that its instructions carry the brand voice.

**The run** gets a worker e2e on a private queue pair — `registerAll` currently
takes a names override for the publish pair only, so that plumbing is extended
and `main.ts` updated, since turbo runs the api and worker suites concurrently
against one database. It covers: a five-step run to a real item and
adaptations; a resume that skips checkpointed steps and proves the skipped step
was not re-invoked; a fenced second handler that exits without writing; a
permanent failure that completes the job; a transient one that retries; and a
cancellation mid-run.

**The promises** get API e2e tests: an untouched AI draft cannot be approved;
`POST /opened` is what changes that; no endpoint ever returns a stored key; the
admission cap returns 409; a brand with no channels returns 400.

**The splitter** is tested per language — English, Russian abbreviations,
Chinese without spaces, a URL, a decimal — plus the reordering and duplicate
cases, as a pure function.

Web tests follow the house boundary rules and pin request bodies twice.
`OPENROUTER_API_BASE_URL` joins the four env vars already declared in
`turbo.json`'s `test.env`, or turbo caches across differing values.

## 9. What this changes elsewhere

- `docs/ux-patterns.md` §5.1 gains the amendment described in §7.
- `docs/specs/0001-product-design.md` §5's `wrapLanguageModel` sentence is
  updated to the telemetry hook.
- `packages/integrations` re-exports the two error classes from
  `@pubrick/shared`; `telegramPublisher.maxTextLength` reads the shared table.
- `CLAUDE.md` gains the generation rules worth enforcing on every future
  change: ledger rows commit before checkpoints; every model call is fenced;
  the publish promise is server-side.

## 10. Plan-time re-verification

These are cheap and they protect the design's foundation, so the plan's first
task runs them and records the output: `npm view ai version`,
`npm view @ai-sdk/google version`, `npm view @openrouter/ai-sdk-provider version`,
`pnpm ls @ai-sdk/provider --depth 10` (proving the dedupe §4 relies on), a check
that `ai/test` still exports `MockLanguageModelV4`, that `Output.object` still
has no `repairText`, that per-call `telemetry.integrations` still replaces the
global list, and the current Gemini price page. Any drift is reported before
code is written, not discovered by a failing test three tasks later.

This is not ceremony. An independent live check of this spec's fifteen
API claims found two of them wrong — Gemini's sampling parameters are
deprecated rather than removed, and the OpenRouter structured-output gap was
quoted at the wrong figure — both written from a first pass that felt certain.
The claims are corrected above; the lesson is that the next pass will be wrong
about something too, so it gets checked rather than trusted.

## 11. Out of scope for increment 1

In-editor refine verbs, the staging loop and sentence dimming (increment 2);
sources, topics and RAG (increment 3); image generation; the calendar; media
library; platform keys, quotas and billing (P4); autopilot. The `input.kind`
discriminator, the nullable `run_id` and `key_ownership` on the ledger, and the
nullable `adaptation_id` on versions exist so those increments add rows rather
than migrating existing ones.

Three things are deliberately deferred and recorded here rather than left in
task reports nobody reads again:

- **The ledger has no `content_item_id` or `adaptation_id`.** Increment 2's
  refine calls have no run, so attributing their cost to a draft needs an
  additive migration. Cheaper to know now than to improvise a `step` heuristic
  mid-task. *(Resolved: both columns were added by the authorship-per-sentence
  spec's migration, `0005` §4 — see the editorial note after §3.)*
- **No `CHECK (cost_usd >= 0)` on the ledger.** A negative provider-reported
  cost is now displayed rather than silently clamped to zero, so the harm is
  gone; the constraint itself was skipped because writing it properly means a
  migration landing in a tree where several tasks were already writing
  migrations, and a numbering collision is worse than a missing belt on braces
  that hold.
- **Per-run cost is not shown on the finished draft**, only the org total in
  Settings and the Test result — no endpoint exposes ledger totals per run yet.
  §7 describes the intent; the endpoint is increment 2's.
