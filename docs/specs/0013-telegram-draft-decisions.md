# Telegram draft decisions

Status: foundation, setup/binding, settings, retention and private callback
rejection implemented in the feature branch. Local scripted acceptance passed:
[callback receipt](../reviews/2026-10-01-telegram-callbacks.md),
[foundation receipt](../reviews/2026-10-01-telegram-foundation.md),
[setup/binding receipt](../reviews/2026-10-01-telegram-setup-binding.md) and
[settings receipt](../reviews/2026-10-01-telegram-settings-retention.md).
The receipts distinguish composite native results, compiled journeys and
precise proof limits. Live sandbox verification and release to `main` remain
pending. User instructions are in [notifications](../notifications.md).
Updated: 2026-10-02.

## 1. First slice and existing code

Provide one interactive action: **Reject**, for a fresh, unsent draft.
The first notification button starts a private confirmation flow. It does not
reject the draft. The bound editor must explicitly confirm in their private
conversation with the same bot. Keep Review, Schedule and Publish as existing
Pubrick URLs. Do not add Telegram approval, scheduling, publication, generation,
or paid consent in this slice.

This distinction follows the actual domain operation:

| Existing source | Relevant contract |
| --- | --- |
| `apps/worker/src/notifications/notifications.service.ts`, `deliver` | Durable outbound notification claim; draft buttons currently contain URLs and explicitly perform no decision. |
| `packages/integrations/src/telegram-notification.ts`, `sendTelegramNotification` | URL-only keyboard, one send attempt, explicit sent/rejected/unknown outcome. It currently discards Telegram message IDs. |
| `packages/db/src/schema/notifications.ts` | One encrypted bot-token/chat destination per organization; this is not a human identity binding. |
| `apps/api/src/content/content.repository.ts`, `approve` | Approval admits delivery jobs or manual publication readiness. Calling it would expand this slice into publication. |
| Same repository, `reject` | Owns rejection state, cancellation, delivery-claim protection and prompt decision journaling. Reuse this implementation in one transaction. |
| `apps/api/src/client-review/client-review.repository.ts` | Existing full editorial snapshot, compatible hash, adaptation-before-item locks and one-shot client verdict. A guest verdict is not a Telegram actor authorization. |
| `apps/api/src/auth.ts`, `org/active-org.guard.ts`, `request-authority-admission.ts` | Pubrick sessions, current membership, brand grants and editor capability. Telegram identity is absent. |
| `apps/api/src/sources/telegram-login.repository.ts` | Organization-owned MTProto source-monitoring login. Its session cannot authenticate a Telegram Bot API callback editor. |

Use the existing organization notification bot and maintained HTTP transport.
No new bot framework, LLM gateway, separate service or MTProto dependency is
required. Add a narrowly typed Bot API transport for setup, acknowledgment and
private confirmation; preserve the existing notification sender's semantics.

## 2. Bot ownership and webhook setup

Interactive decisions are an explicit manager opt-in. Resolve the configured
token with `getMe`; store the verified bot ID as a canonical decimal string,
separate from its encrypted token. Enforce one active **inbound owner** per bot
ID across organizations, retaining reserved/uncertain claims until explicitly
released. A token change is a revisioned operation; never infer bot identity
from the token's prefix or username.

Outbound-only notification configurations may continue sharing a bot: a token
or destination gives no identity binding or decision authority. Do not decrypt
every legacy workspace's token or change existing notification behavior merely
to enable inbound ownership for one organization. Both interactive setup and
notification credential replacement for an interactive owner use the same
identity/generation registry. A verified bot already claimed for inbound use
by another organization cannot be enabled here. The sole inbound handler's
namespace includes its owning organization; ignore foreign/bare commands and
refuse capabilities or bindings from other organizations, even when they use
the same outbound bot. Sharing a bot is thus not sharing domain authority.

