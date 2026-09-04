/**
 * The queue contracts — publish and generate: queue names, queue options,
 * `work()` options and job payloads.
 *
 * The producer (`apps/api`) and the consumer (`apps/worker`) are separately
 * deployable apps that never import each other, so both sides used to declare
 * these independently — two copies of the same names and the same options
 * object with nothing checking they agreed. A silent drift (a renamed queue, a
 * different `deadLetter`, a shorter `expireInSeconds` on one side) would not
 * fail any build or test; it would just stop posts from being delivered. They
 * share `@pubrick/shared`, so the contract lives here and both sides import it.
 *
 * Deliberately free of a pg-boss import: `@pubrick/shared` has no runtime
 * dependency beyond zod (see CLAUDE.md). `PUBLISH_QUEUE_OPTIONS` is a plain
 * object that is structurally assignable to pg-boss's `QueueOptions`, which is
 * what `createQueue` actually requires; `GENERATE_WORK_OPTIONS` likewise to
 * `WorkOptions`, which is what `work()` requires.
 */

/** Queue the api enqueues to and the worker consumes. */
export const PUBLISH_QUEUE = "publish";

/** Dead-letter queue for publish jobs whose retries were exhausted. */
export const PUBLISH_DLQ = "publish-dlq";

/** The payload of one publish job. Written by the api, read by the worker. */
export type PublishJob = { adaptationId: string; orgId: string };

/**
 * Queue options, passed to `boss.createQueue(PUBLISH_QUEUE, ...)` by both sides.
 *
 * `heartbeatSeconds` is what keeps a genuinely dead worker from stranding a
 * job: pg-boss's `work()` refreshes `heartbeat_on` every `heartbeatSeconds / 2`
 * while a handler is running, and the maintenance pass fails/retries any active
 * job whose heartbeat went stale. Note that in pg-boss v12 a heartbeat does NOT
 * extend `expireInSeconds` — `failJobsByTimeout` still fires on
 * `started_on + expire_seconds < now()` regardless (see
 * pg-boss/dist/plans.js `failJobsByTimeout`). So the previous `expireInSeconds:
 * 120` would have reclaimed and re-run a live, healthy handler — and a re-run
 * after a successful send is a duplicate post. The expiry is therefore a
 * generous upper bound on one whole publish attempt, and liveness is detected
 * by the heartbeat (within 30s, much faster than the old 120s) instead.
 */
export const PUBLISH_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 3600,
  /** Upper bound on a single publish attempt, not a liveness check — see above. */
  expireInSeconds: 600,
  /** Must be >= 10 (pg-boss constraint). Liveness check for a running handler. */
  heartbeatSeconds: 30,
  deadLetter: PUBLISH_DLQ,
} as const;

/** Queue the api enqueues generation runs to and the worker consumes. */
export const GENERATE_QUEUE = "generate";

/** Dead-letter queue for generation jobs whose retries were exhausted. */
export const GENERATE_DLQ = "generate-dlq";

/**
 * The payload of one generation job. Written by the api, read by the worker.
 *
 * ONE job per RUN, not per step: steps are cheap to resume from their
 * checkpoints (`pipeline_runs.steps`) and expensive to re-run, so splitting the
 * run into five jobs would buy nothing and multiply the ways a partially
 * finished run can be re-dispatched.
 *
 * `orgId` rides along even though it is derivable from the run row: the worker
 * scopes every query by it (house rule), and the cancel path finds jobs BY
 * PAYLOAD (`findJobs({ data: { runId, orgId } })`), so it has to be in the data.
 */
export type GenerateJob = { runId: string; orgId: string };

