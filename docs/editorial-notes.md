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

The old Content Factory could send freeform reviewer feedback to a writer for a
new whole-draft revision. Pubrick currently has metered selection refinement
and per-channel re-adaptation with explicit Accept/Discard. A freeform
whole-draft AI proposal remains to be ported. It needs its own metered model
call, server-staged proposal, snapshot check and explicit acceptance, without
turning a note into an instruction that silently changes approved text.