Only HTTPS on a configured public origin is accepted. Each setup generation has
an unpredictable route identifier and a fresh random `secret_token` within the
documented character/length contract. Hash the inbound secret for comparison;
keep any value needed for an uncertain setup retry encrypted. The route ID is
not authentication. Check the exact secret header before parsing a bounded
update body; do not log token-bearing URLs, headers, start codes or callbacks.

Setup is a fenced state machine, with network calls outside database locks.
Database generation compare-and-set alone does not fence Telegram: a delayed
old `setWebhook` can overwrite a newer route, and a delayed `deleteWebhook` can
erase it. Maintain one durable remote-mutator lane per verified bot ID, shared
by setup, rotation and disconnect across API replicas. Persist the claimed
attempt before network I/O. Never reclaim an uncertain lane merely because a
lease or local HTTP deadline elapsed; neither proves remote completion.

Within that lane:

1. In a short parent-first transaction, verify manager authority, reserve the
   verified bot identity and desired setup generation. Disable decisions from
   the superseded generation and invalidate its capabilities.
2. Outside locks, inspect `getWebhookInfo`. An existing nonempty webhook URL is
   accepted only if it exactly matches a route generation already owned by this
   installation and organization. Refuse foreign URLs; never delete or replace
   another application's webhook. Do not enable `getUpdates` alongside webhook.
3. Call `setWebhook` with the desired URL and secret, preserving pending updates
   rather than dropping them by default. Record its result through a generation
   compare-and-set: confirmed, rejected, or uncertain. A late response cannot
   revive a disabled or replaced configuration.
4. An uncertain HTTP result remains **setup uncertain**, not ready. Read
   `getWebhookInfo` to detect absent/foreign/old/desired routes. That response
   does not expose the installed secret: matching URL alone cannot certify a
   secret rotation. A same-generation retry may repeat only the exact same
   URL, secret and request options, after a fresh ownership check; a successful
   identical retry or valid secret-authenticated inbound probe can establish
   operation of that same desired configuration. They do not prove an earlier
   unknown request has finished. Such an unresolved attempt continues to block
   any newer generation, secret change, destructive call or ownership release.
   Identical delayed installs are harmless only while that exact configuration
   remains desired. A probe never bypasses subsequent decision checks.
5. Disable/release is also revisioned. Mark local decision authority disabled
   first. Remove only the verified owned webhook outside locks, with an honest
   uncertain outcome and reconciliation. Retain the identity claim until all
   prior remote attempts are settled and the owned remote configuration is
   confirmed removed; do not create a second owner while cleanup is uncertain.
   A late delete must never race an enabled successor.

The first storage implementation is deliberately more conservative about
ownership release: it does not implement transfer between organizations, even
after a confirmed removal. Only deletion of the owning organization can clear
its owner reference, and that leaves a disabled, quarantined registry record.
Releasing or transferring a reserved bot requires a separately reviewed
recovery procedure; deleting a tenant configuration is not release evidence.

If a predecessor's completion cannot be established, leave remote mutation
blocked and keep its ownership reservation. `getWebhookInfo`, two matching
polls, elapsed time, socket closure and process restart are not completion
barriers. The Bot API offers no application fencing token for old setup calls.
Local disable/revocation still takes effect immediately, with no network wait;
the existing URL-only notification path can continue. An operator may move to
a separately verified new bot ID while the old bot remains quarantined. Reusing
the same bot for a different generation after irreducibly uncertain mutation
requires a separately reviewed provider/control-plane recovery procedure; this
document does not invent an automatic proof. Display that restriction explicitly
instead of calling the uncertain bot fully reconciled or ready for rotation.

Webhook delivery may begin before setup finalization. An armed desired route
can persist a bounded authenticated probe; it cannot apply decisions until its
generation is active. Retryable admission failure returns non-2xx. For recognized
supported operations, do not return 2xx before durable update acceptance or a
durable terminal refusal. Authenticated unsupported updates are deterministically
ignored with 2xx, without a journal or domain write; an invalid secret is refused
before update admission. Operator
instructions must cover reachable HTTPS, proxy body limits and secret headers;
an outbound-only bot configuration does not imply an inbound webhook works.

