# Prompt revision outcomes

Settings → Generation guidance compares up to the latest 100 saved revisions for one role and one brand. Each row uses **runs started within the selected 7, 30, or 90 days** as its cohort. The denominator is pinned runs, including failed runs; an empty row means this version was saved but has no run in that cohort. Runs are attributed only through their immutable guidance snapshot and the run's own organization and brand.

Succeeded runs count run status. Published runs count each run at most once when its currently linked draft has at least one `published` publication receipt through a live adaptation in the same organization. Two platform receipts do not double the count. A later revision of the same draft can still appear under another run, so these are **run observations**, not unique drafts or publication events.

Approvals and rejections count append-only, independently verified human decision links for runs in that cohort. An approval repeated without a new decision is not a second act; a real reject followed by a new approval is two acts. Those counts can exceed the run denominator. They remain countable if the draft is deleted, while its current status and any publication link through deleted adaptations cannot be reconstructed. Current draft statuses are snapshots at read time, and a run with no live linked draft is reported separately.

Every role is pinned at claim time; a pinned role might never have reached the model. The table supports editorial inspection but neither causally attributes outcomes to a prompt nor produces a quality score. In particular, it does not import the legacy arbitrary ±0.1 feedback score or its cross-brand fallback.
