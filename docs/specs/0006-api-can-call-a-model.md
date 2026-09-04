# Pubrick — The API Can Call a Model (Design)

**Date:** 2026-08-30
**Status:** Historical record of a decision the codebase still lives with —
not living documentation. Increment 2b-2a shipped; where this document and
the code disagree, the code is right. §6's forward-looking content has been
replaced with a pointer, and §7 is marked as a point-in-time snapshot — see
the notes there.
**Covers:** increment **2b-2a** — the capability every editor-side AI feature
needs and none of them can have today: an API-side model call that resolves the
org's provider the same way the worker does, can be bounded, and can be
cancelled.

**Provenance:** Copied (front matter adapted, §6 replaced with a pointer, a
note added to §7; body otherwise verbatim) from the project's private
planning repository on 2026-09-04.

The refine verbs were specified with this in the same document. Review found ten
critical defects, and the sharpest of them — that the flagship verb doing its
job would caption the model's own words "Human-edited" — belongs entirely to the
feature half. A timeout should not have to be argued in the same document as a
sentence-provenance rule. §6 records everything that review established about
the feature half, so 2b-2b starts from it rather than rediscovering it.

**Verified against `127b034`.** §7 lists the claims a spec written from memory
would have got wrong; all eleven were checked against the code and confirmed by
review.

---

## 1. What is missing, precisely

An API-side model call is impossible or unbounded today, in five distinct ways:

- **`defineStep` and `Material` are exported from nowhere** — not the package
  barrel, not the steps barrel, and `packages/ai/package.json` declares a single
  `"."` export with no subpath map. Any step defined outside the package is
  unreachable.
- **`callStep` forwards six of `generateStructured`'s nine arguments** and drops
  `maxRetries`, `onUsageError` and `now`. So a step cannot bound its retries,
  while the one existing API-side caller — the credential probe — sets
  `maxRetries: 0` for exactly that reason, by bypassing steps entirely.
- **Nothing anywhere passes an `AbortSignal` to a model call.**
  `GenerateStructuredArgs` has no such field. The worker takes pg-boss's signal
  and polls it at step boundaries, never handing it to the SDK, so an in-flight
  call always runs to completion.
- **The API cannot resolve "this org's model".** `getDecrypted` demands an
  explicit provider; only the worker has a provider-agnostic rule, and it lives
  in a repository the API cannot import.
- **`StepContext.brief` is a required, non-nullable string** that only pipeline
  steps have a meaning for.

## 2. Provider resolution: one rule, one place

The worker picks the org's **oldest** credential by `created_at`, tie-broken by
`provider` ascending, so a resumed run reaches the provider the first attempt
billed. The editor must reach the same one, or a draft's refine and its
generation bill different vendors.

An earlier draft proposed duplicating the query with cross-references. Review was
right to reject that: two tests in two packages do not fail when the *other*
copy changes, which is the same "two things that must agree will stop agreeing"
argument this repo already makes about its splitters.

It is shareable, because the rule is an *ordering*, not a query. The table has a
unique index on `(org_id, provider)` and exactly two possible providers, so an
org has at most two rows. Both apps already know how to select all of them. So
the comparator moves to `@pubrick/shared` — zod-only, database-free — as a pure
function over rows, and both apps sort with it. One definition, two callers,
each pinned where it is used.

While there: `AiCredentialsModule`'s doc comment claims the worker resolves keys
through its `getDecrypted` and that a second decrypt is "exactly the drift this
module exists to prevent". Both halves are false — the worker has its own copy —
and a false comment about drift is worse than none.

## 3. Cancellation, and what an aborted call may claim

`abortSignal` joins `GenerateStructuredArgs` and is threaded into **both**
attempts: the repair retry re-enters the same path, so a signal given to one and
not the other still buys a second call. `callStep` forwards it along with the
three arguments it drops today.

**The SDK does not check the signal before dispatch — measured, not assumed.**
An already-aborted signal still reaches the provider, and a provider that
ignores it answers and bills normally; the SDK's own pre-check is guarded by a
step count a structured call never reaches. So "nothing is spent before
dispatch" is a property this package has to build, with its own check before
each attempt, rather than one it inherits. Aborts are also never retried and
never wrapped, surfacing as a bare `DOMException` whose `name` is the only
stable discriminator — the message is "This operation was aborted" or, from
inside the SDK's own retry sleep, "Delay was aborted".