## 3. Explicit human account binding

Bindings are scoped by organization, verified bot ID and Pubrick user, and store
Telegram user ID plus the verified private chat ID. Telegram names/usernames
are display metadata only. No binding can arise from a group notification,
chat membership, matching username, arbitrary supplied numeric ID or the
organization's private-source account.

Two phases prove control of both accounts:

1. A signed-in Pubrick user with current workspace membership requests a
   five-minute binding challenge in their own settings. Store only its random
   code hash, user/org/bot generation, expiration and state. Apply the atomic
   user/organization issuance bounds in §7. A `t.me/<bot>?start=<opaque-code>` link uses a random
   base64url payload no longer than 64 characters and contains no user/org ID.
2. The authenticated webhook accepts `/start` only in a private conversation
   with a non-bot sender. Atomically record that challenge's Telegram `from.id`
   and private chat ID once; do not create a binding yet. Repeated matching
   claims acknowledge the same candidate; a different claimant is refused.
3. The original Pubrick user returns to the signed-in confirmation page. Show
   the candidate's escaped display name and stable numeric identity, workspace
   and bot. Explicit confirmation rechecks a real current Pubrick session,
   same user/organization, challenge freshness, active bot generation and
   current membership. Consume the challenge and write the binding atomically.
   A Telegram claim alone cannot bind to someone else's logged-in browser.

Permit at most one active Telegram identity per Pubrick user/org/bot, and one
active Pubrick user per Telegram user/org/bot. Reject conflicting replacement;
require explicit unlink/rebind. A person can unlink their own binding; managers
can revoke workspace bindings without taking over their identity. Revocation
invalidates outstanding actor capabilities and wins under the same binding
lock as decisions. Organization/user deletion cascades binding secrets,
challenges and private actor confirmations according to §6. Membership removal
or role/grant changes need not delete identity
metadata, but immediately remove decision authority.

Expose own binding in the existing Settings → Notifications location without
adding duplicate settings or sidebar destinations. Ordinary members/editors
must be able to read/create/confirm/revoke their own binding. Keep credentials,
webhook setup, organization history and digest controls manager-only, including
their current endpoint guards. A shared page can show the own-binding section
and conditionally fetch/render manager controls; a page visit must not grant
access to configuration APIs. Own-binding endpoints derive the user from a real
session, never an arbitrary requested user ID.

Possession of a leaked start link proves neither Pubrick account ownership nor
consent. The web confirmation protects that boundary; the user must recognize
the displayed Telegram identity. Rate limits, short expiry and safe display
remain necessary against challenge flooding and misleading display names.

### Maintained authentication alternatives

Evaluate Telegram's current official OIDC login and Better Auth's maintained
Generic OAuth plugin rather than adopting the archived login widget or writing
a custom OAuth/JWT/signature verifier. Pubrick already uses Better Auth 1.7.1;
the workspace also contains maintained `jose` 6 for needs outside the auth
plugin. Those are the preferred building blocks if provider identity login or
account linking becomes a separate product feature.

OIDC is not required as a second binding flow for this initial slice. It needs
BotFather OIDC client registration and allowed URL configuration, whereas the
proposed Start + real Pubrick-session confirmation works with the existing
organization bot and proves an actual reachable private chat for confirmation.
The latter is a narrow product capability, using existing Node crypto for
random opaque codes/hashes, shared Zod validation, existing Bot API transport
and Better Auth session checks. It is not a homemade authentication engine or
signed Telegram login protocol. Do not add a bot framework merely to parse two
strict inbound update shapes.

Future OIDC linking must verify issuer, audience, nonce/state and tokens through
the maintained plugin, preserve existing account-linking/session security, and
explicitly prove any mapping to Bot API user identity. Telegram's official
examples use an OIDC `sub` and Telegram user ID that differ: never assume
`sub === callback_query.from.id`, convert one into the other or make a username
their common key. An OIDC identity alone also does not prove the user has opened
a private conversation with this organization bot. Reconcile those independent
claims through an explicitly verified provider contract before authorizing a
callback or sending a private confirmation.

