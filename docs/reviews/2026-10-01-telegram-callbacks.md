# Telegram draft callback implementation

Date: 2026-10-01. Branch: `codex/telegram-draft-decisions`.
Tracking: `Ozon-tools-bdur9`. Design: [0013](../specs/0013-telegram-draft-decisions.md).

## Implemented scope

An eligible notification from an active workspace bot replaces the Reject web
link with an opaque callback. Review, Schedule and Publish remain authenticated
web links. The worker commits a hash-only capability and its physical send claim
before calling Telegram once. Disabled or ineligible configurations retain the
existing web-link workflow. An uncertain send is never automatically repeated.

The authenticated group callback checks current bound-editor authority and the
complete fresh-draft snapshot before issuing a separate private confirmation.
Its final Reject consumes the actor capability, applies the existing transactional
content rejection, revokes sibling capabilities and records minimal audit and
replay evidence in the same transaction. Cancel only consumes that actor's
confirmation. Neither action publishes or generates content.

The common editorial snapshot now lives in `packages/db`; the API compatibility
export preserves the existing serializer and hashes. The fresh-draft reader locks
adaptations, channel display fields and the item, and refuses delivery history,
scheduled/attempted work, foreign references or actual live publication jobs.
Queue reads reuse the installed pg-boss caller-transaction adapter, including
active jobs. No additional queue or provider gateway was introduced.

## Findings and closures

Independent source review found two concrete callback defects. Accepted replay
responses now require current actor visibility, including after membership or
binding revocation. A definite refusal of a private send now terminalizes its
confirmation, permitting a fresh explicit initial click. Unknown delivery still
does not authorize a resend. A fresh click also revokes an incompatible old
confirmation; it never silently updates an existing consent snapshot.

Late provider completion may record a physical send result on an already revoked
capability, but cannot restore its authority or overwrite provenance reconciled
by an authenticated callback. The affected source closure was independently
reviewed; that review is distinct from executable acceptance.

## Local evidence

Synthetic credentials and an owned PostgreSQL fixture were used. No real
Telegram, publication or paid model request was made.

- Shared DB snapshot fixtures: five legacy-hash tests passed. The API compatibility
  fixtures also passed all five tests.
- Shared fresh-draft reader: six native tests passed, including observed PostgreSQL
  lock waits for channel rename and reader-first channel deletion.
- Initial worker notifications: five native cases passed, covering commit before
  send, unknown delivery without fallback/resend, definite refusal, legacy fallback
  for disabled/live-job cases and revocation during an outstanding provider call.
- Callback API: eleven native cases passed, covering unbound callers, final
  rejection and replay, stale snapshots, incompatible consent, competing callbacks,
  membership/binding revocation, unknown private delivery reconciliation, definite
  private refusal recovery, cancellation, historical safety and expiry.
- Status isolation: a focused native case passed for both singleton endpoints;
  other users cannot see the candidate/challenge, and a different workspace sees
  its own defaults even with an unrelated organization in query/header fields.
  Test-construction failures (Promise chaining and a missing active workspace)
  were retained separately from the final native result.
- Transport: ten tests passed against synthetic or injected requests.
- Workspace typecheck: twenty tasks passed. Formatting failures in the first lint
  pass were retained and fixed through Biome.

Local logs are retained outside the repository, including
`telegram-fresh-reader-native.log`, `telegram-initial-native.log`,
`telegram-callback-native.log` and `telegram-atomic-transport-contract.log`.

## Native mutation evidence

The existing mutation runner was invoked with `--runs 3 --files
src/telegram-decisions/telegram-decision.e2e.spec.ts` for the API workspace on the
same owned database. A reviewer checked the cutpoints and expected behavioral
killers before the root agent, independently of the implementation author,
executed them. All eleven cases passed on each of three baseline runs.

| Deliberate mutation | Result on every run | Behavioral failure |
| --- | --- | --- |
| Remove only final fresh-snapshot hash equality | KILLED, 3/3 | Stale body callback incorrectly rejects the changed draft |
| Replace reread membership role with `owner` | KILLED, 3/3 | Final callback incorrectly rejects after membership downgrade |
| Replace final `consumed` state with `revoked` | KILLED, 3/3 | Exact consumed-state assertions fail in normal and unknown-send reconciliation cases |

The harness required the expected failing test names, refused missing reports
and restored the original source in a `finally` block. Complete per-cutpoint logs
are retained as `telegram-atomic-proof-{baseline,snapshot,current-role,consumption}.log`.
The role proof covers current role visibility; it does not independently prove
every binding/grant predicate or replace observed concurrency evidence.

