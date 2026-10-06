# Competitive parity: native Meta connections and publication

Date: 2026-10-07. Continuation of the [competitive parity plan](../plans/competitive-parity.md)
and [Meta lifecycle specification](../specs/0026-meta-publication-lifecycle.md).
The preceding native/team/results/inbox milestone remains recorded separately
at [`72c4527f`](competitive-parity-native-team-results.md).

## Implemented contract

| Surface | Implementation | Boundary |
| --- | --- | --- |
| Connections | Separate Threads, Instagram Login and Facebook Page OAuth; encrypted credentials, one-use user/session/workspace/application state, current identity/grant checks, explicit Page selection, reconnect and disconnect | Real application approval, eligible accounts and callback reachability remain external acceptance prerequisites |
| Supported publication | Threads text, Instagram professional account with one reviewed normalized JPEG, Facebook Page text | Existing Instagram channels stay manual; no video, carousel, inferred read/reply permission or silent attachment omission |
| Approved media | Expiring encrypted capability bound to exact tenant, adaptation, stage, attempt, current connection, input digest and JPEG bytes | Private media API stays authenticated; a capability grants only bounded GET/HEAD access to the approved image |
| Worker | Durable nonpublic preparation and readiness checkpoints within the same attempt, then one final publication claim | Current pg-boss incarnation, saved content and connection authority are checked after locks; an uncertain final request never automatically resends |
| Recovery | Retained preparation history and explicit acknowledged discard; separate human decision about uncertain final delivery | Discard cannot approve or send. A human resolution applies to its exact historical attempt; old evidence is preserved and cannot authorize another send |

See [native Meta setup and recovery](../meta.md) for configuration, permissions,
content limits and the actual user workflow.

## Repairs found during integration

- Added actual Inbox open/resolved/all and Meta preparation collection tenancy
  coverage. The image capability route is a single-resource endpoint with its
  own tenant/parent/byte/expiry fixtures, not a collection exemption for convenience.
- Kept the content list's four-statement, four-parameter and 220 KB limits.
  Assignment summaries use the existing master query; only never-created empty
  assignment metadata is omitted. Saved clear revisions and unavailable
  assignees remain visible. The queue retains its Unassigned label.
- Required fresh connection expiry and matching application/brand at native
  approval and image serving. Bounded file reads reject symlinks and nonregular
  files without hanging on FIFOs; image normalization retains sRGB.
- Bound disconnect confirmation to the connection generation the person saw.
  A parent refresh cannot apply that confirmation to a replacement connection.
- Directed final-delivery recovery to the post's channel controls, where the
  actual action exists. Results remains an analytics view.
- Shared the historical claim/stage checks between worker preflight, final
  intent and preparation discard. Only a later human no-delivery assertion for
  the same attempt settles retained uncertainty. Ordinary worker failures,
  timestamp ties, different attempts and published/in-flight claims do not.
  Decision timestamps use the post-lock database statement clock.

## Verification method

Verification uses owned disposable PostgreSQL and pg-boss, scoped real HTTP,
synthetic provider transports and the compiled desktop/mobile browser stack.
No real Meta credentials were used and no public post was sent.

The integrated run builds prerequisite packages before consumers and serializes
heavy checks. Corrections rerun the affected contracts; already passing suites
are not repeatedly run for copy or fixture repairs. The automatic CI failure
on the preceding main commit is retained as evidence, rather than manually
rerun: [run 37537585086](https://github.com/pubrick/pubrick/actions/runs/37537585086).

| Local gate | Evidence |
| --- | --- |
| Integrated build and static checks | All 12 build and 20 typecheck tasks passed; Biome checked 1,305 files. The final helper was rebuilt before its consumers were tested. |
| Shared and supporting packages | Shared 647, integrations 395, DB 370, AI 434, Telegram 47, search 9, billing 88, mail 23 and MCP 32 passed. Script contracts: 82 passed, 3 intentional skips. |
| API | Initial full run: 1,721 passed, 6 failed and 11 skipped, plus an invalid disposable billing database name. The nine affected files then passed 142 tests, including billing persistence, unchanged list budgets and tenancy inventory. Existing delivery regression subset: 33 passed. After the exact-receipt refinement, both affected Meta files passed all 36 tests, including actual HTTP resolution → approval → pg-boss → second-attempt final intent. |
| Worker | Initial full run: 826 passed and one private LinkedIn snapshot expectation failed. Its nine affected tests passed after correcting the exact expectation. The final native staged service/database gate passed all 80 tests, including historical human resolution, refusal controls, a new physical attempt and late old evidence. |
| Web | Initial full run: 1,811 passed and one Russian authorship-copy check failed. The corrected catalog and subsequent Meta connection/preparation, queue, API transport and locale checks passed all 200 tests across six affected files. Browser-scenario TypeScript passed. |

These are successive full and affected local gates, not a claim that a single
unchanged full run had no failures. Every reported failure was investigated;
the final affected checks retain the original assertions and cost limits.

## Built browser acceptance

The owned self-hosted journey passed on source
`c6b00b5981771e1d2947e28d6ad95c50f78a2e79`: **2 scenarios passed in 21 seconds**.
The runner rebuilt production Next.js, API and worker, migrated a fresh pinned
PostgreSQL image, ran the scenarios and removed its processes, media and database.
The later verification-record commit changes documentation only.

- The mandatory core journey creates an account/workspace, reviews and approves
  saved content, checks a real worker receipt through the owned Telegram
  transport fixture, then switches tenants in the UI.
- The Meta journey checks all three unconfigured native choices without token
  fields, preserves real manual Instagram creation, strips callback parameters
  and refuses replay. Two synthetic same-name Facebook Page choices require an
  explicit selection; the actual API then returns the exact unconfigured-app
  refusal. This UI step does not claim live OAuth or intent-ownership proof.
- A guarded synthetic interrupted preparation in the owned database is opened
  through the actual compiled API and signed-in browser. Cancel changes nothing;
  acknowledged Discard sends the exact attempt/hash expectation, preserves the
  container and history, creates no jobs or receipts, and survives reload.
- At 390 px, screenshots of configuration, Page choice and the discard dialog
  were inspected. No horizontal overflow occurred; choice/acknowledgment targets
  meet the 44 px contract. The return link has its own line. The first browser
  run exposed an ambiguous error selector matching Next.js's route announcer;
  it was scoped to the application main region and both scenarios passed again.

Local replay command: `node scripts/e2e/run.mjs --grep 'native Meta'`.
The runner always includes the core provider-boundary scenario. Its synthetic
provider sends are not public publication. The affected callback UI's eleven
tests also passed after the final spacing correction.

## External acceptance prerequisites

Approved provider applications and eligible accounts, a reachable canonical
HTTPS callback/media origin and actual provider receipts are still required
before claiming live Meta acceptance. LinkedIn/WordPress live-account acceptance,
broader media formats, platform-specific metrics and inbox permissions have
their separately documented limits. Hosted domain/mail/operations and deferred
payment acceptance remain separate launch work.
