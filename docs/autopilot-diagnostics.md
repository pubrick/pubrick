# Autopilot diagnostics

Brand owners and organization admins can inspect the **Today at a glance** panel on a brand's Autopilot settings page. The read-only `GET /api/brands/:brandId/autopilot/diagnostics` endpoint uses the active organization and brand authorization. It makes no provider call and does not trigger a scheduler pass.

The response reports the brand's local date and hour, saved generation schedule, automatic dispatches for that local date, the configured daily run limit, approved undated topics without a dispatch, active automatic runs, and ten recent dispatches. The existing `/history` endpoint retains its 50-row window and now includes the topic title. A topic in the waiting count is **not guaranteed eligible**: the scheduler also checks brief length, selected channels, organization concurrency, and other conditions when it runs.

The generation spend card mirrors the scheduler's current admission accounting: it sums priced `usage_ledger` rows attached to runs of this brand on the brand's local date. It counts rows without a known price, calls recorded as lost on today's runs, and older runs whose loss count is unknown. These are distinct observations; a lost call may have no ledger row. Calls made outside a run, including image generation in the editor, are excluded from this specific threshold. The threshold is an admission check before a new run, so a running call can take spending above it.

The panel is an observed snapshot assembled from several queries. It is not a forecast or an authoritative current admission decision. The scheduler does not store the reasons it skipped a scan, so the API never claims a last skip reason or a complete scan history. Refresh the panel to see newer observations.