## 4. Notification and private confirmation capabilities

For an active bot and eligible draft, replace the existing **Reject** URL button
with one **Reject** callback button. Keep Review, Schedule and Publish URLs. For
disabled or ineligible interactive handling, retain the existing Reject URL
fallback; never display duplicate rejection controls. The sender creates the capability before network
I/O and binds it to organization, bot generation, destination chat, item/brand,
snapshot hash/version and an expiry no later than 30 minutes. Store only its
token hash. Use 32 random bytes encoded base64url with a short fixed action
prefix: the UTF-8 callback value must fit the Bot API's 1–64 byte limit.

This initial capability starts confirmation only. It may serve more than one
authorized editor without allowing the first unbound or unauthorized group
member to consume everyone else's opportunity. Bound pending confirmations
per item/editor, webhook update and organization; expired capabilities cannot
issue new confirmations. After a terminal decision, invalidate the initial
capability and all sibling confirmations.

For an authenticated initial callback:

- Require the expected bot generation and original destination message/chat;
  inline-message callbacks and inaccessible message variants are refused.
  Record the original message ID from a confirmed send. For an unknown send,
  accept its first observed message ID only under the same authenticated
  bot-message/chat/token checks described for private confirmation below;
  never automatically resend to obtain an ID.
- Resolve `callback_query.from.id` to a current binding and freshly authorize
  workspace membership, brand access and editor capability. Group chat ID is
  not user identity. Refuse unbound/unauthorized senders with generic guidance
  to account settings; expose no draft body or another user's identity.
- Compare the initial snapshot to current eligible content before issuing a
  private actor-specific confirmation. Do not refresh silently after an edit.
- Send the confirmation only to that binding's private chat. Show draft title,
  brand, a bounded safe excerpt and a **Review in Pubrick** URL, then explicit
  **Reject** and **Cancel** controls. The heading and disclosure make this an
  explicit confirmation of the displayed draft. Telegram metadata/excerpts are
  an additional disclosure to the configured bot provider; make opt-in clear.

The final capability binds the initial snapshot and action to the exact
organization/bot/binding/user/private chat. Forwarding it to another chat or
clicking as another actor cannot apply it. Acknowledging Cancel consumes only
that actor's confirmation; it changes no content or queue.

Private confirmation delivery uses one claimed send attempt. Preserve
sent/rejected/unknown outcomes and retain a returned message ID when available.
An unknown send is not automatically repeated. If the message actually arrived,
its capability can still be confirmed only by its bound actor, in its intended
private chat, from an authenticated callback on a message sent by the same bot.
When the send response lacked a message ID, that validated callback can record
the observed ID under the capability lock; arbitrary caller-supplied IDs cannot
complete this reconciliation. This rule must receive a native regression test.

## 5. Snapshot and fresh-draft eligibility

Extract the existing client-review snapshot projection and hash into a shared
API domain helper. Preserve byte-for-byte hashes for previously issued client
review links, including conditional omission of zero image revision and absent
video. Do not introduce a parallel incomplete Telegram serializer. Keep explicit
projection fields and stable adaptation ordering; the existing hash covers
title, master, cover/video identity, image revision and channel adaptation IDs,
names, platforms and effective bodies.

Telegram capabilities additionally bind item ID, brand ID, organization, action
and hash version. Status and delivery eligibility are fresh predicates, not a
reason to change legacy client-review hashes. Require at final consumption:

- Parent status exactly `draft`; the item and every channel/adaptation still
  belong to the bound organization and brand, with an active target channel.
- Every adaptation is `pending`, unscheduled, with zero attempts; no active
  claim, publication receipt/history, queue-backed delivery or manual-ready
  handoff. Unknown or historical delivery evidence is a refusal.
