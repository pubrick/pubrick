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
current at that new run's first claim. A/B experiments from the original Content
Factory are future work. Do not use this field to store source material or API
keys.

This feature adds no templating library. The current role prompts already use
typed code and structured model outputs; concatenating bounded, trusted
organization guidance is smaller and safer than adding an unrestricted template
interpreter. The reference module's Jinja2 registry rendered arbitrary
variables, which are unnecessary for this form of customization.
