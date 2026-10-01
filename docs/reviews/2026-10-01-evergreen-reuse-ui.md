# Evergreen reuse UI milestone

Date: 2026-10-01. Source milestone: `92496bb9`, integrated as `0be0afca`.
Combined UI/browser candidate: `f1036a6f` on `codex/evergreen-draft-reuse`.
Design: [0012](../specs/0012-evergreen-draft-reuse.md).
Tracking: `Ozon-tools-3xwei`.

This is focused UI and source-review evidence. The integrated database/workspace
and compiled browser journeys remain pending. It is not a main release or a
provider/publication acceptance record.

## Implemented interaction

The existing content editor resolves unsaved master and adaptation changes before
opening reuse. Failed saves retain the edits. The existing compose route shows
an immutable saved-source preview, editable instructions, active same-brand
channels and one explicit paid confirmation. Cancel sends no admission request.
Conclusive source/channel refusals retain choices and offer an explicit refresh;
an uncertain outcome retains the confirmed request and its operation key.

Internal-source receipts use the paid retry path. The queue reads actual run
detail before choosing that path; ordinary generation retains bodyless retry.
Unavailable and erased attribution renders a safe marker without retained source
material or a misleading source link. Related live-run deletion refusals accept
only the bounded, validated receipt IDs supplied by the server.

## Recovery boundary and limit

A module-level registry retains the parsed, frozen confirmed DTO and operation
key before sending a request. Its namespace binds user, organization, operation
and canonical target UUID. An unresolved entry cannot be silently replaced;
an acknowledgement clears only its matching namespace and key. No source
preview, provider secret or session cookie is stored there.

Within the same tab's SPA lifetime, a login redirect and remount can recover the
original request without first reading a deleted source or original run. Changing
user or workspace cannot restore another identity's pending operation. Loading
identity data is withheld; resolved missing identity uses the existing login or
onboarding flow. Duplicate membership roles are combined for the retry action.

This is tab memory, not durable browser storage: a hard reload, tab close or
browser restart clears it. Server operation audit/replay remains durable, but
this UI milestone does not claim recovery of a lost browser key after that
lifetime. It does not automatically issue a replacement paid request.

## Focused verification

- 524 distinct affected cases across 13 files passed through a composite gate.
  The broad tier first passed 520 of 522; two failures were leaking test mock
  implementations. After explicit fixture restoration, the affected two-file
  tier passed all 53 cases. Two additional initial authentication-refusal cases
  and the mobile-footer closure passed in a ten-case affected tier.
- Web TypeScript, 28-file scoped Biome and diff checks passed.
- Independent source review closed resolved missing-identity blank screens,
  stale identity while loading, reader-first/author-second membership coverage,
  mobile Save/Discard/Cancel layout, channel repair and request recovery.
- Combined interface review at `f1036a6f` found no DTO, endpoint, attribution or
  retry-path mismatch. Source review is not runtime browser evidence.

Initial failures remain in `pubrick-reuse-ui-focused-identity-closure.log`.
Passing affected receipts are `pubrick-reuse-ui-focused-fixture-closure.log`,
`pubrick-reuse-ui-paid-auth-footer-closure.log` and
`pubrick-reuse-ui-final-typecheck.log` in the local temporary evidence directory.
The eight-case scripted-model fixture and browser TypeScript checks passed
separately; the actual compiled journey still requires execution.
