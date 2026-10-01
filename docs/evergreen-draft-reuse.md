# Reuse a saved draft as a source

Open a saved content item and choose **Reuse as source**. Save or explicitly
discard any unsaved editor changes first. Pubrick uses the saved master text,
not a channel adaptation or the editor's unsaved text.

1. Review the immutable source preview.
2. Choose an editorial format and active channels in the same brand. Optionally
   set a new title and instructions for the new draft.
3. Choose **Generate**, review the confirmation, and explicitly consent to paid
   generation using your provider key. Cancel creates no run or provider call.
4. Follow the run receipt, then open and review the independent generated draft.
   Its source attribution links to the original when you can access it.

The original remains unchanged. The new draft has its own AI versions, review
state and channel adaptations. Approval, scheduling, publication and media are
not copied. Provider calls and ordinary retries may incur charges; prices can
be unknown. A single-channel successful scripted journey used five role calls,
not a guaranteed bill or universal call count.

## Source changes and request recovery

The preview records the saved text revision and a digest that also covers its
title. If the source changes before admission, refresh the preview and confirm
again. Your new-draft choices remain available; generation does not silently
switch to the changed source.

An uncertain response retains the confirmed request and its operation key within
the same tab's application lifetime. Repeating that request acknowledges the
existing operation rather than starting another generation. A hard reload, tab
close or browser restart clears this in-memory recovery state. The server audit
remains durable, but Pubrick does not automatically replace a lost browser key
with another paid request. Inspect existing run receipts before starting again.

## Limits and source removal

- Authors need access to the source's brand. This workflow uses a signed-in
  session; public API write keys cannot invoke saved-source reuse.
- Eligible sources are saved drafts, approved, published or partially published
  content with a nonempty master of at most 8,000 normalized characters. Archived sources and
  unavailable channels must be repaired or replaced before a fresh admission.
- Reuse is manual and stays within the source's brand. There is no automatic
  evergreen schedule, media cloning or inherited delivery approval.
- A fresh retry of an internal-source run requires paid confirmation too.
  A deleted and erased source cannot start a fresh retry.
- Permanent deletion retains its existing restrictions: archived drafts or
  rejections without publication history or active/attempted delivery. It is
  additionally refused while related reuse runs are active. When deletion is
  otherwise eligible and related runs are terminal, it erases retained source input and checkpoints and
  marks attribution unavailable. Independent generated drafts and versions,
  consent audit, usage, publications and provider-held requests remain.

For the technical contract and concurrency boundaries, see
[design 0012](specs/0012-evergreen-draft-reuse.md). Local acceptance is recorded
in the [integration review](reviews/2026-10-01-evergreen-integration.md).