**What an aborted call writes is not one row.** A single `generateStructured`
makes up to two logical attempts, each of which the SDK may retry — up to six
billed round trips by default. The recorder's hook sits inside the retry
closure, so it sees every dispatched round trip: an abort after dispatch leaves
one zero-token row per round trip already made, each `status = 'errored'`,
`cost_source = 'unknown'`. A round trip that returned and only then failed keeps
its tokens.

**And those rows are worse for the spend figure than an earlier draft of this
spec claimed.** They are not summed as zeros: `spend()` sums only priced rows and
counts unpriced ones only when the call reported tokens, so an aborted row
matches neither and lands in the "ignored" bucket — whose premise is that the
cost is *known* to be zero. That is true of a rate-limit refusal and false of a
call we may have been billed for in full. So the figure both understates real
spend and fails to gain the `≥` marker that would say it is only a floor. The
fix is not a `WHERE` clause: the row genuinely cannot tell an abort from a 429
that never counted tokens. It is recorded in code and left to whoever needs the
figure to be exact. It is also why the feature half must set `maxRetries`
deliberately instead of inheriting the default.

An `AbortError` is not an `APICallError`, so today's classifier renders it as a
bare permanent error and the user would be shown "This operation was aborted".
It gets its own classification and its own sentence.

## 4. `StepContext`, split rather than loosened

Making `brief` optional would relocate an empty string into three steps that
read it directly as material — researcher, writer and editor — and `string |
undefined` is a compile error in each, whose obvious repair is `?? ""` in three
places instead of one. So the type splits instead: `StepContext` carries what
every caller has (brand, model, provider, usage sink), and `RunStepContext`
extends it with the `brief` the pipeline steps require. Nothing becomes
optional, and a step that needs a brief still cannot be built without one.

## 5. Testing

`MockLanguageModelV4` with text content, the nested usage shape, `finishReason`
as an object. No test may reach a provider.

Pinned: the comparator picking the oldest credential, and its tie-break, from
both apps' call sites; a call aborted after dispatch writing one errored,
zero-token row per round trip already made, and an abort before dispatch writing
none; `callStep` forwarding `maxRetries` (today a step cannot bound its
retries at all); the abort classification's own message; and the five existing
steps compiling unchanged against the split context.

⚠ `apps/api` resolves `@pubrick/ai` from `dist`, and both apps resolve
`@pubrick/shared` from `dist` — a barrel export added here means nothing to a
consumer test until those are rebuilt.

## 6. What 2b-2b must answer

*(2026-09-04 note: this section recorded a long list of open questions for
the refine-verbs increment — the fragment row's accounting, money bounds,
where the toolbar lives on screen, and more. By the time that increment's
own implementation plan was written, six of this section's premises had
already turned out false against the running code (an export that is no
longer missing, an argument list that is no longer dropped, a timeout that
now exists, an outcome column that now exists, a provider-resolution helper
that now exists, and a screen that no longer has two primary-slot buttons).
A section titled "what must be answered" stops being that once some of it
already has been, one way or another, and reprinting it here would risk
being read as still-open work. Sequencing notes for unimplemented or
partially-implemented work are being kept out of this directory going
forward — see the project's issue tracker for what remains open in this
area.)*

## 7. What a spec written from memory would have got wrong

*(2026-09-04 note: this list is a point-in-time verification record, checked
against commit `127b034` on 2026-08-30. Several of its claims have since
changed with the code — `defineStep` and `Material` are now exported, for
one — so read it as a record of that review's methodology and findings at
the time, not as a current description of the codebase.)*

All eleven checked and confirmed. `defineStep` and `Material` are exported from
nowhere. `callStep` forwards six of nine arguments. No `abortSignal` exists
repo-wide. The worker does not use `AiCredentialsRepository.getDecrypted`, and
that module's comment saying so is stale. No code writes `scope: 'fragment'`,
and the worker's `ai` rows take the column default rather than naming it.
`usage_ledger.content_item_id` is written and read by nobody and has no index.
No query sums the ledger by run, though an index comment describes one as
though it existed. `DimmedTextarea` exposes neither its element nor its
selection, though selection *events* pass through. `bodyText` is module-private.
`contentUpdateSchema` is `.refine()`-wrapped and cannot be extended.
