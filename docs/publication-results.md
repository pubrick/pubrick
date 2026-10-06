# Publication results

The brand's Results screen provides 7-, 30- and 90-day receipt periods,
an optional channel filter, chronological pagination, an equal-length previous
period and CSV export. It uses the existing supported counter collector: VK.
Connecting a platform does not grant analytics access to that platform.

## What a period means

The cohort contains receipts whose current status is `published`, including
explicit human confirmations. Dates use the receipt's persisted creation time
(`recordedAt`), not an inferred provider publication timestamp. A worker claim
can have been recorded before its eventual confirmation. Failed, uncertain,
partial and in-flight records do not contribute to publication results.

The HTTP query accepts UTC bounds with exactly three fractional digits, such
as `2026-09-01T00:00:00.000Z`. Windows are half-open: `from` is included and
`to` is excluded. A window spans at most 93 days. The previous cohort occupies
the adjacent window of exactly the same duration. The displayed bounds are UTC.

Counters are each post's **latest stored observation**. Comparing cohorts is
not a measurement of audience growth between those dates. Pubrick does not
keep a historical counter series or infer missing observations.

## Coverage and history

Summary counts and sums cover the entire filtered cohort before pagination.
Each counter includes its own observed-post count. An observed zero remains
zero; a counter without any available observation remains `null` and displays
as a dash. Error, unavailable and refreshing observations do not contribute
stored older counters to sums. Observations older than 24 hours are identified.

Live channels are attributed through their current brand. Deleted channels
remain visible only when the receipt carries the immutable brand snapshot
written by the existing deletion trigger. Older unattributable orphans stay
excluded. Archived receipts preserve available observations but cannot refresh,
open a deleted content record or collect its discussion. Archived channel groups
use their retained name and platform; the historical channel ID is unavailable.

The list uses a descending `(created_at, id)` keyset with microsecond cursor
precision. Cursors are bound to the tenant, brand, channel filter and exact
period. Filter changes require a new first page. Each page and its aggregates
use one repeatable-read database snapshot; later pages may see newer stored
observations. Reload to refresh the whole displayed list.

## Export and permissions

`GET /api/analytics/brands/:brandId/results` returns the complete-cohort
summary, previous cohort, per-channel summaries and one page of receipt rows.
`GET /api/analytics/brands/:brandId/results.csv` exports the complete filtered
cohort independently of the page limit. Export refuses cohorts above 10,000
receipts; narrow the period or channel. No truncated CSV is returned.

The maintained `csv-stringify` serializer supplies CSV quoting, a UTF-8 BOM
and formula escaping. Unobserved counters use empty cells. Rows include receipt
time, channel, platform, archive/human-confirmation markers and observation
status/time. Credentials, content bodies and organization secrets are excluded.

Both endpoints use the same brand access checks as Results. Granted authors
and editors can read and export; existing manager/member rules still govern
counter refresh and discussion collection. No new paid model call occurs when
viewing, comparing, paging or exporting results.
