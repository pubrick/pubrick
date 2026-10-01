# Evergreen reuse: independent native guard proofs

Date: 2026-10-01. Backend baseline: `e25b88c0`.
Regression: `adbb805dd39006d4e4821b943a020f44469abd63`, branch
`codex/evergreen-guard-review`. This record covers three selected predicates,
not complete feature acceptance or every admission/deletion guard.

## Isolation and baseline

The reviewer used a separate checkout at `/tmp/pubrick-evergreen-guard-review`
and its own disposable database `pubrick_reuse_guard_5fc1d28a_test` on the
author-transferred loopback PostgreSQL 16.15 container. No other agent ran
heavy checks during these proofs. Fixtures used synthetic secrets/content;
no provider calls, publication, main push or CI dispatch occurred.

The admission file creates, migrates and drops its own UUID-named database
per invocation. The erasure file uses the reviewer's separate base database
and removes only its owned tenant/user rows. Both real PostgreSQL fixtures
were selected through the maintained runner:

```sh
node scripts/mutation-check.mjs @pubrick/api --runs 3 --files \
  src/content/content-reuse.e2e.spec.ts \
  src/content/content-reuse-erasure.e2e.spec.ts
```

Both database environment variables named the reviewer's database. Runtime
identity was self-hosted with synthetic authentication/encryption values and
SMTP disabled. The final baseline passed **21/21 cases in each of three runs**;
the restored baseline repeated the same result. This is focused verification,
not a whole-package mutation or monorepo acceptance claim.

The prerequisite package build passed seven cached tasks; API typecheck and
scoped Biome checks passed. An initial baseline also passed three times before
the fixture's reviewed failure-path cleanup improvement; its log is retained.

## Final source CAS regression

The existing title-edit race also trips the adjacent prepared-title equality
check, so it cannot independently pin the final revision/digest comparison.
The added regression changes only `rich_body` under a real PostgreSQL lock.
`RETURNING` proves unchanged plain body/title and the actual trigger's revision
increment. A request prepares the old snapshot, is observed waiting on source
`FOR SHARE`, then resumes after the edit commits. It must return coded 409 and
leave zero operation, lineage, run and queue-job rows.

Another agent reviewed the fixture's causal isolation and cleanup. BEGIN,
UPDATE and request creation are inside `try`; cleanup rolls back, drains the
pending request and releases the connection even on failure.

## Mutations and observed causes

Each mutation changed one production predicate or assignment, retained all
other guards and ran the same two-file command three times. Each produced
**20 passes and the same one failure in all three runs**.

| Guard | Single mutation | Exact failure |
| --- | --- | --- |
| Final locked-source CAS | Remove only `this.compare(current, data)` in the fresh reuse callback | The new rich-body-only race received HTTP **201**, where coded **409 `reuse_source_changed`** was required. Prepared material/title checks still passed. |
| Deletion-side brand serialization | Change source deletion's brand lock from `FOR NO KEY UPDATE` to `FOR KEY SHARE` | The genuine overlap fixture's observed-lock assertion received **false**, where **true** was required. Other cases passed. |
| Terminal checkpoint erasure | Remove only `steps: {}` from terminal related-run redaction | Input was already `{ kind: "redacted" }`, but the raw stored writer checkpoint still contained the synthetic source material; the exact empty-steps assertion failed. |

Targeted diagnostic runs retained JSON reports and default-reporter assertion
diffs to distinguish these failures from boot, migration, timeout or unrelated
fixture errors. No inconclusive host outcomes occurred. Diagnostic filtering
is separate from the three-run verdicts and is not added to passing-case counts.

## Retained evidence and cleanup

Official runner logs remain locally:

- `/tmp/pubrick-evergreen-guard-clean-baseline-3.log`
- `/tmp/pubrick-evergreen-guard-cas-mutant-3.log`
- `/tmp/pubrick-evergreen-guard-brand-mutant-3.log`
- `/tmp/pubrick-evergreen-guard-steps-mutant-3.log`
- `/tmp/pubrick-evergreen-guard-restored-3.log`

Exact mutation patches and targeted diagnostic JSON/logs use the same
`/tmp/pubrick-evergreen-guard-{cas,brand,steps}` prefix. The maintained runner
removes its temporary JSON reports; its verdict logs are retained. CAS's
default-reporter diagnostic carries the HTTP 201/409 diff.

Every production mutation was restored before the final clean runs. The owned
base database was dropped; a PostgreSQL catalog query also confirmed no
UUID-named admission-fixture database remained. The borrowed container was
left intact for its owner; the coordinator and UI author received the heavy
slot release and cleanup handoff.

These proofs pin final revision/digest CAS, the deletion-side strong brand lock
and checkpoint clearing. They do **not** independently pin every admission or
retry writer's lock, the redundant live-run predicate, every other redaction
field, public transport or built-browser behavior. Those claims require their
own relevant acceptance evidence.