## Expanded acceptance evidence (2026-10-02)

The callback suite passed all fourteen native cases after adding three independently
reviewed proofs. A tenant-specific audit-storage failure rolls back rejection,
capability consumption and the final receipt; the same update then retries once.
Two separately bound editors cannot cancel each other's private confirmation;
concurrent final decisions produce one audit, one consumed capability and one
revoked sibling. A callback visibly waits on the actual channel writer's backend
PID, then refuses the changed snapshot after that writer commits. The retained
log is `telegram-callback-expanded-native.log`. These proofs do not exercise
queue cancellation or every possible domain writer.

The first compiled API/worker/web journey passed at committed source
`a5239965c7727cc9fc731f8c69a16c9b68fa820d`, using the pinned PostgreSQL image
and a synthetic loopback Bot API. It covered signup, settings, two-phase account
binding, an actual worker notification, private rejection, replay, a stale edit
and mobile unlink. Three outboxes were sent in six physical messages, with no
publication or usage-ledger rows. Its owned container and processes were cleaned
up. The log is `telegram-compiled-browser.log`. A second compiled run passed at
`e264051f0e63194041dbfdc3605507cb1a9de2b5`: mobile account connection, Refresh,
confirmation and the unlink dialog were driven with keyboard activation.
The linked card was captured at 375 × 812 and checked visually; no horizontal
page overflow was observed. Its log is `telegram-compiled-browser-keyboard.log`.
The runner again removed its owned services and database.

## Additional authority and writer boundaries

The integrated native run passed 28 of 29 cases. It includes actual observed
waits for grant removal, user deletion, member removal, role downgrade, bot
and binding revocation, master/adaptation/media changes, a publication-claim
storage boundary, item deletion and organization deletion. Private-only expiry
passed with a valid parent. These SQL boundaries follow the application lock
chains; they do not invoke the complete HTTP editor, media SDK or publish queue.
Organization-first content writers block the callback at the organization,
whereas the publication-claim boundary blocks it at the adaptation.

The failing hashtag fixture changed separate metadata without composing the
publishable body. The actual editor stores canonical text with the shared
`withHashtags` helper; the corrected case uses that same composition and passed its focused native
closure (one passed, 28 intentionally skipped). The composite result covers
all 29 distinct cases; it is not a single green 29-case run. This is a fixture correction, not a legacy hash change.
Earlier expiry fixture failures attempted immutable timestamp updates, then
incorrectly assumed an initial receipt did not reference the issued capability.
The final fixture preserves that receipt, revokes the original and inserts a
separate expired synthetic confirmation. Its timestamp relation to the parent
is a defensive predicate fixture rather than a normal issuance timeline.
Two focused attempts timed out in application bootstrap under concurrent static
checks, before reaching assertions; the solo integrated run reached all cases.
The logs retain those failures and the affected closure, including
`telegram-callback-integrated-races-native.log` and
`telegram-callback-hashtags-native-closure.log`.

## Remaining acceptance

This is an implementation milestone, not completed Telegram feature acceptance.
Broader native writer interleavings and a durable result shown in the web UI
remain required; the compiled journey and three expanded native cases above passed. A separate private-only expiry fixture now isolates that predicate with a
live parent. Reader-first channel deletion
does not prove arbitrary raw channel-first deletion safe.

The first integrated unit run timed out in two existing shared corpus tests under
concurrent workspace load and aborted other packages. The sequential closure
passed those tests but found three catalogue-wording violations and one calendar
test timeout. The wording was corrected; both affected files passed all 21 cases
with one file worker, without changing test limits or suppressing warnings.
The API unit closure also found two unregistered singleton status endpoints in
the tenant-list inventory. Their explicit reasons now name a native isolation
test. Four other API files failed import because the unit run lacked synthetic
environment defaults; the affected closure passed 13 tests with 42 database-gated
cases explicitly skipped. The worker unit suite passed 255 cases with 406 native
cases skipped. Logs retain the original failures and affected closures. No remote CI was dispatched and no `main`
release or live Telegram interoperability is claimed.

The actual janitor/final-callback overlap test is independently source-reviewed
and included in this acceptance candidate. It owns a compiled API subprocess,
synthetic provider and pools; both orders use observed native lock barriers.
Its execution remains pending against freshly built candidate artifacts.