- The parent `is_safe_to_delete` marker must be true. Existing deletion uses
  this durable marker to remember delivery history after channel/adaptation
  removal and to refuse unverifiable historical rows. Zero receipts among
  surviving adaptations alone does not prove no publication history.
- At least one current adaptation, a matching complete editorial snapshot,
  and current actor/binding/bot authorization.

Refuse approved, rejected, failed, archived, scheduled, published and partially
published content. The existing web rejection workflow still owns its broader
cases. A stale Telegram confirmation asks the person to review the current draft
and start again; it never rejects newer content based on an old notification.
Do not stamp `firstOpenedAt` merely because an alert or callback was received.

## 6. One atomic domain decision and lock order

Extract `ContentRepository.reject` into a transaction-taking domain method such
as `rejectInTx`, with the existing public wrapper preserving its return shape,
guard semantics and broader behavior. Telegram does not call a second rejection
implementation, nest an independent transaction, or fabricate session cookies,
session IDs or `RequestAuthority.kind = "session"`.

Extract/reuse the common member/brand/editor policy separately from authentication
proof. Telegram supplies a narrowly typed verified binding actor, not an API key
or synthetic Better Auth session. Under database locks, recheck actual user,
hosted ownership requirements, unioned current membership roles, editor capability
and brand grants. Hold the relevant user and member rows `FOR SHARE` or stronger
through decision commit, after the canonical parent locks. Existing
`authorizeRequestActor` reads member roles without row locks; extracting its
policy alone does not serialize role revocation. Lock and recheck scoped brand
grants consistently with grant replacement. A persisted binding must never
freeze a revoked role or grant.

The proposed chain must pass independent review against `docs/lock-order.md`:

```
organization → user → brand → member / brand_access → bot configuration / binding
  → adaptations (sorted IDs) → channels (sorted IDs, FOR SHARE) → content_items
  → publication evidence (existing rejection path) → callback capability / inbox / audit
```

Read candidate IDs without locks first; then acquire and revalidate scoped parent
rows. The critical domain order is **adaptations before content_items**, matching
archive, publication worker and `lockItemForLink`. `requireItem` currently checks
existence; it must not become an early item lock. Brand grant writers take brand
before member/grant rows. Do not prescribe member locks before brand or add brand
lookups to role-change triggers. Bot and binding writers never take domain locks
after holding callback rows; disconnect/revocation use parent-first ordering.
The deletion strategy below fixes the new-table cascade boundary; every actual
migration and concurrent deletion path must still prove that boundary natively.
The channel lock is mandatory for both capability issuance and consumption:
the shared snapshot includes channel name/platform, while channel name edits
do not take adaptation/item locks. `FOR KEY SHARE` does not block a non-key
name update; use `FOR SHARE` or stronger and construct the compared projection
from those same locked rows. Hold item/adaptation mutation locks while reading
the snapshot, rather than comparing an earlier unlocked projection.

Within that one transaction:

1. Authorize the binding actor and lock domain parents in canonical order.
2. Re-read the complete snapshot and fresh-draft/delivery predicates under those
   locks. Lock the capability last; recheck expiry, ownership and consumption.
3. Apply the existing `rejectInTx` transition, including applicable cancellation
   and prompt decision evidence. Telegram eligibility adds restrictions and
   never removes existing domain protections.
4. Consume the one-shot capability, invalidate sibling confirmations, and commit
   immutable scoped decision evidence plus `(internalBotIdentityId, updateId)`
   replay identity. The internal ID is the registry's opaque identity reference,
   not a duplicate Telegram bot/user numeric ID.

The audit includes immutable scoped resource IDs, opaque Pubrick actor/binding
reference IDs, action, snapshot hash/version, bot generation, consumed capability
ID, update identity, outcome and timestamp. Pubrick user IDs are opaque `text`,
not UUIDs. Neither audit nor minimal replay evidence stores Telegram user IDs,
chat IDs, names, raw content, secrets, callback data or full updates.
Sibling invalidation uses stable ID order. All callback writers needing domain
locks follow the same order; cleanup cannot hold a callback lock then wait for
its content parent. A transaction rollback leaves no rejected item, consumed
capability or accepted replay receipt behind.

