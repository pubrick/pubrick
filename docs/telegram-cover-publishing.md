# Telegram post delivery and recovery

Pubrick can publish a reviewed Telegram channel adaptation of up to 12,000
UTF-16 code units of plain text, including its managed hashtags. The master
draft and other channel adaptations retain their own limits. A covered post
sends one JPEG photo with at most 1,024 units in its caption, then up to three
text replies. A text-only post sends up to three messages. Each text message
holds at most 4,096 units. Replies target the first message ID, and the channel
preview shows every exact part before approval. Nothing is truncated or
interpreted as HTML or Markdown.

The first message is already live before Pubrick asks Telegram to send a reply.
Its message ID, URL and exact remaining text are checkpointed on the delivery
receipt before the reply request. If a reply fails, its answer is ambiguous,
or the worker stops, Pubrick marks the delivery outcome unknown and does **not**
retry automatically. The content detail shows a safe first-message link when
available and the frozen remaining text for manual recovery. A response that
confirms the first message but omits its message ID stops before a reply and
follows the same path.
The reply request refuses to send as a standalone message if Telegram can no
longer find the first message. A dead-lettered attempt with a saved checkpoint
also keeps the partial outcome instead of becoming a plain failed send.
If a dead-lettered attempt has an in-flight send claim but no checkpoint,
Pubrick records a generic unknown outcome: the send may already have reached
Telegram, so retry still requires a channel check.
Reject is refused while a send claim is in flight, including the interval
between Telegram accepting the first message and the worker saving its checkpoint.
After the attempt finishes, the operator resolves an unknown or partial
outcome before approving another send.

The operator checks the channel first. If the reply is already live, or the
operator posts the missing text as replies to the accepted first message, they
confirm the full post; the receipt records their assertion and retains the
first-message link. A checkpoint with an empty remaining suffix and a
`confirmed` outcome means Telegram accepted every part, but Pubrick could not
save the final receipt. The operator still checks the complete post before
confirming it.
The reviewed item and channel text, cover and video stay frozen until this
partial delivery is resolved, so the draft still describes the accepted parts
and any missing reply.
If they remove the first message and every reply, they confirm removal, which
allows a new publish attempt. A generic unknown-delivery assertion is refused
for a partial Telegram post: it cannot truthfully say whether the full post was
delivered. No recovery action automatically resends any part. A
crash between Telegram's first response and the database checkpoint can still
leave only the generic unknown receipt; the safe response is to inspect the
channel before resolving it.

The editor, API and AI adapter enforce the same 12,000-unit limit for Telegram
adaptations, including saved versions and managed hashtags. A resumed AI run
keeps the 4,096-unit Telegram limit in its original claim receipt. Historical
photo checkpoints remain readable. During a rolling upgrade, deploy the
compatible API and worker before enabling the longer editor limit; the worker
retains the old photo/reply checkpoint for posts within that old limit. Video
remains a single MP4 upload with a 1,024-unit caption.
