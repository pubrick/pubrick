# Editorial notes

Workspace members can record feedback on the saved master text of a post. Open
the post, write a note in **Team notes**, and choose **Add note**. Save any local
text edits first. Notes are internal; a guest client-review link cannot read
them.

Each note is append-only and tied to the exact saved master body at the time it
was added. The page labels it **Current saved draft** while that body still
matches, and **Earlier saved draft** after the body changes. A concurrent edit
is refused so feedback cannot silently attach to text the reviewer did not
see. The list is paged, newest first, in groups of 20.

Notes do not edit a post, change its status, reset an approval, or call an AI
provider. They are stored separately from `content_versions`, whose `origin`
field is evidence for the authorship lens and the publication gate. The API
requires an active workspace organization for both `GET` and `POST
/api/content/:id/editorial-notes`; every query is scoped to that organization.

## Reuse in a new draft

On **Create content**, you can opt in to using recent notes for the selected
brand as style guidance. The switch is off by default. At run creation, Pubrick
copies up to five of the latest notes (at most 500 characters each) into that
run's input. This keeps a queued or resumed run stable even when more notes are
added later; a retry starts a new run with a fresh snapshot. The notes are
shown to the writer as untrusted material, separate from the system prompt,
brief, source, brand knowledge, and plan. They do not become factual sources,
alter the original notes, or add a model call.

## Whole-draft AI revision

For an editable AI draft, **Revise draft with AI** accepts either a freeform
instruction or one of the team notes attached to the current saved master
body. Save local text edits first. The request uses the organization's own AI
provider key and shares the editor's rolling hourly model-call allowance with
selection refinement and channel re-adaptation. Every physical model call is
recorded in `usage_ledger`, including billed failures.

The model returns a complete title and master-body suggestion with a short
reason. The API stores one pending proposal against the exact saved title and
body; the editor shows both fields before and after side by side. Reloading
keeps the proposal. Accept checks the saved title and body again under a row
lock, while Discard only removes the proposal. A changed title or body blocks
Accept without losing the paid suggestion.
An approved or published post cannot be revised; a partly published post cannot
be reset to a draft while a channel is already live.

Accept updates the title and master body together. It returns a rejected or failed item to
draft and requires the normal approval flow again. Any client approval link for
the earlier text becomes stale because its snapshot no longer matches. Existing
per-channel overrides remain visible and must be reviewed or adapted separately
before approval; accepting a master rewrite does not claim to have rewritten
channel copy. The accepted AI change is recorded as provenance without crediting
unchanged body sentences to the model; a title-only change records an empty
fragment with the new title. The original AI full anchor and human publication
gate remain in place. This action does not regenerate images, add a summary
field, or verify factual claims. Image regeneration and claim review remain
separate, explicitly metered editor actions.
