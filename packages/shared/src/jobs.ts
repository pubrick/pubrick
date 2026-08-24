/**
 * The publish queue contract: queue names, queue options and job payload.
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
 * what `createQueue` actually requires.
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
