# Expert article SEO polish

An editor can enter up to eight distinct phrases (2–60 characters each) when
generating an expert article. The phrases are editorial guidance supplied by
the editor. Pubrick does not estimate search volume, rankings, or traffic.

The direct generation form exposes the phrases under **Advanced → SEO
keywords**. An approved topic's direct **Generate** dialog also offers the
expert article format and the same input. Empty input keeps the default
generation pipeline and makes no extra model call.

When phrases are supplied, the run receipt stores their reviewed values in
`pipeline_runs.input.seoKeywords`. The worker runs a structured `seo_polish`
step between writer and editor. It may improve heading wording and place the
first phrase in the opening when natural; it must retain the draft's meaning,
supported facts, section structure, and caveats. The editor, claims-to-verify
step, channel adaptation, and human approval gate still run afterward.

Every physical model call is recorded in the usage ledger before a checkpoint
is written. The step is fenced like the other model steps. A provider refusal,
timeout, or schema failure checkpoints `result: "unavailable"` with the writer's original body,
which keeps the later steps running and makes the fallback visible on the run
receipt. A resumed job reuses that checkpoint and does not repay for SEO
polish. An internal or cancellation error follows the regular run failure
path instead of being hidden.

`POST /api/runs` accepts `seoKeywords` only with
`contentType: "expert_article"`. `POST /api/topics/:id/run` accepts the same
pair for direct generation of an approved topic. Try again copies the saved
phrases into the new request. Scheduled topic slots do not yet persist or
propagate SEO phrases; their generation remains on the default path.
