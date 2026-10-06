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

## Review and approve a selection

Editors and managers can select up to 20 individually loaded, unsent posts in
the content queue. The first selected post fixes the brand; other brands show a
disabled checkbox and an explanation. **Clear** starts a different selection.
Loading another page does not automatically select its posts.

**Review** shows the saved master, the exact channel text loaded by the publisher,
the saved channel name and platform, and attached media. Hashtags and call to
action are displayed separately as editorial metadata; they are not appended
again by the review screen. Inline article images retain their editor placement;
this preview does not promise that every platform embeds them.

A post that still requires individual editor opening, guest approval, image
review or delivery recovery shows its own explanation and **Open** link. Loading
the batch preview never stamps an imported or AI post opened. Already opened AI
content may be approved unchanged under the existing individual approval rules.
Manual platforms and previous delivery attempts require individual review in
this first batch workflow. The existing durable history marker also excludes
posts whose deleted channel erased a prior receipt's item link, and historical
posts whose unsent state cannot be proved.

Acknowledge each displayed post and every channel, then press **Approve**. This
queues the exact selection for immediate native delivery; it does not claim that
the remote platforms have published it. A changed version, destination,
connection generation, permission or delivery state refuses the complete
selection before any job is inserted. **Reload** discards every acknowledgment
and displays the current saved versions. The server preview expires after
15 minutes and is bound to the workspace, brand and reviewing account.

### API contract

- `POST /api/brands/:brandId/content/batch-review/preview` takes
  `{ itemIds: [uuid, ...] }` with 1–20 unique, visible IDs from that brand.
  It returns each saved snapshot and a per-post blocker. Its opaque `token` is
  `null` while any post is blocked. It writes no opened signals, statuses or jobs.
- `POST /api/brands/:brandId/content/batch-review/confirm` takes
  `{ token, reviewed: [{ id, fingerprint }, ...] }`. Every displayed current
  snapshot must be acknowledged. The response contains transaction-captured
  `queued` receipts and exact adaptation IDs/attempts.

Queued receipts report the current delivery counter used by the queue job's
identity, which is zero for a first send. The worker increments that counter
when it claims the physical delivery; approval does not start an attempt.

Both endpoints require editor capability and existing brand visibility. They
return `Cache-Control: no-store`. The shared strict schemas reject unbounded or
implicit “all posts” selectors. Ordinary individual approval and timed approval
continue through the same approval transaction helper.
