# Built browser acceptance for weekly editorial plans

Date: 2026-10-01. Verified source:
`3d91a2aaab826fd645a59c7da6f27b73ab3fd47f`.
The integrating agent confirmed that `68999069` has the same source tree.
This record covers the dedicated browser journey, not the subsequent whole-project gate.

## Environment and commands

The runner owns a disposable PostgreSQL 16 container, media directory, receipt
directory and compiled API/worker/web process groups. Its environment is an
explicit allowlist with synthetic credentials. It refuses Next production
dotenv files without reading their contents. The migration journal ends at
`1790842335842`, matching migration `0126`.

```sh
pnpm install --frozen-lockfile --offline
node --test scripts/recurring-model-fixture.test.mjs
pnpm exec tsc --noEmit -p scripts/e2e
node scripts/e2e/recurring.run.mjs
```

The pure fixture guards passed **7/7**, with no skips. The scripts TypeScript
check and scoped Biome checks passed. The final runner's build reported
**11/11 successful, 11 cached**; affected application builds had been rebuilt
after each integrated UI fix. The final browser journey passed **1/1 in 4.0
minutes**. Local log: `/tmp/pubrick-recurring-browser-3d91a2aa.log`.

## Observed user journey

The browser signs up, creates a fresh organization, brand and manual channel,
saves a synthetic Google key through Settings, and selects the model. It creates
a disabled weekly plan, previews its finite UTC schedule and enables it with
explicit paid-generation consent. Its first occurrence is a real upcoming UTC
minute, not a manipulated clock or database schedule.

Real pg-boss planner/calendar jobs and the compiled generation worker produce
exactly one draft with one adaptation. Five scripted Google SDK role responses
match five successful checkpoints and five metering ledger rows: researcher,
writer, editor, factcheck and the actual channel adapter. The unique journey
marker survives into the adaptation. The human opens the draft, edits it and
saves the edit. The journey never approves or publishes it.

Pause/resume retains the same future occurrence identity. The browser waits for
the real queued materializer and observes **Planned** in the UI without a manual
reload. It skips that occurrence and observes both the disappeared calendar
slot and permanent skipped summary. A real global planner job completes after
the skip; the skip remains terminal. Removing the plan retains its tombstone
and immutable dispatched occurrence. Final observations prove one generation
run, five calls, zero publications and zero publication jobs.

The initial calendar and plan form were exercised at **375 × 812** with
horizontal-overflow assertions. Consent was toggled with Space; Tab/Shift+Tab
verified focus movement, and Enter activated Enable. These checks also run on
resume. The final desktop viewport is **1280 × 900**.

## Product findings and corrections

1. Saving the first key while editing the provider/model left the Settings
   authority revision stale. The unchanged browser action failed with HTTP 409
   `ai_settings_changed`. The UI fix advances the saved baseline while retaining
   the dirty draft; its focused regression suite passed 27/27. Integration:
   `5ce92b19`.
2. Resume enqueued asynchronous replanning but the calendar summary remained
   suspended after the worker completed. The UI now polls the summary without
   discarding an unsaved draft or open history, and distinguishes pending
   replanning. Its focused suite passed 35/35. Integration: `ac6065b9`. The final
   journey proves the resulting Planned state without reload.

The fixture also needed corrections: adapter receipts must use the actual
channel UUID; environment isolation must include Next's dotenv loader paths;
resume requires bounded observation of real asynchronous materialization; and
PostgreSQL DATE observations must preserve civil dates using `::text` plus
runtime schema validation rather than host-timezone conversion. Earlier runs
that exposed these issues were failures, not acceptance passes. An initial cold
build was deliberately interrupted after fixture review found two blockers.

## Transport scope, artifacts and cleanup

Only the compiled worker receives the test-only Node fetch preload. It accepts
the exact Google structured-generation endpoint, synthetic key, recognized role
and unique journey marker. Unexpected fetches durably latch a failure before
throwing; receipt-write failures terminate the worker. The runner checks failure
receipts and worker exits outside Playwright polling. No request is forwarded
by this preload and no live provider call was made. This proves the Google SDK
fetch transport, not a universal firewall for every Node networking API.

Final screenshots remain in the ignored local artifact directory:

```text
/tmp/pubrick-recurring-browser-acceptance/.data/recurring-browser-tests/recurring-journey-weekly-p-08be3-e-resume-and-permanent-skip/weekly-plan-mobile-preview.png
/tmp/pubrick-recurring-browser-acceptance/.data/recurring-browser-tests/recurring-journey-weekly-p-08be3-e-resume-and-permanent-skip/weekly-plan-mobile-consent.png
```

The preview is the full mobile page (375 × 4543); visual inspection found no
additional layout defect. The consent filename is reused on resume, so the
retained consent image is desktop evidence, not the initial mobile dialog.
Mobile dialog geometry and keyboard assertions nevertheless passed.

The successful runner removed its owned stack
`pubrick-browser-recurring-3d309a6c-c7cd-4d8f-9bcf-df3906b78508`, its container
volumes, temporary media and successful receipts, and awaited child-process
shutdown. A subsequent Docker inspection confirmed the container no longer
exists. Build outputs/dependencies remain reusable. Earlier sanitized failure
logs, screenshots and synthetic receipts remain for diagnosis. No development
or production data was cleaned by this runner.
