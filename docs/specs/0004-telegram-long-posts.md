# Bounded multi-message Telegram posts

Status: proposed. This extends the existing reviewed Telegram cover delivery;
it does not import the reference publisher's HTML mode or its optimistic
`success=True` after a dropped tail.

## User contract

- A Telegram channel adaptation may contain up to 12,000 UTF-16 code units of
  reviewed plain text, including the existing managed hashtag suffix. The
  canonical master draft stays at 4,096, and other channel limits stay as they
  are. A separate channel-body DTO bound, channel-specific API validation,
  version restore/CAS guards, editor limit and counter, generation adapter
  schema, readaptation, and claim snapshots must agree. The editor and API
  enforce the same platform-specific limit. Generation may produce a longer
  Telegram adaptation, but the reviewed text is always editable before
  approval. Telegram video adaptations still have a separate 1,024-character
  caption limit at edit, preview and approval.
- Before approval, the channel preview shows the exact photo caption and each
  reply, or each text-only message. No character is silently removed, added,
  interpreted as markup, or split inside a grapheme. Video remains one MP4
  with a caption of at most 1,024 characters.
- The first accepted message is the publication link. Later parts reply to its
  Telegram message ID and refuse to send standalone if that message is gone.
  A missing usable ID after the first accepted message ends in a partial,
  operator-resolved outcome without sending another part. A missing URL alone
  does not block replies when the ID is valid; the UI shows the absent link.
- A finished multi-message delivery appears as one publication receipt. The
  editor can inspect an uncertain delivery and its exact remaining suffix in
  the existing content detail, then explicitly confirm the complete post or
  confirm removal of **all** accepted parts before another publish attempt.
  Pubrick never sends a missing part automatically after an uncertain outcome.

## Boundaries and splitting

Use the existing `Intl.Segmenter` pattern, not a new sentence-splitting
dependency. The limit is conservative against Telegram's plain-text length
limit: at most 1,024 JS code units in a photo caption, 4,096 in each
`sendMessage`, and 12,000 total. Prefer a natural sentence/word boundary when
it leaves at least half a part; otherwise cut at the last full grapheme under
the limit. Concatenating parts must reproduce the saved, normalized reviewed
text exactly in UTF-16 code units, without dropped or added units. Reject
unpaired surrogates and a pathological grapheme that cannot fit before the
first request. Text-only posts need at most three Telegram requests; covered
posts need at most four. Preflight the complete plan before any request.

## Durable delivery contract

Generalize the existing photo/reply checkpoint rather than introducing a
second recovery system. The in-flight `publications` row records a nullable
primary kind (`photo` or `message`), first message ID/URL, exact remaining
suffix, and the outcome of the next part (`pending`, `not_sent`, `rejected`,
`unknown`, or `confirmed`). Add a nullable `partial_primary_kind` column and a
backward-compatible check in a forward migration. Keep the existing
`partial_photo_id`, `partial_photo_url`, `partial_followup_text` and
`partial_followup_outcome` columns as compatibility storage: new code treats
them as the first message and remaining suffix regardless of kind, while old
photo rows retain their values. Backfill their kind to `photo`. Extend the
check and shared outcome list for a zero-length
suffix with `confirmed`: every part was accepted but the final publication
receipt has not yet been committed. Null suffix means no partial checkpoint.
The API, worker, and UI first learn to read both old and new checkpoint shapes
while the editor still caps Telegram at 4,096. Only a later release may raise
the authoring limit and produce long posts, after the compatible worker and API
have been deployed; deploy workers before enabling longer adaptations in a
rolling installation. This avoids destructive column renames and keeps old
photo receipts resolvable. The legacy column names can be removed in a later
major version with an explicit migration plan.

After Telegram accepts the first message, checkpoint it **before** the next
request. After each confirmed reply, compare-and-swap the old suffix for the
new one before another request. The write is scoped to the same organization,
publication claim, adaptation and attempt, with an in-flight status. A failed
checkpoint or lost claim stops all sends. Never overwrite a shorter saved
suffix with a stale longer one. After the final checkpoint, record the normal
published receipt and clear the partial fields. That terminal write must
compare-and-swap the same claim ID, adaptation status and attempt; a late
handler cannot overwrite a newer operator decision or publication. If the
final write cannot be confirmed, retain the checkpoint and resolve as unknown.
An orphaned claim remains reachable by its own ID and cannot authorize another
send.

Any request with an unknown outcome stops the sequence and marks the entire
publication unknown. A known rejection or rate limit after an accepted prefix
also stops the sequence and is a partial delivery, not a failed whole post.
The frozen suffix begins at the first unconfirmed part; the operator must
inspect the channel because that part may already be live. A crash before the
first checkpoint is a generic unknown receipt, not a safe retry. A redelivered
job and dead-letter sweep must never send a second first message when an
in-flight or partial claim exists. Editing, rejecting, rescheduling, or
re-approving a draft with an unresolved partial remains blocked.

The worker's graceful-stop budget must cover four sequential Telegram request
deadlines plus the existing publication-recording budget. The queue's
600-second attempt expiry still bounds the whole operation. Keep the
organization-scoped lock order in `docs/lock-order.md` during migration and
recovery writes.

## Proof

- Splitter examples at 1,024, 4,096 and 12,000, with paragraphs, emoji ZWJ
  sequences, combining marks, whitespace and a pathological grapheme. Preview
  and send plan agree exactly.
- Text-only sequences of two or three messages and covered sequences of two
  through four: each payload
  fits, replies target the first ID, one receipt is recorded, and no unwanted
  platform request is made on a preflight refusal.
- After each accepted message: failed or delayed checkpoint, known rejection,
  unparseable response, timeout, worker crash/redelivery and dead-letter. Each
  leaves the correct frozen suffix; no test path posts the first message twice.
- A success envelope missing the first ID, one with a valid ID but no URL, a
  final accepted part with
  failed receipt write, and operator confirm/remove of partial photo and text
  posts. Historical photo partial rows survive the migration and remain
  resolvable. Cross-organization receipt and version access is refused.
- Local full build/typecheck/lint/test and one combined review before the PR.
  A live Telegram smoke check needs an authorized test channel and account;
  mocked Bot API fixtures cover the release gate without production sends.
