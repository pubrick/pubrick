# Telegram cover text

Pubrick can publish a reviewed Telegram post with one JPEG cover and up to 4,096
characters of plain text. When the text fits Telegram's 1,024-character photo
caption, it sends one photo. For longer text, it sends the photo with the first
caption-sized part, then sends the remainder as one reply to that photo. The
channel preview shows those two parts before approval. Nothing is truncated or
interpreted as HTML or Markdown.

The photo is already live before Pubrick asks Telegram to send the reply. Its
message ID, URL and exact remaining text are checkpointed on the delivery
receipt before the reply request. If the reply fails, its answer is ambiguous,
or the worker stops, Pubrick marks the delivery outcome unknown and does **not**
retry automatically. The content detail shows a safe photo link when available
and the frozen remaining text for manual recovery. A response that confirms the
photo but omits its message ID stops before the reply and follows the same path.
The reply request refuses to send as a standalone message if Telegram can no
longer find the photo. A dead-lettered attempt with a saved photo checkpoint
also keeps the partial outcome instead of becoming a plain failed send.
Reject is refused while a send claim is in flight, including the interval
between Telegram accepting the photo and the worker saving its checkpoint.
After the attempt finishes, the operator resolves an unknown or partial
outcome before approving another send.

The operator checks the channel first. If the reply is already live, or the
operator posts the missing text as a reply to the accepted photo, they confirm
the full post; the receipt records their assertion and retains the photo link.
The reviewed item and channel text, cover and video stay frozen until this
partial delivery is resolved, so the draft still describes the live photo and
its missing reply.
If they remove the partial photo and any reply, they confirm removal, which
allows a new publish attempt. A generic unknown-delivery assertion is refused
for a partial Telegram post: it cannot truthfully say whether the full post was
delivered. No recovery action automatically resends the photo or reply. A
crash between Telegram's photo response and the database checkpoint can still
leave only the generic unknown receipt; the safe response is to inspect the
channel before resolving it.

Video remains a single upload with a 1,024-character caption. Text-only
Telegram posts remain single messages with a 4,096-character limit. The
4,096-character editor limit is shared with Pubrick's other draft flows, so
this feature does not expand the length of a stored draft.
