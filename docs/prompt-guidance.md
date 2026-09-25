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

This feature adds no templating library. The current role prompts already use
typed code and structured model outputs; concatenating bounded, trusted
organization guidance is smaller and safer than adding an unrestricted template
interpreter. The reference module's Jinja2 registry rendered arbitrary
variables, which are unnecessary for this form of customization.
