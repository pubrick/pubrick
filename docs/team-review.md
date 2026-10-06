# Team responsibility

Assign a saved post to a current workspace member from the post's **Responsibility**
card. The queue's **Mine**, **Unassigned**, and **All posts** filters combine
with its status filter. Both filters run on the server before pagination, and
they never grant access to another brand.

Owners, admins, members, and editors with access to the post's brand can change
responsibility. Authors can read the assignment and its history. The picker
lists each eligible account once; managers can access all brands, and other
members need an explicit brand grant. Assignment does not approve, schedule,
publish, edit text, or change an existing publication job.

## Removed access

A removed membership or revoked brand grant leaves an unavailable assignment.
It appears under **Unassigned** so editors can recover it. Its saved display name
and membership identity remain in the assignment history. A person who rejoins
with a new membership does not automatically regain old assignments. Choose
their current membership or clear the assignment explicitly.

## API

- `GET /api/content/:id/assignment` returns the saved revision, current assignee,
  eligible members, and up to 20 history entries, newest revision first. Pass its
  `history.nextCursor` as `?cursor=` to read the next page.
- `PUT /api/content/:id/assignment` accepts
  `{ "memberId": "current-membership-id", "expectedRevision": 0 }`.
  Use `memberId: null` to clear responsibility. The revision is independent of
  the post's text/media revisions. A stale revision returns HTTP 409
  `assignment_changed`; an unavailable target returns HTTP 400
  `assignment_member_unavailable`. Reload before another attempt.
- `GET /api/content?assignment=mine|unassigned|all` keeps the existing bare array
  and `X-Next-Cursor` contract. **Mine** always uses the authenticated account;
  the client cannot supply another assignee user ID. List rows include an
  assignment summary and never include post bodies or assignment history.

Each real change increments its revision and appends one history entry in the
same transaction. Repeating the already-saved selection with the current
revision is a no-op. Assignment data and history are included in workspace
exports; they contain no email addresses, API credentials, or copied content.
