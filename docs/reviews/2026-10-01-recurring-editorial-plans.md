# Weekly editorial plans integration

Date: 2026-10-01. Branch: `codex/recurring-editorial-plans`.
Status: integrated local acceptance and independent source review verified.
Main integration remains pending. Final reviewed implementation: `143c5ce9`.

## Delivered scope

Finite weekly social-post plans live in the brand Calendar. Saving creates a
disabled plan; Enable requires explicit paid-generation consent. Preview uses the same server
calculator as materialization, including timezone and DST handling. Persistent
occurrence identity, pinned input/consent snapshots, ordered tenant locks and
transactional queue admission protect pause, resume, skip and dispatch.

There is no automatic delivery. Dispatched runs retain their admitted input;
editing a plan requires renewed consent for future work. Retention and plan
capacity bounds are not monetary spending caps. Four locales, repair of
unavailable channels, localized failures, keyboard consent and mobile layout are covered.

## Verification and follow-up scope

The integrated local build passed **12/12** tasks; typecheck passed **20/20**;
Biome checked **1,038 files**. Later changes were neutral English wording,
migration test inventories, export/list coverage, isolated worker fixtures and
documentation. The wording's affected authorship
and locale tier passed **27/27**; the changed database test passed its package
typecheck and scoped lint. No production migration was rewritten.
The final affected API/web build selection passed **9/9** tasks (six cached),
including the compiled API after the export correction.

The initial workspace test command ran without cached results and with one
package/test worker. It passed 42 script tests, with three explicit opt-in
Docker/operations/recovery skips. Shared, Telegram, search and billing passed
650 package cases. Web passed 1,537 of 1,538: two new English descriptions used
the word `original`, which the authorship ratchet deliberately refuses. Both
descriptions were reworded; the unchanged ratchet and locale checks then passed.
The remaining successful web cases were not rerun for this wording-only fix.

The next package tier passed MCP, mail and AI (489 cases), and 251 database
cases. Three strict migration assertions failed because their explicit CHECK
and timezone inventories omitted migration `0126`. The correction lists all
14 new CHECKs and nine timestamp fields. A new native case first inserts valid
rows, then independently violates every CHECK and requires its exact PostgreSQL
constraint name and SQLSTATE, including three closed enums. Counts and the
historical bad-value loop remain strict. Independent source review passed.

The affected native tier passed **5/5**, with 52 intentionally filtered cases.
This includes the three corrected assertions, the existing historical enum
case and the new 14-CHECK case. Those results combine with the earlier 251
unchanged passing cases to cover **255 distinct database cases**. This is
composite verification, not a claim that the failed command returned success.

On the owned Docker volume, the all-prefix timezone matrix exceeded its
unchanged 480-second limit. The same SQL, assertions, all **126 historical
cutpoints including empty**, and timeout passed on an owned PostgreSQL 16.15
container with a 512 MiB tmpfs data directory: matrix **374.990 seconds**.
The selected five-case result is retained locally at
`/tmp/pubrick-weekly-migration-inventory-tmpfs.json`; the earlier volume timeout
remains a recorded failure. The tmpfs container and its storage were removed.

The next tier passed integrations (134 cases). API passed 946 cases and skipped
12, but failed 254 cases across eight files. The weekly tables were missing
from the workspace export allowlist and the recurring controller from the
native tenant-list registry. Both omissions required corrections and affected
native verification, recorded below. Five suite setup failures also exposed a
missing explicit `DATABASE_URL` and a disposable database name that did not
match the public-write fixture's guard. The corrected runner sets both database
URLs to its owned loopback `pubrick_weekly_test`; no guard was relaxed.
The focused six-file recheck passed **291/291**, including all 252 content
cases, plus 39 cases from the previously blocked suite setups. The earlier
socket failure remains recorded; no content production or fixture code was
changed to make this recheck pass. Export/list correction verification passed
**8/8** (22 intentionally filtered): two export policy assertions, the new
positive/foreign-brand native collection case and five unchanged controller
ratchets. API package typecheck, scoped lint and independent review passed.
The corrected allowlist covers all 21 plan and 23 occurrence fields plus the
slot's occurrence attribution; it exposes no provider credentials or tokens.
The fixture's owned database was removed.

