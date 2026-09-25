# Client review links

Pubrick can ask an external client to review a saved draft without creating a
workspace account. A workspace owner or admin opens the draft, creates a review
link, and copies it immediately. The link is shown once. Send it through a
channel you trust; anyone who has it can submit the guest decision.

The guest page shows the saved master copy, channel versions, and selected
cover. It records **Approve draft** or **Request changes** (with a required
comment). This does not publish or schedule the draft. Workspace members can
see the decision and comment on the draft page; the editor can refresh that
status after the client responds. Only a workspace member can take the final
publication action.

## Scope and lifecycle

- The link is a random bearer capability. Pubrick stores its hash, not the
  plaintext token. It expires after 72 hours by default, can be revoked by an
  owner or admin, and can be replaced with a new link.
- Approval applies to the exact saved master, channel texts, channel selection,
  and cover shown to the guest. A change to that material closes the link and
  calls for a new review. Changing inline image slots also closes the link,
  conservatively, even though the guest page currently previews only the
  selected cover. The workspace editor must review inline images before
  internal approval. Local unsaved edits are not part of the preview.
- An open link holds back internal approval. A client approval permits the
  usual internal review gate; a request for changes does not. A recorded
  approval stays valid after the link expires while the saved draft is
  unchanged. Revoke or replace an unanswered expired link before publishing.
  A changed draft needs a new approval or explicit revocation.
- A link records a guest verdict, not a verified identity. Confirm the intended
  recipient through your normal client communication channel.

The guest route sends no workspace credentials. Its HTML and API responses are
not cached or indexed, and the page uses a no-referrer policy. Treat the URL as
sensitive: do not put it in public documents, analytics events, or issue reports.
Self-hosters should redact review paths in reverse-proxy access logs, since the
capability appears in the URL.

See [the product design](specs/0001-product-design.md) for the overall human
approval gate and [self-hosting](self-hosting.md) for the deployment setup.
