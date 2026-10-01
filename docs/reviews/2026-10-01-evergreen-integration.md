# Evergreen reuse integration acceptance

Date: 2026-10-01. Browser/source candidate:
`d5d02ac5d3b955e8f1f139ff8e3264d291ee3a76`, on
`codex/evergreen-validation`. Tracking: `Ozon-tools-3xwei`.
Main release and automatic deployment require separate exact-head authorization.

## Accepted workflow

The compiled API, worker and web journey passed: one browser scenario in
8.2 seconds after build/readiness, with a real disposable PostgreSQL database.
It creates an account, organization, brand, manual T—Ж channel and saved master;
cancels paid confirmation; confirms one reuse; observes the successful run;
opens the independent draft; saves a human edit; and reloads it.

Assertions establish:

- Cancel leaves zero reuse operations, runs and scripted provider calls.
- Admission yields exactly one tenant-owned operation, one run and one ID-only
  generation job, bound to the request key, source revision and resulting run.
- Five scripted roles complete with five successful usage-ledger entries:
  researcher, writer, editor, claims-to-verify and the selected channel adapter.
  This is one successful fixture configuration, not a universal call count.
- The new master/version is AI-origin and unopened before the person visits it;
  its adaptation is pending and unscheduled, with no attempts or copied media.
- Source attribution is visible and links to the accessible original. The human
  edit changes only the derived draft; the saved master remains unchanged.
- No publication, publish job, calendar slot, media asset or image slot exists.
- At 375 × 812, keyboard Space checks paid consent; the document has no horizontal
  overflow. The retained consent screenshot was visually inspected: source,
  instructions, charge disclosure, checkbox and Cancel/Generate are readable.

Host runtime: Node 26.0.0, pnpm 10.34.5, Playwright 1.63.0 with Chromium
153.0.8010.12 (revision 1243). The executed PostgreSQL image resolved to the
repository's pinned digest
`sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b`.
The runner currently starts its mutable `pg16` tag; this receipt records the
actual resolution, not a universal reproducibility guarantee for that runner.
Git source reporting was verified with the Command Line Tools developer directory.

The scripted worker transport accepts synthetic fixture requests only and has
no Google forwarding. It does not prove live provider access or restrict all
possible Node networking APIs. Owned application processes, database container
and volumes, and temporary media were removed after the run. User installations
and secrets were not used or changed.

## Retained failures and affected closures

The first browser execution reached a successful generation, then failed its
operation-count assertion. Its test treated the public brand response as if it
contained `orgId`, although that projection deliberately omits tenant identity.
The audit query therefore used SQL NULL. `d5d02ac5` resolves the UI-created brand
through a parameterized read-only database query and requires one nonempty
tenant identity before every audit assertion. Independent source review passed;
the corrected full journey then passed. Assertions were not removed or relaxed.
The original trace and screenshots were preserved before rerunning.

The package gate also retained failures rather than calling its first execution
green. Historical migration timeouts, an IPv6/IPv4 localhost test mismatch,
billing fixture naming, export staging capacity, and a real export entry-stream
error were investigated separately. See the
[migration and proxy closure](2026-10-01-evergreen-migration-environment.md) and
[export regression](2026-10-01-workspace-export-entry-errors.md).
The export regression fails on original source with an uncaught error and passes
on the fix; no production safety limit was weakened.

## Composite integration gate

The table counts distinct package cases once, including affected closures.
It combines the integrated baseline and serialized Linux executions with the
subsequent affected reruns; it is **not** a fresh single all-green command.

| Package | Distinct passing cases | Execution scope |
| --- | ---: | --- |
| Shared | 533 | Integrated baseline, unchanged afterward |
| Telegram | 32 | Integrated baseline, unchanged afterward |
| Search | 9 | Integrated baseline, unchanged afterward |
| Billing | 88 | Integrated baseline, unchanged afterward |
| Database | 263 | Linux: 57 migration and 206 remaining cases |
| Mail | 23 | Serialized Linux gate |
| AI | 434 | 433 initial passes; affected proxy file then 10/10 |
| MCP | 32 | Serialized Linux gate |
| Web | 1,586 | Serialized Linux gate |
| Integrations | 134 | Serialized Linux gate |
| Worker | 644 | Serialized Linux gate |
| API | 1,273 | 1,256 initial passes; five failures and 11 setup-skipped cases closed; one new regression |
| **Total** | **5,051** | No duplicate affected cases added |

The corrected API fixture tier passed all 23 cases in three affected files.
After the production stream fix, all 16 export/service/staging cases passed
without unhandled errors. The original 11 billing setup skips were subsequently
executed successfully; they are not represented as accepted skips.
Focused UI and native concurrency/erasure evidence remain documented in the
[UI](2026-10-01-evergreen-reuse-ui.md),
[backend](2026-10-01-evergreen-reuse-backend.md) and
[selected guard](2026-10-01-evergreen-native-guards.md) receipts.

Final candidate checks: 20/20 typecheck tasks passed (ten cached), repository
Biome checked 1,069 files, and root scripts passed 50 with three explicitly
opt-in checks skipped. The browser build dependency tier completed 11/11 tasks
from valid cache; the earlier integrated full build passed 12/12. Browser
TypeScript, scoped fixture lint and independent tenant-assertion review passed.
No remote workflow was manually dispatched for these local checks.

Local raw logs and synthetic screenshots are retained outside the disposable
stack at `/Users/admin/.codex/backups/pubrick-validation-20261001/`, including
`evergreen-browser-tenant-closure.log`, the first browser failure artifacts,
Linux gate/closure logs and final typecheck/lint/script logs. These are private
execution artifacts, not required runtime files or public user content.

## Product boundaries

Reuse accepts at most 8,000 normalized characters from an eligible saved master
within the same brand, with explicit paid consent. No automatic evergreen
schedule, copied media, inherited approval or automatic publication is included.
Pending request recovery uses memory within one tab's application lifetime;
hard reload or tab closure loses that local key. Server audit remains durable.
Terminal source erasure retains independent output, versions, consent and usage;
it does not erase provider-held requests or rewrite generated quotations.
The [user guide](../evergreen-draft-reuse.md) describes these limits.
