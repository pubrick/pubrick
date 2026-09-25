# Versioned generation guidance

Pubrick keeps the built-in role instructions in `packages/ai`. Organization
members can add guidance for the researcher, writer, editor, claims-to-verify
step, and channel adapter in **Settings → Generation guidance**. The additional
text is sent as model instructions. It never replaces the built-in prompt
boundary, required output schema, length limits, or human review gate.

Saving creates an immutable revision. The greatest version for each organization
and role is active; **Restore** appends a copy of an earlier revision, preserving
the saved history. The page and history endpoint show the latest 100 revisions;
older revisions remain stored. Saving an empty field returns that role to its built-in
behavior. The API is `GET /api/prompts`, `GET /api/prompts/:role/revisions`, and
`POST /api/prompts/:role/revisions` with `{ "guidance": "..." }` (maximum 6,000
characters). All reads and writes require an active organization; no global
prompt override or secret is exposed to another tenant.

At the first successful worker claim, Pubrick stores one immutable guidance
snapshot on the run. Each role records its revision ID, version, and text. An
empty snapshot (`{}`) is intentional: later guidance cannot appear in an
already claimed run. A lease takeover, queue redelivery, or checkpoint resume
uses the same snapshot for every unfinished step. If a run was partially executed
before this feature was deployed, its first claim after the upgrade can only
snapshot the guidance current at that time; earlier revisions cannot be inferred
from its checkpoints. **Try again** creates a new run, so it uses the revisions
current at that new run's first claim.

**Pinned runs** beside a revision shows runs whose pinned snapshot names that exact
revision, over the last 7, 30, or 90 days. The API is
`GET /api/prompts/:role/revisions/:revisionId/usage?days=30`. It requires a
manager of the active organization and returns 404 for a revision from another
organization or role. It counts run statuses and the **current** status of any
still-linked draft; a missing current draft can also mean a failed run or a
deleted draft. Runs never claimed by a worker, or from before guidance snapshots
existed, cannot be attributed. The worker pins all role versions before the
first model call, so a counted run does not prove this role reached the model.
A changed draft status is not a historical review
decision. The report does not score prompt quality, infer causation, or run an
experiment. The reference Content Factory had an A/B table and resolver, but no
production caller; the working template feedback mixed versions and repeated
decisions. Controlled experiments remain future work. Do not use this field to
store source material or API keys.

**Review decisions** beside a revision is a separate historical journal. A
successful, meaningful Approve or Reject appends one immutable event in the
content transaction. Repeated approval of an already approved item, schedule
changes, repeated rejection of a still rejected item, delivery status changes
alone, and refused requests do not append a new verdict. A fresh approval
after an edited draft or failed delivery does count. A
rejection of outstanding channels after another channel went live is a real
rejection and is recorded, even though the post remains partly published.
Events retain the item ID after a draft is removed, without retaining its text.
Each event has a per-item ordinal assigned under the content item lock, so rapid
opposite decisions have a causal order even when their timestamps are equal.

The first AI `full` master content version anchors attribution to its producing
run. Attribution is allowed only with one unambiguous master version, a matching
same-organization run linked to that item, and a claimed guidance snapshot whose
role revision IDs and versions all match stored revisions of the same organization.
If any evidence is missing or conflicting, the event remains unattributed; Pubrick
does not infer a run from the current item status or a later draft version. The
journal copies IDs and version numbers only, never guidance text. Its insert has
no foreign key to runs, revisions, or items: those references are historical
evidence, and avoiding a late run foreign-key lock preserves the product's lock
order. The organization row is held `FOR KEY SHARE` before the review path's
adaptation and item locks, because the journal itself has an organization FK.

`GET /api/prompts/:role/revisions/:revisionId/decisions?days=30` requires an
organization manager. It returns counts within a 7, 30, or 90 day window and a
20-event newest-first keyset page; `cursor` is the last event ID from the page.
The Settings panel labels these historical acts separately from pinned-run and
current-status counts. Unattributed events and decisions before the journal
existed cannot appear in a per-revision report. A role's presence in a pinned
snapshot still does not prove that role reached the model, and these counts are
observational, not a quality score or an experiment.

This feature adds no templating library. The current role prompts already use
typed code and structured model outputs; concatenating bounded, trusted
organization guidance is smaller and safer than adding an unrestricted template
interpreter. The reference module's Jinja2 registry rendered arbitrary
variables, which are unnecessary for this form of customization.