API composite coverage is **1,241 distinct passing cases**, with 12 explicit
skips: 946 unchanged passes, the six-file 291-case recheck, two corrected
previous failures and two new export/list cases. Previously passing ratchets
are not counted twice.

The worker package passed 643 of 644 cases. The fairness fixture expected its
100 refused slots to fill the global scanner's first page but saw only 99:
the shared database retained one earlier ordinary due slot from another API
fixture. A native inspection confirmed exactly one outside slot due before
the synthetic scan clock. The file cleaned its own tenants but had not earned
an exclusive global scanner population. A dedicated owned database correction
was required and applied; the production scanner, 100-row assertion and time limit remain
unchanged. The isolated dispatch file passed **11/11**, followed by **3/3**
one-case fairness repeats with ten deliberately filtered cases each. Worker
package typecheck, scoped lint and independent source review passed. Its first
attempt could not load a direct `pg` import (zero tests executed); the fixture
then used the existing `@pubrick/db` connection helper without adding a
dependency. The original loading failure is retained locally.

All generated fixture databases were removed and their queue/observation/worker
pools closed. Production `CalendarService` remains unchanged by this correction
(blob `e48f5c43d6fd339cb959f36f20624aadf0172253`). Composite worker coverage is
**644 distinct passing cases**, combining 643 unchanged passes with the
corrected fairness case; the other ten affected-file cases and repeats are not
counted again.

Across package tiers, composite acceptance covers **4,951 distinct passing
cases** and 12 explicit API skips, plus **42 script passes / three opt-in skips**
and the one built-browser journey. Failed original commands and filtered
affected rechecks remain distinguished above. This is not a claim that one
full workspace command returned success.

The CI test step was subsequently aligned with the verified native runner by
setting its explicit `DATABASE_URL` to the same synthetic loopback database as
`TEST_DATABASE_URL`. This supplies collection-time server environment validation
for the five suites rechecked above. Independent source review and YAML parsing
passed; workflow triggers, permissions and billing isolation did not change.
The earlier PR-head CI result remains separate from this configuration fix.

## Browser and independent guard evidence

The [built browser journey](2026-10-01-recurring-browser-acceptance.md) passed
at `3d91a2aa`, whose tree matched integrating source `68999069`. It proves
one real scheduled worker run, five scripted transport calls/checkpoints/ledger
rows, one adaptation, a saved human edit, mobile/keyboard behavior, pause/resume,
automatic summary refresh, permanent Skip after an actual planner job, terminal
Remove and zero publication jobs. Later production edits reworded two English
descriptions and added the explicit workspace export allowlists described
above. Generation and calendar/worker admission logic did not change afterward.

The journey reproduced and drove fixes for stale first-key Settings revision
and stale asynchronous schedule summaries. Fixture failures are separated from
product failures in its record. Its Google fetch interception is not a universal
network firewall; no live provider call occurred in this synthetic journey.

Independent native proofs have deliberately limited claims:

- [Calendar provider snapshot and scan isolation](2026-10-01-calendar-scan-isolation.md).
- [Occurrence state-only admission](2026-10-01-editorial-occurrence-state-proof.md).
- [Exact lateness, null enqueue and quota fairness guards](2026-10-01-recurring-dispatch-guards.md).

Static combined review approved `70735267`; Settings and summary fixes and the
migration inventory amendment also received scoped independent reviews.
These records do not claim that every dispatch predicate has a mutation proof.

## Release limits

All fixture credentials and content were synthetic. The root-owned PostgreSQL
container and its anonymous data volume were removed after the final checks;
failed/successful test reports remain available locally. User runtime databases,
saved provider secrets and private backups were preserved. Main release needs
authorization for the final reviewed candidate. Public image publication and
real hosted payment/SMTP acceptance remain separate roadmap dependencies.
