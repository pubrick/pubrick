# Telegram setup and account binding backend

Scope: the second implementation milestone for
[design 0013](../specs/0013-telegram-draft-decisions.md), built on the
[storage foundation](2026-10-01-telegram-foundation.md). This feature branch
exposes backend routes, but has no settings controls or draft decision callbacks.
No publication, generation, payment or live Telegram request was made.

## Implemented boundaries

Managers can inspect, install and disable an interactive bot using the existing
notification credentials. Verified `getMe` identity, foreign-webhook checks,
revision comparisons, encrypted frozen requests and a physical attempt ledger
control installation. Provider calls occur outside database transactions.
Identical retries preserve their request bytes and cannot erase an older unknown
attempt. Local disable takes effect before provider cleanup or credential
parsing. A late provider completion cannot enable a disabled or deleted tenant.
Unknown predecessors remain quarantined; recovery uses a different verified bot.
Same-bot generation changes and ownership transfer remain unavailable.

Credential replacement shares the setup advisory lock even before configuration
exists, and an enabled interactive bot must be disabled before its token changes.
The existing outbound notification sender retains its URL-only API.

Members bind their own account through a short-lived private `/start` challenge
and a separate confirmation in a real Pubrick session for the issuing user.
Organization/user/session/membership reads prove current authority; no Telegram
session is invented. Authors/editors gain only this own-account exception to
organization-wide mutation restrictions. Active bindings require unlink before
replacement; disable revokes pending challenges and bindings.

Inbound admission authenticates the secret header before parsing, rejects
ambiguous headers, bounds raw bytes to 64 KiB and accepts only safe integer IDs
from private human chats. Recognized updates persist deduplication evidence;
quota failure returns 503 without claiming a challenge or accepting a receipt.
Unsupported callbacks/group/bot updates have no journal or domain write.
Issuance limits are atomic. Expired challenge cleanup is bounded and
opportunistic; an unattended retention deadline is not yet enforced.

Migration 0129 only replaces the setup configuration frozen-generation trigger.
It permits a different owned bot after disabling the predecessor, preserving
unknown old physical attempts. It changes no table or cascade inventory.
Generated Drizzle metadata remains linear. Independent migration review cleared
source and changed-path native coverage. The staged specification explicitly
keeps janitor/decision/revocation acceptance open until those writers exist.

## Review findings closed

- Setup and token replacement now share the absent-configuration advisory lock.
- Disable commits its local state before decoding possibly corrupt ciphertext.
- Authenticated group/bot starts are ignored before private identity validation.
- Test fixtures insert aged immutable records rather than rewriting timestamps.
- Synthetic setup bot IDs no longer reuse fixed identities across retained runs.

Independent source review found no remaining blocker for this backend milestone.
It is not acceptance of the complete Telegram decision feature.

## Local evidence

All PostgreSQL fixtures used an owned loopback database and pinned
`pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b`.
The Bot API boundary was a local synthetic HTTP server.

- Setup/binding native suites: 13 passed. Covers real sessions, role boundaries,
  private identity binding, replay mismatch, concurrent issuance quota, byte
  admission, foreign webhook refusal, exact retry, same-bot refusal and
  different-bot recovery. A provider barrier proves disable wins a late response.
- Added tenant deletion/provider completion overlap: 1 passed, 5 intentionally
  unselected cases. Orphaned bot remains disabled/quarantined, tenant config is
  erased, and late completion changes only retained physical evidence. This is
  provider-I/O overlap, not by itself a DB lock-order proof.
- Fresh migration through 0129 and storage/cascade constraints: 6 passed, including
  actual overlapping raw user/organization deletion.
- Existing notification repository/summary, editorial roles and update parsing:
  15 passed in a separate native/unit gate.
- Integrations package: 141 passed, including seven new typed transport cases.
- Shared binding/setup DTO selection: 6 passed.
- Workspace typecheck: 20 tasks passed. API production build passed.
- Repository lint: 1,093 files passed.

The first native run exposed a test bootstrap static import and an illegal
fixture timestamp update. A subsequent closure attempt encountered reused bot
ownership plus a bootstrap timeout while workspace builds competed for CPU; it
was terminated after a provider barrier could not be entered. These runs remain
failed evidence. The corrected selected runs above supply composite acceptance,
not an all-green initial full suite. Production browser journeys and the full
monorepo suite were not rerun for this backend-only milestone.

Local logs are retained under
`/Users/admin/.codex/backups/pubrick-validation-20261001/`, with initial failures
and closure runs in separate files. No real secrets occur in committed fixtures.

## Remaining work

Implement bounded background retention, settings controls, notification
capabilities, actor-specific private confirmation and atomic rejection with
current membership/brand/snapshot/unsent-history checks. Their native race,
deletion and replay gates plus a compiled browser/API/worker journey remain
required. Live webhook compatibility needs an authorized sandbox.
