import { Injectable, Logger, Optional } from "@nestjs/common";
import {
  getPublisher,
  PermanentPublishError,
  type Publisher,
  type PublishResult,
} from "@pubrick/integrations";
import type { PublishJob } from "@pubrick/shared";
import { env } from "../env";
import { PublishRepository } from "./publish.repository";

export type { PublishJob } from "@pubrick/shared";

type PublisherLookup = (platform: string) => Publisher<never> | undefined;

/** Bounded — this is riding out a transient DB hiccup, not retrying forever. */
const MARK_PUBLISHED_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";
const PUBLISHED_PUBLICATION_INDEX = "publications_one_published_per_adaptation";

/**
 * Is this the "a published publications row for this adaptation already
 * exists" violation, as opposed to any other write failure?
 *
 * Checks the error and its `cause`: drizzle wraps the driver's error, but the
 * `code`/`constraint` fields belong to node-postgres's `DatabaseError`
 * underneath. Narrow on BOTH the SQLSTATE and the index name — a different
 * unique violation is a real bug and must keep its loud failure path.
 */
function isDuplicatePublication(error: unknown): boolean {
  type PgLike = { code?: unknown; constraint?: unknown; cause?: unknown };
  const candidates = [error, (error as PgLike | undefined)?.cause];
  return candidates.some((candidate) => {
    const pg = candidate as PgLike | undefined;
    return pg?.code === UNIQUE_VIOLATION && pg?.constraint === PUBLISHED_PUBLICATION_INDEX;
  });
}

@Injectable()
export class PublishService {
  private readonly logger = new Logger(PublishService.name);

  /**
   * The three parameters after `repo` are seams for tests (`publish.service.spec.ts`
   * constructs this with `new PublishService(repo, fakeLookup, ...)` directly, never
   * through Nest), not real providers — `PublisherLookup` reflects as bare `Object`
   * and `string`/`number` reflect as `String`/`Number`, none of which have a
   * registered provider in `WorkerModule`. Nest's real DI path (`main.ts` ->
   * `NestFactory.createApplicationContext(WorkerModule)`) resolves every
   * constructor parameter through the container by its reflected type and throws
   * `UnknownDependenciesException` for an unresolvable one UNLESS it's `@Optional()`
   * — without it the worker process cannot boot at all (confirmed by actually
   * running `dist/main.cjs`, not just the vitest specs, which all bypass Nest's
   * injector for this class). `@Optional()` makes Nest pass `undefined` for these
   * three instead of throwing, which is exactly what lets the TS default values
   * below apply, same as a plain `new PublishService(repo)` call would.
   */
  constructor(
    private readonly repo: PublishRepository,
    @Optional() private readonly lookup: PublisherLookup = getPublisher,
    @Optional() private readonly baseUrl: string = env.TELEGRAM_API_BASE_URL,
    /** Backoff unit between markPublished retries; 0 in tests for determinism. */
    @Optional() private readonly markPublishedRetryDelayMs: number = 200,
  ) {}

  async handle(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation || adaptation.status === "published") return;

    // Defense in depth against a delivered rejection. The api cancels the
    // pg-boss job when an approved item is rejected, but a job that was
    // already fetched, or one that outlived the cancel for any reason, must
    // still not go out: the parent item's status is the user's decision and
    // this handler is the last place that can honour it. Returning normally
    // completes the job — there is nothing to retry, the user said no.
    if (adaptation.itemStatus === "rejected") {
      this.logger.log(
        `Skipping publish for adaptation ${job.adaptationId}: content item was rejected`,
      );
      return;
    }

    // The durable "already delivered" check, independent of the adaptation's
    // own status column (which the api can move back on a re-approve). Backed
    // by the partial unique index on publications, so even a lost race here
    // cannot produce two `published` ROWS for one adaptation — note that this
    // bounds the record, not the send: the window between this check and
    // markPublished is real, and a crash inside it can still post twice.
    if (await this.repo.hasPublished(job.orgId, job.adaptationId)) {
      this.logger.warn(
        `Skipping publish for adaptation ${job.adaptationId}: a published publication already exists`,
      );
      return;
    }

