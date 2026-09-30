# Hosted workspace admission

Hosted deployment uses first-party transaction boundaries for organization and
invitation mutations. Better Auth continues to own sessions, authentication,
verification and reset tokens. Its independent organization adapter calls are
not an atomic subscription/seat admission boundary.

The initial hosted BYOK beta has **no free trial**. The operator configures the
central billing authority and account admission limits; this repository neither
creates a second subscription store nor invents a trial duration.

## Ownership and transaction contracts

`HostedAdmissionRepository` in `packages/db/src/hosted-admission.ts` accepts a
current `userId` and `sessionId` from the authenticated server context. Every
mutation re-reads the unexpired session and verified user inside its transaction.
Caller-provided addresses are never used as actor identity. An invitation is
accepted only by its current verified recipient; consumed invitations additionally
bind replay to the original user ID through `hosted_invitation_acceptances`.

The controller validates its request DTOs and passes an explicit organization ID.
Create and invitation acceptance do not require an active organization. Other
mutations require existing membership and the permissions below. The repository
is still authoritative if an upstream guard or active organization changes.

- Owners and admins can invite all supported roles except that only an owner
  can invite an owner. An ordinary member can invite `member`, and cannot resend.
- Owners, admins and ordinary members can cancel invitations. Author/editor
  roles have no invitation permissions.
- Owners and admins can remove members; only an owner can remove another owner,
  and the final distinct owner account cannot be removed.
- Owners/admins can edit supported multi-role assignments. Only owners can grant
  or alter ownership; demoting the last distinct owner is forbidden. Any member
  can leave, provided another owner remains when the departing account is an owner.
- Only an owner can delete a workspace. Expired entitlement cannot prevent
  cancel, removal, deletion, export or billing access.

Existing organization writes first acquire the shared
`RUN_ADMISSION_LOCK_NAMESPACE` / `hashtext(orgId)` transaction advisory, then
`FOR UPDATE` on the organization, recipient quota locks when granting ownership,
and acting session, verified account and domain rows. Billing, AI selection and
generation use this same advisory before tenant rows; reentering it inside the
billing port is safe. Never take an organization row before that advisory. Creation instead
acquires the account advisory lock (hash seed `39427`), acting session/account,
then creates a new organization that is private to its transaction. Existing
organization mutations that grant ownership acquire sorted recipient account quota
locks after the organization, before the acting session. Creation never locks an
older organization, so this order cannot form an organization/account lock cycle.
Owner invitations to known accounts, owner acceptance and owner role grants all
check the same current-owned-workspace cap under that recipient quota lock.

Injected database-only ports must use this exact Drizzle transaction:

- `authorizeGrowth` locks and validates the central entitlement/seat authority.
  Create receives a new organization and one owner seat. Invite receives distinct
  occupied seats and zero or one additional seat. Accept converts a reservation
  and receives zero additional seats. The port owns billing policy.
- `enqueueInvitation` inserts the encrypted durable pg-boss event atomically with
  the invitation, including backlog admission. It receives the committed-to-be
  invitation ID, organization, recipient, role, expiry, inviter and validated
  locale. A failed/null enqueue must throw, rolling back all domain writes.
- `stageDeletion` stores the billing deletion tombstone in the same transaction
  before deleting the organization. No external payment call occurs under locks.

Do not call Better Auth organization endpoints or SMTP inside these ports.
Raw hosted mutation routes, including member role edits, must either delegate to
this locked boundary or be denied. Server-only `addMember` is not an exemption.

## Seats and account abuse limits

One distinct member account reserves one seat. One distinct unexpired pending
email not already represented by a member reserves one further seat. Address
comparison is case-insensitive. Replacing an invitation cancels older links for
that address and writes a new link/event without reserving a second seat.
Acceptance is idempotent for the original recipient and preserves an existing
member's role; it never inserts another membership or escalates its role.

`maxOwnedWorkspaces` limits current owned organizations.
`maxCreationsPerDay` limits account creations in a rolling 24-hour window,
including workspaces subsequently deleted. The durable creation claim stores
only user ID and timestamp. Old claims are pruned during creation; idle accounts'
expired claims may remain until the next sweep/creation, and operations must run
periodic expiry cleanup before claiming strict physical 24-hour retention.
Deletion does not create a permanent lifetime ban. No legacy member deduplication
or global `(organization,user)` uniqueness constraint is introduced.

Removing an account clears the acting session only when removing oneself.
Deleting a workspace clears the acting session only. Other sessions can retain
a stale active-organization pointer; membership/organization guards must reject
it. This matches the existing session model and avoids cross-workspace session
lock cycles caused by bulk updates to other accounts' sessions.

## Integration and verification

Migration 0121 must be generated after the predecessor Vertex migration 0120 is
frozen; schema source alone is not a deployed feature. Composition, raw SDK denial,
request validation, billing and the transaction outbox bridge belong to the API
integration. The new domain service is deliberately not independently enabled.

Focused unit contracts cover account caps, distinct seat counting, invitation
roles and final-owner protection. The database tier covers concurrent create and
last-seat invitation races, enqueue rollback, consumed invitation replay,
verified/revoked sessions and deletion tombstone rollback. Database claims require
a disposable PostgreSQL run after migration integration; skipped suites are not
verification evidence.