### Deletion and cascade strategy

| New record | Parent references and removal |
| --- | --- |
| Binding, binding challenge, private actor confirmation | Direct organization and Pubrick user references with `ON DELETE CASCADE`; no member reference |
| Initial notification capability | Organization `ON DELETE CASCADE`; no user reference |
| Minimal decision audit and replay receipt | Organization `ON DELETE CASCADE` only; immutable scoped resource and opaque actor/reference IDs have no deleting user/resource/binding FK |
| Global bot ownership/remote-mutator registry | Nullable owner organization with `ON DELETE SET NULL`; bot claim and unsettled remote evidence survive tenant deletion in disabled quarantine |

Do not add nested binding → capability or resource → capability cascade paths.
Validate those immutable reference IDs, ownership and actor evidence under the
decision's parent locks instead. Membership removal can revoke authorization
without accidentally cascading historical evidence or a pending capability
through a different lock order. User deletion removes directly owned identity
and confirmation rows but does not erase or rewrite minimal opaque decision
evidence; it contains no retained Telegram personal identity to pseudonymize.

An organization `BEFORE DELETE` trigger takes its owned registry rows in sorted
bot-ID order, disables them and quarantines any unresolved remote-mutator lane
before tenant secrets disappear. It performs no network call and never releases
a bot ownership reservation through a cascade. The owner FK then becomes NULL.
A late provider completion may update quarantine evidence only, never activate
a deleted tenant, restore a binding or release an unresolved claim automatically.
The global registry must not retain tenant bot credentials or Telegram human
metadata merely to make cleanup convenient.

Define this fixed record order in the migration and bounded janitor: global
registry → binding challenges → bindings → initial notification capabilities
→ private actor confirmations → minimal replay receipts → decision audit.
Sort rows by stable ID within each tier, using canonical sorted bot IDs for the
registry. Review actual cascade constraint/trigger behavior against this order;
do not assume direct FKs alone prove it. No cleanup
writer can acquire a user, organization or domain parent after a capability row.
User deletion must not acquire organization locks after holding the user row;
organization deletion must not acquire user rows. Direct user/organization
cascades must follow these rules without introducing reverse parent locks in
triggers. A migration commit requires independent source review and native
coverage of its changed constraints/triggers and every writer implemented in
that milestone. Migration 0128 has storage/cascade foundation evidence; 0129
changes only setup-generation recovery and additionally requires overlapping
tenant deletion/provider-completion evidence. Neither milestone establishes
janitor or atomic draft-decision safety. Before enabling those later writers,
require their native overlapping-delete, janitor/decision/revocation tests
against the integrated schema. Keep this full feature gate open until all
writers exist and pass; staged storage/backend acceptance cannot close it.

Current Better Auth organization deletion issues member deletion, invitation
deletion and organization deletion as separate autocommit operations: the
installed Drizzle adapter's transaction option defaults false. Do not describe
that current sequence as a transaction holding member locks while waiting for
the organization row, or claim a reproduced deadlock from sequence order alone.
If a future adapter configuration wraps the sequence in one transaction, acquire
the organization parent lock at transaction entry before deleting members; an
independent earlier before-hook cannot keep that lock through a later transaction.
User self-deletion is currently disabled, but actual raw SQL user deletion and
its FK cascades still require proof; an unavailable UI is not a cascade guarantee.

Concurrent confirmations, duplicate updates and replay after an uncertain HTTP
response acknowledge one durable result. A reused update ID with a different
bounded request fingerprint is refused. Recheck actor visibility before returning
any existing receipt; use a generic acknowledgment after revocation. Distinguish
terminal refusal from infrastructure failure. No replay can enqueue publication,
call a model or repeat a prompt decision.