    const publisher = this.lookup(adaptation.platform);
    if (!publisher) {
      await this.safeMarkFailed(
        job.orgId,
        job.adaptationId,
        `No adapter for platform ${adaptation.platform}`,
      );
      return;
    }

    // Claiming is conditional on the adaptation still being publishable. A
    // lost claim means the api changed the row (rejected, re-approved) between
    // load() and here, under the row lock — do not send, and do not fail the
    // adaptation either: its new status is the truth now.
    if (!(await this.repo.markPublishing(job.orgId, job.adaptationId))) {
      this.logger.log(
        `Skipping publish for adaptation ${job.adaptationId}: no longer in a publishable status`,
      );
      return;
    }
    const text = adaptation.body ?? adaptation.itemBody;

    // Everything that can still be safely retried lives in this try — nothing
    // in here has told the platform to post yet. Once publisher.publish()
    // resolves, the post is live and this handler must never throw again
    // (see recordPublished below).
    let result: PublishResult;
    try {
      let credentials: Record<string, string>;
      try {
        credentials = await this.repo.credentials(job.orgId, adaptation.channelId);
      } catch (credentialsError) {
        // The two failures repo.credentials() actually produces — the
        // channel row is gone, or credentialsEncrypted fails to decrypt
        // (wrong key / corrupted ciphertext) — are both deterministic:
        // retrying with the same DB row and the same encryption key will
        // fail identically every time. Classify as permanent, same as any
        // other config/data problem, instead of letting pg-boss retry a
        // job that can never succeed. (A genuinely transient DB blip on the
        // SELECT itself would also land here and get misclassified as
        // permanent, but markPublishing just wrote successfully immediately
        // before this, so the DB was reachable moments ago — and even in
        // that rare case, the adaptation can still be re-approved by hand,
        // which beats risking a duplicate send by guessing the other way.)
        const message =
          credentialsError instanceof Error ? credentialsError.message : String(credentialsError);
        throw new PermanentPublishError(`Could not load credentials: ${message}`);
      }
      // Validate against the adapter's own schema before sending, the same way
      // the api's connection test does. Stored credentials can be malformed
      // (saved before a schema change, hand-edited, wrong platform), and
      // without this the adapter sends them anyway and the operator sees an
      // opaque platform error ("Telegram 400: Bad Request") instead of being
      // told which field is wrong. Deterministic, so it is permanent: no
      // amount of retrying fixes a missing chatId.
      const parsed = publisher.credentialsSchema.safeParse(credentials);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new PermanentPublishError(
          `Stored credentials are not valid for platform ${adaptation.platform}: ${detail}`,
        );
      }
      result = await publisher.publish(parsed.data, { text }, { baseUrl: this.baseUrl });
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof PermanentPublishError) {
        // Never retried: returning normally completes the pg-boss job.
        // Nothing was accepted by the platform on this branch (publish()
        // itself rejected it, or we never got as far as calling it) — no
        // duplicate-post risk here, unlike recordPublished below.
        await this.safeMarkFailed(job.orgId, job.adaptationId, message);
        return;
      }
      await this.repo.recordTransient(job.orgId, job.adaptationId, message);
      throw error;
    }

    // publish() resolved: the platform ACCEPTED the post. From this point on,
    // handle() must never throw. A thrown error here would make pg-boss retry
    // the whole job, which calls publisher.publish() again — posting a SECOND
    // message the platform has no way to know is a retry. A stale or missing
    // `publications` row is recoverable later (reconciliation, logs); a
    // duplicate post in someone's channel is not.
    await this.recordPublished(job.orgId, job.adaptationId, result);
  }

  /**
   * pg-boss DLQ consumer: the `publish` queue's `retryLimit` was exhausted
   * without a permanent error ever firing (every attempt was transient —
   * rate limits, timeouts, platform outages). The adaptation is stuck in
   * `publishing` with no more retries coming, so this is the last chance to
   * land it in a terminal state instead of leaving it silently stalled.
   *
   * Idempotent: pg-boss's dead-letter delivery is at-least-once, so a second
   * delivery for the same job must not re-fail an adaptation that a later,
   * unrelated re-approve has already moved on from, and must not insert a
   * second `publications` row for the same terminal outcome.
   *
   * Guarded on `publishing`, the ONLY status this is ever legitimately called
   * for, rather than on "not published and not failed". The old guard let
   * every other status through — and by the time a dead-letter copy is
   * delivered, the adaptation may well have been re-approved (`queued` /
   * `scheduled`) or rejected back to `pending`. Failing it then would clobber
   * a live job's adaptation with the corpse of an attempt that is already
   * over.
   */
  async markExhausted(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation) return;
    if (adaptation.status !== "publishing") return;

    await this.safeMarkFailed(job.orgId, job.adaptationId, "Retries exhausted");
  }

  /**
   * The post is already live on the platform by the time this runs. Retries
   * a small bounded number of times to ride out a transient DB hiccup
   * (dropped connection, deadlock, pool exhaustion), then — if it still
   * can't write — logs loudly with everything an operator needs to
   * reconcile by hand, and returns normally. This must NEVER throw: the only
   * alternative response to a persistent failure here is "leave a stale row
   * and move on", because rethrowing would make pg-boss retry the whole job
   * and re-send the post.
   */
  private async recordPublished(
    orgId: string,
    adaptationId: string,
    result: PublishResult,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MARK_PUBLISHED_MAX_ATTEMPTS; attempt++) {
      try {
        await this.repo.markPublished(orgId, adaptationId, result);
        return;
      } catch (error) {
        // Not a failure: a `published` publications row for this adaptation
        // already exists, which is exactly the state this method is trying to
        // reach. Reachable through the residual duplicate-send window, and
        // through an ambiguous commit (the transaction landed but the client
        // saw the connection drop and retried). Retrying can only reproduce
        // it, so converge the adaptation's status instead of burning all three
        // attempts and then crying "manual reconciliation needed" about a post
        // that is correctly recorded.
        if (isDuplicatePublication(error)) {
          await this.convergeAlreadyPublished(orgId, adaptationId);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === MARK_PUBLISHED_MAX_ATTEMPTS) {
          this.logger.error(
            "PUBLISH RECORDING FAILED: the post WAS delivered to the platform but could not be " +
              `recorded after ${MARK_PUBLISHED_MAX_ATTEMPTS} attempts — manual reconciliation needed. ` +
              `orgId=${orgId} adaptationId=${adaptationId} externalId=${result.externalId ?? "null"} ` +
              `externalUrl=${result.externalUrl ?? "null"} lastError=${message}`,
          );
          return;
        }
        await sleep(this.markPublishedRetryDelayMs * attempt);
      }
    }
  }

  /**
   * The delivery is already recorded; only the adaptation's own status is out
   * of date. Same "must never throw" contract as `recordPublished` — the post
   * is live, so a rethrow here would hand pg-boss a reason to re-send it.
   */
  private async convergeAlreadyPublished(orgId: string, adaptationId: string): Promise<void> {
    try {
      await this.repo.markAlreadyPublished(orgId, adaptationId);
      this.logger.log(
        `Publication already recorded for adaptation ${adaptationId}; converged status to published`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "PUBLISH STATUS CONVERGENCE FAILED: the post was delivered AND recorded, but the " +
          `adaptation's own status could not be updated — it may be stuck in "publishing". ` +
          `orgId=${orgId} adaptationId=${adaptationId} error=${message}`,
      );
    }
  }

  /**
   * Writes a terminal `failed` state for a job that must never be retried
   * (no adapter for the platform, a permanent publish/credentials error, or
   * DLQ exhaustion). If the write itself throws, rethrowing would hand
   * pg-boss a reason to retry a job whose entire point was "do not retry
   * this" — so this logs and returns instead of propagating. Unlike
   * recordPublished, nothing was ever delivered to the platform on any of
   * these paths, so a missing failed-state write means a stuck/inconsistent
   * adaptation status to reconcile manually — never a duplicate post.
   */
  private async safeMarkFailed(orgId: string, adaptationId: string, reason: string): Promise<void> {
    try {
      await this.repo.markFailed(orgId, adaptationId, reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "MARK FAILED WRITE FAILED: could not record a terminal failure — the adaptation may be stuck " +
          `in a non-terminal status. orgId=${orgId} adaptationId=${adaptationId} reason=${reason} ` +
          `error=${message}`,
      );
    }
  }
}
