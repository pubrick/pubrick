# Telegram cover text

Pubrick can publish a reviewed Telegram post with one JPEG cover and up to 4,096
characters of plain text. When the text fits Telegram's 1,024-character photo
caption, it sends one photo. For longer text, it sends the photo with the first
caption-sized part, then sends the remainder as one reply to that photo. The
channel preview shows those two parts before approval. Nothing is truncated or
interpreted as HTML or Markdown.

The photo is already live before Pubrick asks Telegram to send the reply. If
the reply fails or its outcome is unclear, Pubrick marks the delivery outcome
unknown and does **not** retry automatically. The delivery detail tells the
operator that the photo was accepted and, when Telegram provided one, shows its
link in the error detail. Check the channel and settle the outcome before
approving another attempt; sending again can duplicate the photo. A response
that confirms the photo but omits its message ID also stops before the reply
and requires a channel check.

Video remains a single upload with a 1,024-character caption. Text-only
Telegram posts remain single messages with a 4,096-character limit. The
4,096-character editor limit is shared with Pubrick's other draft flows, so
this feature does not expand the length of a stored draft.