Webhook acknowledgment and `answerCallbackQuery` occur after database outcome.
Failure to acknowledge or edit a Telegram message cannot undo or repeat the
decision. Message edits are best-effort display cleanup. A browser receipt and
notification history must present the durable result even if Telegram still
shows an old button.

## 7. Bounds, retention and operational states

Use strict shared schemas for setup, status, binding and callback admission.
Reject bot senders, unsafe numeric identity conversions, arbitrary routes,
oversized bodies and missing message provenance on supported operations.
Classify unrelated update types as unsupported and ignore them as specified below.
Keep decimal IDs lossless; do not conflate signed chat IDs with user IDs.
Restrict accepted updates to private `/start` binding/probe messages and callback
queries; unrelated messages neither store content nor change domain state.

The proposed first-release defaults are concrete product bounds, not Telegram
throughput guarantees, provider prices or a promise of universal server capacity:

| Admission | Default bound |
| --- | --- |
| Binding challenge | Expires five minutes after issuance |
| Challenge issuance | At most five per user and 100 per organization in each rolling ten-minute window; both apply atomically |
| Initial/final callback capability | At most 30 minutes; a final confirmation never outlives its initial capability |
| Pending final confirmation | At most one live confirmation per item/editor |
| Live capabilities | At most 2,000 per organization, including initial and final capabilities |
| Recognized authenticated supported updates | At most 10,000 per organization in each rolling hour |
| HTTP request body | At most 64 KiB before field validation |
| Quarantined bot identities | At most five unresolved identities per organization; refuse additional setup that would exceed this bound |

Check expiration and rolling windows using the database clock. Admission counters,
live-capacity reservation and supported-update replay registration are atomic
across replicas. Existing duplicate update receipts do not consume fresh update
capacity; replay acknowledgment cannot perform another domain operation. A failed
capacity reservation returns 503 with no accepted receipt or partial mutation;
Telegram may retry it later. Web challenge issuance uses a coded rate-limit
refusal rather than pretending a challenge was created. Do not truncate queued
work or remove a quarantined ownership claim to make a quota pass.

Unauthenticated requests and authenticated unsupported update shapes neither
persist their full payload nor mutate domain data. Unsupported updates return a
deterministic 2xx without a journal; the durable acceptance rule applies only
to recognized operations. Enforce the byte limit before Zod field validation,
and parse decimal identities canonically without lossy numeric conversion.
Invalid secrets, over-limit bodies and invalid identity shapes are rejected
before supported-operation admission. Bound transport deadlines/connections
using the existing integration patterns; a deadline is not a remote lane lease.

Sweep expired challenges and their candidate personal metadata no later than
24 hours after terminal completion/expiry. Retain minimal supported-update replay
receipts for seven days. Sweep expired or terminal unconsumed capability token
hash rows after seven days; remove consumed capability secret material on the
same schedule without deleting its minimal decision evidence. Bounded parent-safe
janitor batches must satisfy these deadlines and remain observable on failure.
An ephemeral challenge/capability/replay row must not be a cascading owner of
the immutable decision audit.

Keep minimal applied-decision audit until organization deletion under the
opaque evidence policy in §6, without raw source text, provider secrets,
Telegram identity/chat/name, callback tokens or full updates. User deletion
cascades its binding/challenge/private-confirmation rows, while the organization-
owned minimal opaque audit survives. Expired capabilities and
fresh-draft eligibility still prevent an old update from applying after replay
receipt retention; an absent old receipt cannot mint a new capability.

An unknown remote-mutator attempt and its bot identity reservation never become
releasable through lease expiration, routine retention or janitor cleanup.
Beyond the quarantine bound, refuse new setup and expose an operator path to
diagnostics or a separately reviewed credible provider recovery procedure.
No automatic remote completion barrier is invented here. Retention applies to
Pubrick data only, not Telegram-held messages or provider logs.

Settings distinguish disabled, validating, ownership conflict, setup uncertain,
active and disconnect uncertain. Human binding states distinguish awaiting
Telegram, awaiting web confirmation, linked and revoked. Keep secrets write-only;
offer explicit reconciliation and unlink controls with clear consequences.
English-first copy and all supported locales are required before release.

