# Telegram draft decision execution plan

Status: foundation and setup/binding backend implemented; callback and UI acceptance pending.
Date: 2026-10-01. Tracking: `Ozon-tools-0mflt` (design),
`Ozon-tools-ru3m0` (foundation), `Ozon-tools-4pvvm` (setup/binding).
Design: [0013](../specs/0013-telegram-draft-decisions.md).

Foundation evidence is recorded in
[the integration review](../reviews/2026-10-01-telegram-foundation.md).
Setup/binding evidence is recorded in
[the backend review](../reviews/2026-10-01-telegram-setup-binding.md).
The backend exposes manager setup/disable and member-owned two-phase binding,
with real session authority, bounded update admission and scripted Bot API
transport. It does not enable draft callback decisions or settings controls.
Retention workers, locked final decision authorization and UI remain required.
Bot ownership transfer/release remains deliberately unsupported.

Independent source review closed three concrete findings in the proposal:
external webhook mutations need a durable per-bot lane across uncertain results;
snapshot checks need mandatory channel and membership locks; fresh-draft
eligibility needs the durable marker for delivery history lost through deletion.
This closure does not establish executable lock safety or provider interoperability.

## Foundation before callbacks

Concrete issuance/live-capability quotas and retention are now specified in
design 0013. Independent source exploration also defines a direct-cascade
strategy and a quarantined global bot registry that survives tenant deletion.
Review and prove user/organization deletion and every actual new cascade before
committing a migration; the proposal alone is not native evidence.
Use the next available migration number from the integrated journal. One owner
owns shared strict contracts, bot mutation-lane/identity tables, scoped binding
challenges, capability/replay/audit storage, export/cleanup inventory and native
constraints. No bot network request occurs while holding database locks.

Keep setup disabled until verified bot ownership and a confirmed generation
allow it. An unresolved remote request blocks incompatible mutations and owner
release; a local timeout never fabricates remote completion. A new verified bot
may recover service while the old identity remains quarantined. Confirm these
state-machine boundaries with scripted transport before wiring settings.

## Reuse domain rules and prove admission

One API owner extracts the existing complete client-review snapshot without
changing old hashes, separates common editorial policy from session proof,
and extracts rejection into a transaction-taking method. Preserve web behavior
and adaptation-before-item locking. Telegram authority comes only from the
verified binding, authenticated bot generation and exact capability.

Implement two-phase binding, inbound bounded update admission, initial private
confirmation and atomic final rejection as one coherent backend slice. Recheck
membership, brand grant, binding, bot generation, full snapshot and durable
unsent history under the reviewed locks. Commit one result, capability consumption
and replay evidence with the domain mutation. Acknowledgment failures cannot
repeat rejection or prompt decision evidence. No Telegram action admits delivery,
generation or model calls in this slice.

Run focused contract and native race/replay checks during construction. After
the native baseline is stable, use the project's three-run proof protocol for
the selected snapshot, actor authorization and one-shot consumption guards.
Do not call mocked method order a concurrency proof.

## One settings location and one rejection control

One UI owner exposes the member's own binding at Settings → Notifications,
with existing manager configuration/history/digest APIs still protected.
Use the shared design system, English source copy and all supported locales.
An eligible active bot notification replaces the existing Reject URL with one
Reject callback. Inactive/ineligible modes retain the URL fallback. The callback
opens actor-specific private confirmation; only its explicit Reject applies
the decision. Review, Schedule and Publish stay authenticated web links.

Show durable setup uncertainty, linkage/revocation and decision outcomes without
secrets, raw updates or misleading resend controls. Validate mobile/keyboard
linking and revocation with synthetic identities.

## Integrate once and record limits

Run the affected package gates and one compiled disposable API/worker/web
journey with scripted Telegram transport. Require account binding, notification,
private confirmation, exact fresh-draft rejection, durable receipt and harmless
duplicate/stale callbacks. No real Telegram message is required for local
acceptance. Run an independently authorized real sandbox before claiming live
webhook compatibility.

Independently review the coherent implementation and native evidence, update
user/operator guides only after actual acceptance, and push the verified feature
milestone. Release to main requires separate exact-head approval. The proposed
design is not an available user workflow.