/**
 * Queue options, passed to `boss.createQueue(GENERATE_QUEUE, ...)` by both sides.
 *
 * Retries are fewer and slower than publish's: a generation attempt costs money
 * at a provider, so retrying it five times 30s apart would burn an org's budget
 * on what is usually a provider outage. Three attempts with an exponentially
 * backed-off 60s floor gives a transient 429/5xx room to clear; the checkpoint
 * map means a retry resumes rather than re-spending on steps that succeeded.
 *
 * `expireInSeconds: 1800` is an upper bound on ONE WHOLE five-step run (five
 * model calls plus one per channel), not a liveness check. As on the publish
 * queue, a pg-boss v12 heartbeat does NOT extend it: `failJobsByTimeout` fires
 * on `started_on + expire_seconds < now()` regardless, and it cannot kill the
 * original handler — so expiry can and will re-dispatch a job whose first
 * handler is still alive. That is why the handler is FENCED via
 * `pipeline_runs.active_job_id` (generation-engine spec §5): without the fence, two live handlers
 * would both skip the same checkpoints, both re-run the rest (double spend) and
 * both reach the terminal write, producing two content items for one run.
 * `heartbeatSeconds` is what detects a genuinely dead worker, within 30s.
 *
 * `deadLetter` is part of the set, not an afterthought: the DLQ consumer is
 * what marks a run `failed` once pg-boss has spent its retries, mirroring
 * `markExhausted` on the publish side. Without it a run whose retries ran out
 * would sit at `running` on the queue strip forever — the silent failure the
 * whole strip exists to prevent.
 *
 * WHY `heartbeatSeconds` IS STILL 30, AND WHAT PAYS FOR THAT. The two kinds of
 * re-dispatch are not equally safe, and the difference is in pg-boss's wrapper
 * (`Manager#processJobs`), not in this file:
 *
 *  - EXPIRY. The wrapper races the handler against
 *    `resolveWithinSeconds(…, expireInSeconds, ac)`. When the timer wins, the
 *    race rejects, the wrapper fails that job ITSELF and stops awaiting the
 *    handler, and `ac` — the handler's `signal` — is aborted. Whatever the
 *    abandoned handler does afterwards settles nothing: the wrapper is gone.
 *    Safe.
 *  - HEARTBEAT. The supervisor's `failJobsByHeartbeat` fails the job from the
 *    OUTSIDE while the wrapper is still awaiting the handler, and `failJobsBody`
 *    re-inserts it under the SAME id. Handler B takes it over. When handler A
 *    finally returns — normally, having correctly lost the fence — the wrapper
 *    runs `complete(name, [id])`, guarded `state = 'active'`, and the active
 *    incarnation of that id is B's. B's live job goes `completed` under it, and
 *    from then on nothing can retry or dead-letter that run: `failJobsById` is
 *    guarded `state < 'completed'`. NOT safe.
 *
 * So raising this number narrows the unsafe window, and it is worth saying
 * plainly why that is not the fix taken. It cannot CLOSE the window: any
 * threshold is exceeded by a long enough stall, and a rarer permanent stall is
 * a permanent stall that gets diagnosed later. It is not free in the other
 * direction either — a genuinely dead worker's run is stranded for
 * `heartbeatSeconds` plus a supervise interval before anything re-dispatches
 * it, so raising this SLOWS the recovery it exists to provide. On the publish
 * queue it is not even a free parameter: `MARK_PUBLISHED_MAX_ATTEMPTS` is
 * derived from `PUBLISH_QUEUE_OPTIONS.heartbeatSeconds` and asserted against
 * it, and `PUBLISH_STOP_TIMEOUT_MS` from that, so raising the publish heartbeat
 * to five minutes would make every graceful shutdown wait five minutes. And
 * this whole object is a pinned wire contract between two separately deployable
 * apps (`apps/api/src/queue/queue.service.spec.ts` asserts it member by
 * member), so moving a number in it is a cross-app change, not a tuning knob.
 *
 * What closes the hole instead is recovery that does not depend on the window
 * being narrow: the scheduled sweep in `QueueService.registerAll`, which fails
 * any run left `running` past its lease with no live job behind it. See
 * `GenerateRepository.sweepAbandoned`. The equivalent state on the publish
 * queue — an adaptation stuck in `publishing` with no job — is real and is NOT
 * yet swept.
 */
export const GENERATE_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 3600,
  /** Upper bound on one whole five-step run, not a liveness check — see above. */
  expireInSeconds: 1800,
  /** Must be >= 10 (pg-boss constraint). Liveness check for a running handler. */
  heartbeatSeconds: 30,
  deadLetter: GENERATE_DLQ,
} as const;

/**
 * `work()` options for the generate queue, shared for exactly the reason the
 * queue options are: the producer and the consumer must not drift.
 *
 * `groupConcurrency` is a `work()` option, NOT a `QueueOptions` field, so it
 * cannot live in `GENERATE_QUEUE_OPTIONS` above — verified against the
 * installed pg-boss v12 typings, where it is declared on
 * `WorkConcurrencyOptions` (`WorkOptions = JobFetchOptions & JobPollingOptions
 * & WorkConcurrencyOptions & …`, pg-boss/dist/types.d.ts) and is absent from
 * `QueueOptions`. Putting it in the queue options object would not be a type
 * error at the `createQueue` call site either — `createQueue` takes
 * `Omit<Queue, "name">`, whose excess-property check the spread `{ ...OPTIONS }`
 * defeats — it would simply be dropped on the floor, and nothing would cap
 * per-org concurrency.
 *
 * `groupConcurrency: 1` with `group: { id: orgId }` at send time serialises one
 * org's runs across the whole cluster (it is the database-tracked variant, not
 * the per-node `localGroupConcurrency`), so a single org cannot occupy every
 * worker slot. It bounds CONCURRENCY, never SPEND: fifty queued runs still cost
 * fifty runs, one after another. Bounding spend is the API's admission cap
 * (`MAX_CONCURRENT_RUNS`), and neither substitutes for the other.
 */
export const GENERATE_WORK_OPTIONS = { batchSize: 1, groupConcurrency: 1 } as const;