## 8. Required acceptance evidence

Implementation is not accepted from outbound notification tests alone. Require:

1. Official transport contract tests for bot identity, owned/foreign webhook
   checks, secret authentication, uncertainty fencing, safe errors and callback
   byte bound; no live bot setup during ordinary automated tests.
2. Native inbound identity uniqueness and outbound-sharing isolation across organizations,
   token rotation, disconnect/setup races and late provider responses. Prove an
   old delayed install/delete cannot overwrite an enabled successor, and an
   unresolved remote lane cannot be stolen after a lease expires or restart.
3. Two-phase binding tests: Telegram claim alone cannot bind; wrong Pubrick user,
   expired/used challenges, group `/start`, reused Telegram identity and unlink
   races are refused without leaking another person's identity.
   Cover exact expiry/rolling-window boundaries and concurrent capacity admission,
   seven-day replay/capability cleanup, challenge metadata erasure, quarantine
   retention and supported-versus-unsupported webhook acknowledgments.
4. Native authorization and snapshot races against member removal, role/grant
   replacement, bot/binding revocation, body/title/adaptation/media changes,
   channel rename/deletion, approval/publication claim and item deletion. Include
   removed-channel publication history and a false historical safety marker. Prove actual
   lock waits and outcomes without weakening domain tests.
5. Concurrent duplicate final callbacks and different editors produce exactly one
   rejection/prompt decision/consumption audit. Rollback and transaction/storage
   failure leave no partial mutation. Include canceled confirmation, forwarded
   group/private messages, wrong actor, missing message and unknown-send recovery.
6. Legacy client-review hash fixtures and existing web approval/rejection suites
   remain unchanged in meaning. No publication, generation or paid call is
   admitted by any Telegram button in this slice.
7. A compiled disposable API/worker/web journey: manager configures synthetic bot,
   user links both accounts, notification is emitted, group button starts only
   private confirmation, explicit confirmation rejects the exact fresh draft,
   UI receipt shows durable result and stale/duplicate callback is harmless.
   Include mobile/keyboard binding and revocation flow. No actual Telegram send
   or publication is needed to prove this journey.
8. A separately authorized sandbox bot check proves reachable HTTPS/webhook and
   real Telegram event shape before claiming production interoperability. Local
   fixtures are not evidence of a live bot installation.

Maintain native mutation proofs for final snapshot comparison, actor reauthorization
and one-shot capability consumption. Run focused checks during construction and
one coherent integration milestone; retain failures and affected closures.

## 9. Open review gates and sources

The original gates covered inbound ownership/outbound isolation, native
user/tenant deletion and janitor ordering, legacy snapshot compatibility, atomic
rejection/actor evidence and uncertainty UX. Their local evidence is recorded
in the receipts above. They do not establish live Telegram interoperability,
full external publish operations or exact microsecond equality boundaries.
Remote mutation uncertainty without a provider completion barrier is an explicit
operational limitation, not a solved recovery guarantee. The reviewed initial
implementation may operate one unchanged setup generation, but must remain
blocked for incompatible remote changes when a predecessor is unresolved.

Bot API facts used here are based on the official
[Bot API reference](https://core.telegram.org/bots/api), including `getMe`,
`setWebhook`, `getWebhookInfo`, callback queries, `answerCallbackQuery`, protected
webhook secret headers and 1–64 byte callback data. Webhook retries require
idempotent durable admission; webhook and `getUpdates` are exclusive modes.
Binding payload limits and allowed characters follow official
[bot deep linking](https://core.telegram.org/bots/features#deep-linking).
The maintained auth alternative is described by official
[Telegram OIDC login](https://core.telegram.org/bots/telegram-login) and
[Better Auth Generic OAuth](https://better-auth.com/docs/plugins/generic-oauth).
Reverify official contracts during implementation rather than guessing from an
old SDK or treating this proposed design as delivered functionality.
