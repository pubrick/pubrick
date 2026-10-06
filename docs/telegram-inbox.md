# Telegram discussion inbox

The brand Inbox collects readable text replies to **saved, confirmed public
Telegram publications**. It does not claim direct-message access, a complete
account inbox, private publication discovery, protected content, or media-only
message support. LinkedIn and WordPress conversations are not supported.

## Read and triage

1. Open a brand, choose **Inbox**, then **Choose a publication**.
2. Select a confirmed public Telegram post and collect its discussion.
3. Review the collected text; use **Collect older window** to continue reading
   the provider thread and **More saved messages** to page local saved messages.
4. Explicitly mark the collected discussion read or resolved. New collected
   messages and provider edits reopen attention. These decisions are independent
   of content approval and publication delivery resolution.

Collection reads at most 50 raw provider messages per request, without AI calls.
Short and duplicate text remain distinct messages by their Telegram message ID.
Unreadable and media-only entries still advance the raw provider cursor. A full
window means another request may be available; an additional empty window can be
needed to establish exhaustion. Refresh starts a new latest window. Messages
outside the collected windows, later changes and deletions are not silently
inferred. Refresh before replying; the sender also rereads the exact message.

`inbox_conversations` stores the immutable discussion peer/root identity for a
saved publication. `inbox_messages` independently upserts scoped provider message
IDs and increments revisions only when saved text/edit state changes. Existing
`publication_comment_samples` and sampled AI analyses are not the inbox source
of truth. Read/resolve revisions are shared team state, not per-person read flags.

Server-side Open/Resolved/All filters run before paging. New collected discussion
activity sorts first. Append-only activity entries and a first-page high-water
cursor bound subsequent pages to the same activity window. Refresh includes
later collection activity; current read/resolve changes can affect filtered
membership and may require refreshing. The client deduplicates IDs, without
sorting each page locally. Message paging pins the first page's highest provider
ID; another conversation, tenant, brand or filter cannot reuse its cursor.

## Explicit human replies

Connect the workspace Telegram **user account** and configure `TELEGRAM_API_ID`
and `TELEGRAM_API_HASH`. Replies use this account, rather than the channel's
publishing bot. Authors may collect/triage their granted brands; editors and the
existing workspace manager/member roles may send explicit replies. An API key
cannot impersonate a human sender or settle a send receipt.

Select the complete saved message and write your reply. Pubrick checks the
current Telegram sender, shows its identity and asks you to review both the
selected message and your outgoing text. The five-minute sender preview is
bound to the real actor/session, brand and encrypted account generation; it is
one use. A reconnect, permission change, provider thread change or unseen message
edit requires fresh review. Long truncated messages must be handled in Telegram.

The API durably claims an actor-scoped operation UUID before network work.
Transport preflight verifies the canonical discussion and exact saved message.
Immediately before provider create, the API holds current organization, user,
session, membership, brand-grant, account, message and claim authority, rechecks
the database clock after lock waits, and refuses stale state. The maintained
`@mtcute/node` client sends plain text with an explicit reply target, thread,
`sendAs: "me"` and stable Telegram `random_id`. No custom protocol client or
automatic replies are introduced.

Retries of the same operation return the same receipt and never call Telegram
again. A confirmed send records its message ID/link. Pre-create refusals are
known not sent. A post-create timeout or lost confirmation is **unknown** and
blocks another send. Recording retries have PostgreSQL lock/statement limits and
a bounded local budget. If storage remains unavailable, the original durable
sending claim remains; it must not be interpreted as permission to resend.

After the bounded request window and a one-minute settlement grace, reload and
inspect the original discussion from the original sending account. Verify that
account again and explicitly acknowledge the provider inspection before stating
whether the exact reply was sent. A different account cannot settle the claim;
a reconnect to the same actual Telegram identity can. Client URLs/IDs are never
accepted as provider evidence. A known accepted message cannot be declared
absent. Human resolution refers to the exact receipt and never creates a reply.
Late completion cannot overwrite a newer human decision or another send claim.
Immutable provider evidence rows preserve received IDs/links even after a human
verdict. Canonical receipt fields are enriched only while null, and a differing
receipt remains separate evidence. A not-sent human verdict with later acceptance
is visibly contradictory, rather than silently rewritten. The original operation
still cannot send again. The provider create promise is bounded inside the locked
transaction as well as the transport; a never-settling SDK operation rolls back
and releases locks at the deadline. Late SDK completion records only evidence for
the original claim through the bounded persistence path.

## Local verification and limitations

Focused fixtures cover actual PostgreSQL tenant/brand scopes, normalized identity
upserts, read/resolve revision refusal, activity/message paging, one-use sender
proof, account rotation, live role checks, unknown settlement, receipt recording
contention, maintained transport create boundaries and translated UI refusals.
Tests use synthetic accounts and an injected transport, never a real provider.
A real workspace account's discussion access is an operator availability check;
publication permission alone does not prove user-account discussion access.

Inbox migration 0134 is additive after team assignment 0132 and LinkedIn 0133.
It creates normalized inbox tables and transient read/sender proof tables;
existing content, publication, analysis and Telegram account rows are preserved.
Workspace exports include explicit inbox data/receipt fields. Account-generation
proofs, sender previews and collection leases are excluded.

Protocol references: [Telegram discussion discovery](https://core.telegram.org/method/messages.getDiscussionMessage)
and [message creation, reply target, sending identity and random_id](https://core.telegram.org/method/messages.sendMessage).
