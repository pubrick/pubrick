# Brand activity overview

`GET /api/analytics/brands/:brandId/overview?days=7|30|90` reports persisted
activity for one brand in a half-open window `[to - days, to)`. It never calls
an external platform or model. The organization guard and brand access guard
run before the repository; the repository checks the brand and scopes every
query and join to organization and brand.

| Measure | Event time | Interpretation |
| --- | --- | --- |
| Drafts | `content_items.created_at` | Number created in the window, split by origin and **current** status. `other` includes failed, partly published and archived. Deleted drafts are absent. |
| Generation runs | `pipeline_runs.created_at` | Number created in the window, split by **current** outcome. A successful run is not a publication. |
| Human review decisions | `prompt_decisions.created_at` | Approved/rejected decision events, joined to a surviving draft of this brand. Repeated genuine decisions count separately; prompt-revision links never multiply them. The journal has no brand ID, so decisions for deleted drafts cannot be attributed and are excluded. |
| Published receipts | `publications.created_at` | One persisted receipt whose **current** status is `published` per live adaptation/channel/item chain, grouped by platform. A receipt can be created as `in_flight` and become published after this window; this count does not claim when delivery happened. Human-settled receipts are included and counted separately. Deleted channels can leave receipts without an attributable brand, which are excluded. This is not audience reach. |
| Attributed AI calls | `usage_ledger.created_at` | Ledger rows linked to a surviving run, draft or channel; a run link takes precedence when multiple links exist. Each ledger row is counted once. Rows without a surviving brand link are excluded. |
| Unrecorded run calls | Run `created_at` | Missing ledger writes counted on runs started in the window. Their physical call time was not stored, so the overview cannot place them more precisely. Runs predating loss tracking have a null counter and are reported separately. |
| Unrecorded claim-review calls | `claim_reviews.created_at` | Missing ledger writes for reviews still linked to a draft of this brand. Their physical call time was not stored, so they are assigned to review creation. |

Cost uses the shared ledger rule: a priced call has a non-null cost and a cost
source other than `unknown`; estimated calls use the local price table. An
unpriced call has counted tokens or an unknown provider outcome. A refused call
with no counted tokens is not silently called paid. `knownUsd` is a sum over
priced attributed rows, not a full bill. The UI displays `≥` when unpriced or
unrecorded calls or runs predating loss tracking exist, `≈` for estimates,
and "No priced calls" when there is no priced observation. Zero is shown only
when a priced call records zero. Claim-review losses have their own count;
reviews whose draft was deleted cannot be attributed to a brand.
Standalone calls whose only attribution was deleted cannot be assigned to a
brand. No rate, ROI, prompt score or platform engagement is inferred.

The existing per-publication Results cards remain the place for observed
channel metrics. Their bounded 100-post view is separate from these aggregate
counts.
