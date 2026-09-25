import { readFile } from "node:fs/promises";
import path from "node:path";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  BLUESKY_REQUEST_TIMEOUT_MS,
  getPublisher,
  MASTODON_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  PartialTelegramPublishError,
  PermanentPublishError,
  PlatformRejectionError,
  type Publisher,
  type PublishResult,
  TELEGRAM_REQUEST_TIMEOUT_MS,
  UnknownOutcomePublishError,
  VK_REQUEST_TIMEOUT_MS,
} from "@pubrick/integrations";
import {
  isUnreadableCiphertext,
  PUBLISH_QUEUE_OPTIONS,
  type PublishFailureReason,
  type PublishJob,
  UNREADABLE_CREDENTIALS_MESSAGE,
} from "@pubrick/shared";
import { env } from "../env";
import {
  type AttemptFence,
  ChannelNotFoundError,
  NoAutomaticCredentialsError,
  type PartialTelegramDelivery,
  PublishRepository,
  type SendClaim,
} from "./publish.repository";

export type { PublishJob } from "@pubrick/shared";

type PublisherLookup = (platform: string) => Publisher<never> | undefined;

/** Backoff unit between markPublished retries; 0 in tests for determinism. */
const DEFAULT_MARK_PUBLISHED_RETRY_DELAY_MS = 200;

/**
 * The post is already live when these retries run, so the budget is not "how
 * long is polite to wait" — it is "how long must this outlast".
 *
 * The thing it has to outlast is pg-boss's own liveness check. `work()`
 * refreshes `heartbeat_on` while a handler runs, and the maintenance pass fails
 * (and therefore REDELIVERS) any active job whose heartbeat went stale by
 * `heartbeatSeconds`. During a database outage the heartbeat cannot be written
 * either — it is a write to the same database — so a recording budget shorter
 * than the heartbeat window guarantees the shape of finding (b): give up on
 * recording after 0.6s, return, have `complete()` throw, and let the supervisor
 * redeliver the job 30s later with nothing on the record to say a post went
 * out. The retry budget must be longer than the outage that triggers the
 * redelivery, or it is not a budget at all.
 *
 * 13 attempts with a 5s-capped doubling backoff spend ~41s of sleeping, which
 * clears the 30s window with room for the writes themselves. Derived from
 * `PUBLISH_QUEUE_OPTIONS.heartbeatSeconds` and asserted against it in
 * publish.service.spec.ts, so shortening the heartbeat fails a test rather than
 * silently reopening the gap.
 */
const MARK_PUBLISHED_MAX_ATTEMPTS = 13;
const MARK_PUBLISHED_RETRY_CAP_MS = 5_000;

/** Backoff before the retry AFTER `attempt`; doubling, capped. */
function markPublishedDelayMs(unitMs: number, attempt: number): number {
  return Math.min(unitMs * 2 ** (attempt - 1), MARK_PUBLISHED_RETRY_CAP_MS);
}

/**
 * Worst-case wall time `recordPublished` can occupy, at the default backoff
 * unit — the sleeping only, since the writes themselves are unbounded from
 * here. Exported because the worker's graceful-shutdown window has to cover it:
 * a stop that gives up while this is still riding out a hiccup fails the job it
 * was recording (apps/worker/src/main.ts).
 */
export const PUBLISH_RECORD_BUDGET_MS = Array.from(
  { length: MARK_PUBLISHED_MAX_ATTEMPTS - 1 },
  (_, i) => markPublishedDelayMs(DEFAULT_MARK_PUBLISHED_RETRY_DELAY_MS, i + 1),
).reduce((total, delay) => total + delay, 0);

/** Heartbeat window this budget must outlast; see MARK_PUBLISHED_MAX_ATTEMPTS. */
export const PUBLISH_HEARTBEAT_WINDOW_MS = PUBLISH_QUEUE_OPTIONS.heartbeatSeconds * 1000;

/**
 * How long a graceful stop must wait for publish handlers before pg-boss's
 * `failWip()` fails whatever is still active (apps/worker/src/main.ts).
 *
 * Derived, not picked, because the failure it prevents is a duplicate post: a
 * job failed by `failWip()` is a job pg-boss redelivers, and a handler
 * interrupted mid-request may already have posted. The window has to cover the
 * longest one attempt can legitimately still be running — all sequential
 * platform requests at their own timeouts, plus the worst case of recording
 * the result afterwards —
 * with margin for the writes themselves. pg-boss's default is 30s, which is
 * exactly the adapter's request timeout and so the worst possible value: a
 * request that started a moment before SIGTERM is guaranteed to be cut off at
 * its most ambiguous point. This is finding (c).
 *
 * Defence in depth, not the primary guard. A SIGKILL, a lost pod, or a stop
 * that runs out anyway still cannot post twice — the in-flight claim outlives
 * the process and the redelivered attempt refuses to send. What a long-enough
 * window buys is that the ordinary case ends as `published` rather than as
 * "outcome unknown, go look at the channel".
 */
export const PUBLISH_STOP_TIMEOUT_MS =
  Math.max(
    // A covered Telegram post may send a photo and then one text reply.
    TELEGRAM_REQUEST_TIMEOUT_MS * 2,
    VK_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    // Bluesky: session, mention resolution, optional cover upload, createRecord.
    BLUESKY_REQUEST_TIMEOUT_MS * 4,
    // Mastodon: instance configuration, then create status.
    MASTODON_REQUEST_TIMEOUT_MS * 2,
  ) +
  PUBLISH_RECORD_BUDGET_MS +
  10_000;

/**
 * Seconds as hours, to one decimal, for a sentence a person reads — ROUNDED IN
 * THE DIRECTION THAT KEEPS THE SENTENCE TRUE.
 *
 * One decimal rather than none because the bound itself can be fractional, and
 * "late by 0 h, past the 0 h limit" is not a sentence anybody can act on. But
 * one decimal on both numbers of a comparison can print a refusal that
 * contradicts itself: a post 6.04 h late against a 6 h bound read "6.0 h later,
 * past the 6.0 h limit", which says the post was inside the limit it was
 * refused for.
 *
 * So the refusal rounds the LATENESS up and the LIMIT down. Both directions
 * keep the claim honest — the post really was later than the printed number,
 * and the limit really was under it — and the two printed numbers can then
 * never be equal, because equality would require the lateness not to exceed the
 * limit, which is the case that never reaches this sentence.
 */
function formatHours(seconds: number, round: (tenths: number) => number = Math.round): string {
  return (round((seconds / 3600) * 10) / 10).toFixed(1);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * A permanent error that already knows WHICH CLASS it is.
 *
 * Three of the reasons on `PUBLISH_FAILURE_REASONS` are raised inside one `try`
 * and caught by one `catch` — unreadable ciphertext, a channel row that is
 * gone, credentials the adapter's schema refuses — and by the time the catch
 * runs, the only thing telling them apart is the sentence, which is exactly
 * what the column exists so that nobody has to read. Carrying the code on the
 * throw is the alternative to re-deriving it from prose.
 *
 * It extends `PermanentPublishError` rather than replacing it, so every
 * `instanceof` on the way out — the catch below, and anything a future caller
 * writes — keeps working unchanged. An error that is NOT one of these is the
 * platform's own refusal out of `publisher.publish()`: `platform_rejected`,
 * which is the default at the catch and the one class whose free text must
 * survive, because Telegram writes it.
 */
class ClassifiedPermanentError extends PermanentPublishError {
  constructor(
    message: string,
    readonly failureReason: PublishFailureReason,
  ) {
    super(message);
  }
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";
const PUBLISHED_PUBLICATION_INDEX = schema.PUBLISHED_PUBLICATION_INDEX_NAME;

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
    @Optional()
    private readonly markPublishedRetryDelayMs: number = DEFAULT_MARK_PUBLISHED_RETRY_DELAY_MS,
  ) {}

  async handle(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation || adaptation.status === "published" || adaptation.platform === "vc_ru") return;

    // Defense in depth against a delivered rejection. The api cancels the
    // pg-boss job when an approved item is rejected, but a job that was
    // already fetched, or one that outlived the cancel for any reason, must
    // still not go out: the parent item's status is the user's decision and
    // this handler is the last place that can honour it. Returning normally
    // completes the job — there is nothing to retry, the user said no.
    if (adaptation.itemStatus === "rejected" || adaptation.itemStatus === "archived") {
      this.logger.log(
        `Skipping publish for adaptation ${job.adaptationId}: content item was ${adaptation.itemStatus}`,
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

    // THE SLOT MOVED INTO THE FUTURE WHILE THIS JOB WAS ALREADY RUNNING, and
    // this job must touch nothing at all.
    //
    // It is reachable, not hypothetical. An overdue row is still `scheduled`,
    // which `UNSCHEDULABLE_STATUSES` does not refuse, so a person can re-approve
    // it with a NEW time mid-outage. `approve` cancels by payload — but a job
    // already `active` keeps running, and `scheduled` is claimable, so without
    // this the woken worker would claim the re-scheduled row and post it HOURS
    // EARLY, which is the same injury as posting it a day late.
    //
    // THIS HALF IS ASKED BEFORE ANYTHING IS CLAIMED, unlike its sibling below,
    // and the two placements are not an inconsistency. The LATE half must come
    // after `claimSend` because it makes a terminal statement ("never sent")
    // that an unresolved claim would make a lie. This half makes no statement:
    // it leaves the row exactly as the person just set it — `scheduled`, at the
    // time they chose, with the attempt count they were given and no claim
    // taken — and a job for the new slot provably exists, because `approve`
    // enqueued it in the same transaction as the new time. Claiming the attempt
    // first and then "returning untouched" would be neither: `markPublishing`
    // would have moved the row to `publishing` and bumped its count, and the
    // claim left standing would make the NEW job report an unknown outcome
    // about a post nobody sent.
    //
    // AND THIS ARM ANSWERS FROM A SNAPSHOT, which on its own would narrow the
    // window rather than close it: a re-approve that commits AFTER `load()` and
    // before the claim leaves this job reading a slot that is merely overdue,
    // and claiming the row the new time lives on. The claim is therefore fenced
    // on `scheduled_at` being the value read here, not on status alone — see
    // `markPublishing`. So the pair is complete: this arm catches the move that
    // is already visible, the fence catches the one that lands underneath it.
    //
    // No tolerance on the comparison, and none is needed: both sides are one
    // Postgres clock (`load`'s `lateBySeconds`), and pg-boss delivers only at
    // `start_after <= now()`, so a negative value means a human moved the slot.
    if (adaptation.lateBySeconds !== null && adaptation.lateBySeconds < 0) {
      this.logger.log(
        `Skipping publish for adaptation ${job.adaptationId}: its slot has been moved into the ` +
          `future (${formatHours(-adaptation.lateBySeconds)} h from now); the job enqueued with ` +
          "that new time is the one that will send it",
      );
      return;
    }

    const publisher = this.lookup(adaptation.platform);
    if (!publisher) {
      // Fenced on the row EXACTLY as it was loaded a moment ago, because this
      // is the one terminal path that runs before `markPublishing` and so has
      // no attempt of its own to name. A reject (or a reject and a re-approve)
      // landing in the gap moves both halves of that pair, and the verdict of
      // an attempt the user has overruled must not land on the row they now
      // own — see `AttemptFence`.
      await this.safeMarkFailed(
        job.orgId,
        job.adaptationId,
        `No adapter for platform ${adaptation.platform}`,
        "no_adapter",
        { status: adaptation.status, attemptCount: adaptation.attemptCount },
      );
      return;
    }

    // Claiming is conditional on the adaptation still being publishable AND on
    // its slot still being the one read above. A lost claim means the api
    // changed the row (rejected, re-approved) between load() and here, under
    // the row lock — do not send, and do not fail the adaptation either: its
    // new status, or its new time, is the truth now.
    //
    // The slot half of that condition is what closes the residual window in the
    // future-slot arm above: that arm answers from `load()`'s snapshot, and a
    // re-approve landing after the read would otherwise leave this job claiming
    // the row the new time lives on. See `markPublishing`.
    const attempt = await this.repo.markPublishing(
      job.orgId,
      job.adaptationId,
      adaptation.scheduledAt ?? null,
    );
    if (attempt === null) {
      this.logger.log(
        `Skipping publish for adaptation ${job.adaptationId}: it is no longer in a publishable ` +
          "status, or its slot has been moved since it was read",
      );
      return;
    }
    // This attempt's identity, from here to whatever ends it: the status it
    // just wrote and the count it just took. Every terminal write below is
    // guarded on it, so a reject or a re-approve that lands mid-attempt wins
    // and this attempt's verdict is dropped rather than written over it.
    const fence: AttemptFence = { status: "publishing", attemptCount: attempt };

    // The claim on the SEND, written before the platform is called. Losing it
    // means a previous attempt wrote one and never came back to resolve it, and
    // the ONLY thing that can leave a claim behind is an attempt that stopped
    // running between the claim and its outcome — killed mid-send, unable to
    // reach the database afterwards, failed by a graceful stop or by the
    // heartbeat supervisor while its request was in flight. Every one of those
    // may have posted. This is the guard that makes findings (b) and (c)
    // terminal instead of duplicating: the redelivery pg-boss was always going
    // to make now finds evidence where it used to find nothing.
    // The claim is kept as a VALUE, not as a fact: every later write of it
    // addresses this row by its own primary key. That is what stops the release
    // below from deleting a successor's claim, and what lets a delivery still be
    // recorded when the adaptation the claim pointed at has been deleted
    // underneath it (see `SendClaim`).
    const claim = await this.repo.claimSend(job.orgId, job.adaptationId);
    if (!claim) {
      await this.recordUnknownOutcome(
        job.orgId,
        job.adaptationId,
        "an earlier attempt was interrupted after the post was sent to the platform and never reported back",
        fence,
      );
      return;
    }

    // TOO LATE TO BE THE POST SOMEBODY SCHEDULED — the bound, checked HERE and
    // deliberately not one line higher.
    //
    // Above `claimSend`, a refused claim means an earlier attempt may already
    // have posted and is recorded `unknown`; answering "missed its slot, never
    // sent" about such a row would be a verdict this pipeline is built not to
    // guess, and an invitation to re-approve into a duplicate. Below it, the
    // claim is ours, nothing has been told to the platform, and the branch is
    // shape-identical to the permanent-error branch further down: record the
    // failure with its claim, and RETURN. Never throw — a rethrow would have
    // pg-boss retry a job that can only ever reach this same line again
    // (CLAUDE.md, Publishing).
    //
    // `>`, not `>=`: a post that is late by EXACTLY the bound is within it.
    //
    // The sentence is FROZEN at the moment of refusal, hours and slot spelled
    // out. `scheduled_at` is never cleared on failure, so a reader that
    // recomputed the lateness later would watch it grow for ever and disagree
    // with the very row it is printed next to.
    //
    // THE SLOT IS A RAW UTC ISO STRING, deliberately and not by omission. This
    // text is `last_error`, which every screen prints VERBATIM, and a worker
    // that formatted a date would be picking one locale and one zone for four
    // locales' readers — a worse lie than an unambiguous instant. The reader's
    // own rendering of the slot belongs to the screen, which has the row's
    // `scheduled_at` and the viewer's locale; what the screen needs from the
    // worker in order to caption this row at all is the CODE below
    // (`schedule_missed`), not this prose.
    const maxLatenessSeconds = env.PUBLISH_MAX_LATENESS_HOURS * 3600;
    if (adaptation.lateBySeconds !== null && adaptation.lateBySeconds > maxLatenessSeconds) {
      const missed =
        `Missed its scheduled slot: this post was due at ${adaptation.scheduledAt?.toISOString()} ` +
        `and nothing could deliver it until ${formatHours(adaptation.lateBySeconds, Math.ceil)} h ` +
        `later, past the ${formatHours(maxLatenessSeconds, Math.floor)} h limit. Nothing was sent — ` +
        "publish it now if it is still worth sending.";
      this.logger.warn(`${missed} orgId=${job.orgId} adaptationId=${job.adaptationId}`);
      await this.safeMarkFailed(
        job.orgId,
        job.adaptationId,
        missed,
        "schedule_missed",
        fence,
        "failed",
        claim,
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
        // The two failures repo.credentials() DESCRIBES — the channel row is
        // gone, or credentialsEncrypted fails to decrypt (wrong key / corrupted
        // ciphertext) — are both deterministic: retrying with the same DB row
        // and the same encryption key will fail identically every time. Each is
        // classified as permanent, same as any other config/data problem,
        // instead of letting pg-boss retry a job that can never succeed.
        //
        // AND NOTHING ELSE IS. This used to be a catch-all: every other failure
        // of that statement — a dropped connection, a statement timeout, a
        // failover — was labelled `credentials_missing`, whose sentence tells a
        // reader the channel is no longer connected and to add it again. That
        // is a specific claim about a channel that is fine, and the remedy it
        // recommends cascades away every adaptation on it. A blip is transient
        // by the house rule (CLAUDE.md, Publishing: permanent means the
        // platform refused; everything else retries), nothing has been sent on
        // this path — `publisher.publish()` is below it — so the error is
        // RETHROWN and pg-boss retries. The claim is released on the way out by
        // the transient arm of the outer catch, as every transient is.
        //
        // The SECOND of those two failures is now told apart from the first,
        // and that is the whole point. `last_error` is printed verbatim on the
        // content screens, so this line used to put node's own sentence — "Could
        // not load credentials: Unsupported state or unable to authenticate
        // data" — in front of a user, for an event the AI-credential path
        // answers with a clean verdict and the generate worker answers with a
        // sentence written for a human. It is one event; it gets one answer,
        // written once in `@pubrick/shared` and used by every reader of an
        // encrypted blob.
        //
        // The channel-gone case keeps its own sentence: "the channel is gone"
        // and "the key is gone" are different things to do about it, and a
        // shared sentence for both would be the same mistake in the other
        // direction. It is no longer PREFIXED with "Could not load
        // credentials", which was only ever there to frame node's crypto
        // sentence; the repository's own message already says what happened.
        if (isUnreadableCiphertext(credentialsError)) {
          throw new ClassifiedPermanentError(
            UNREADABLE_CREDENTIALS_MESSAGE,
            "credentials_unreadable",
          );
        }
        if (credentialsError instanceof ChannelNotFoundError) {
          throw new ClassifiedPermanentError(credentialsError.message, "credentials_missing");
        }
        if (credentialsError instanceof NoAutomaticCredentialsError) {
          throw new ClassifiedPermanentError(credentialsError.message, "credentials_invalid");
        }
        throw credentialsError;
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
        throw new ClassifiedPermanentError(
          `Stored credentials are not valid for platform ${adaptation.platform}: ${detail}`,
          "credentials_invalid",
        );
      }
      const baseUrl =
        adaptation.platform === "vk"
          ? env.VK_API_BASE_URL
          : adaptation.platform === "max"
            ? env.MAX_API_BASE_URL
            : adaptation.platform === "telegram"
              ? this.baseUrl
              : undefined;
      let image: { bytes: Uint8Array; mimeType: "image/jpeg" } | undefined;
      if (adaptation.coverMediaId) {
        if (adaptation.itemBrandId !== adaptation.channelBrandId) {
          throw new ClassifiedPermanentError(
            "Cover image cannot publish to a channel in another brand",
            "rejected_before_send",
          );
        }
        if (adaptation.coverAuthorizedId !== adaptation.coverMediaId) {
          throw new ClassifiedPermanentError(
            "Cover image does not belong to this post's organization and brand",
            "rejected_before_send",
          );
        }
        if (!["telegram", "vk", "max", "bluesky"].includes(adaptation.platform)) {
          throw new ClassifiedPermanentError(
            "This channel cannot publish a cover image",
            "rejected_before_send",
          );
        }
        const file = path.join(
          process.env.MEDIA_STORAGE_DIR ?? path.resolve(process.cwd(), ".data/media"),
          `${adaptation.coverMediaId}.jpg`,
        );
        try {
          image = { bytes: await readFile(file), mimeType: "image/jpeg" };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ClassifiedPermanentError(
              "Cover image is missing from media storage",
              "rejected_before_send",
            );
          }
          throw error;
        }
      }
      let video: { bytes: Uint8Array; mimeType: "video/mp4" } | undefined;
      if (adaptation.videoMediaId) {
        if (!["telegram", "vk"].includes(adaptation.platform) || image) {
          throw new ClassifiedPermanentError(
            "This channel cannot publish the attached video",
            "rejected_before_send",
          );
        }
        if (
          adaptation.itemBrandId !== adaptation.channelBrandId ||
          adaptation.videoAuthorizedId !== adaptation.videoMediaId
        ) {
          throw new ClassifiedPermanentError(
            "Video does not belong to this post's organization and brand",
            "rejected_before_send",
          );
        }
        if (
          !adaptation.videoByteSize ||
          adaptation.videoByteSize < 1024 ||
          adaptation.videoByteSize > 20 * 1024 * 1024 ||
          (adaptation.platform === "telegram" && text.length > 1024)
        ) {
          throw new ClassifiedPermanentError(
            "Video must be under 20 MB; Telegram captions must be at most 1024 characters",
            "rejected_before_send",
          );
        }
        const file = path.join(
          process.env.MEDIA_STORAGE_DIR ?? path.resolve(process.cwd(), ".data/media"),
          `${adaptation.videoMediaId}.mp4`,
        );
        let bytes: Buffer;
        try {
          bytes = await readFile(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ClassifiedPermanentError(
              "Video is missing from media storage",
              "rejected_before_send",
            );
          }
          throw error;
        }
        if (bytes.length !== adaptation.videoByteSize) {
          throw new ClassifiedPermanentError(
            "Video bytes no longer match the reviewed upload",
            "rejected_before_send",
          );
        }
        video = { bytes, mimeType: "video/mp4" };
      }
      result = await publisher.publish(
        parsed.data,
        { text, ...(image ? { image } : {}), ...(video ? { video } : {}) },
        {
          baseUrl,
          ...(adaptation.platform === "telegram" && image
            ? {
                onTelegramPhotoAccepted: async (primary: PublishResult, followup: string) => {
                  const checkpointed = await this.repo.markTelegramPhotoAccepted(
                    job.orgId,
                    job.adaptationId,
                    claim,
                    {
                      photoId: primary.externalId,
                      photoUrl: primary.externalUrl,
                      followupText: followup,
                      followupOutcome: "pending",
                    },
                  );
                  if (!checkpointed) throw new Error("The send claim is no longer active");
                },
              }
            : {}),
        },
      );
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof UnknownOutcomePublishError) {
        // The request left this process and its answer never came back. Not
        // retried, and deliberately NOT recorded as a failure: "failed" would
        // invite a re-approve, and a re-approve here is a second post. The
        // claim becomes an `unknown` publications row and the operator is told
        // to look at the channel first. This is finding (a) — before, this
        // error did not exist and the case above it took the branch below,
        // where the rethrow is the second send.
        const partial: PartialTelegramDelivery | undefined =
          error instanceof PartialTelegramPublishError
            ? {
                photoId: error.primary.externalId,
                photoUrl: error.primary.externalUrl,
                followupText: error.followup,
                followupOutcome: error.followupOutcome,
              }
            : undefined;
        await this.recordUnknownOutcome(
          job.orgId,
          job.adaptationId,
          message,
          fence,
          claim,
          partial,
        );
        return;
      }
      if (error instanceof PermanentPublishError) {
        // Never retried: returning normally completes the pg-boss job.
        // Nothing was accepted by the platform on this branch (publish()
        // itself rejected it, or we never got as far as calling it) — no
        // duplicate-post risk here, unlike recordPublished below.
        //
        // WHICH CLASS comes with the throw, not from reading the sentence back:
        // the three credential failures above are raised inside this same try
        // and are indistinguishable here by anything except their prose, which
        // is the reading the coded column exists to end. Anything else reaching
        // this line came out of `publisher.publish()`.
        //
        // AND "THE PLATFORM REFUSED" IS THE NARROW CASE, not the default. The
        // screen quotes this message under a sentence that names who refused,
        // and `publisher.publish()` raises a permanent error for things the
        // platform never saw: its own pre-flight guards (text length, a payload
        // that will not serialize) and a 4xx that did not carry the platform's
        // envelope. Calling those `platform_rejected` put our own words — "Text
        // must be 1..4096 characters" — in the platform's mouth. Only a
        // `PlatformRejectionError`, which an adapter raises for the envelope
        // alone, is the platform's own "no"; the safe default is the other way.
        const failureReason: PublishFailureReason =
          error instanceof ClassifiedPermanentError
            ? error.failureReason
            : error instanceof PlatformRejectionError
              ? "platform_rejected"
              : "rejected_before_send";
        await this.safeMarkFailed(
          job.orgId,
          job.adaptationId,
          message,
          failureReason,
          fence,
          "failed",
          claim,
        );
        return;
      }
      // Transient, which now means KNOWN-not-posted: the platform's own
      // envelope said "not now", or the connection never got far enough to send
      // anything. Nothing is out there, so the claim goes back before the
      // rethrow — holding it would turn an honest retry into a permanent
      // "outcome unknown" on the next delivery. Best effort on purpose: if the
      // release cannot be written, the claim survives and the next attempt
      // reports unknown, which is the safe direction to fail in.
      await this.safeReleaseSend(job.orgId, claim);
      if (!(await this.repo.recordTransient(job.orgId, job.adaptationId, message, fence))) {
        this.logger.log(
          `Transient error not recorded for adaptation ${job.adaptationId}: the row moved on from ` +
            "this attempt, and the status it moved to owns its own last_error",
        );
      }
      throw error;
    }

    // publish() resolved: the platform ACCEPTED the post. From this point on,
    // handle() must never throw. A thrown error here would make pg-boss retry
    // the whole job, which calls publisher.publish() again — posting a SECOND
    // message the platform has no way to know is a retry. A stale or missing
    // `publications` row is recoverable later (reconciliation, logs); a
    // duplicate post in someone's channel is not.
    await this.recordPublished(job.orgId, job.adaptationId, result, claim);
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
   *
   * And the guard that matters is IN THE STATEMENT, not here. Reading the
   * status and then writing unconditionally is a check-then-act: a reject and a
   * re-approve committing between the two left the re-approved adaptation
   * `failed` with "Retries exhausted", and its live job then found a `failed`
   * row, was refused the claim, and completed having sent nothing — the user's
   * decision lost with no error anywhere and no post in the channel. The read
   * below survives only as a cheap short-circuit (it also supplies the fence's
   * attempt number); the thing that makes the write safe is that `markFailed`
   * re-checks `(status, attempt_count)` under the row lock.
   */
  async markExhausted(job: PublishJob): Promise<void> {
    const adaptation = await this.repo.load(job.orgId, job.adaptationId);
    if (!adaptation) return;
    if (adaptation.status !== "publishing") return;

    await this.safeMarkFailed(
      job.orgId,
      job.adaptationId,
      "Retries exhausted",
      "retries_exhausted",
      {
        status: "publishing",
        attemptCount: adaptation.attemptCount,
      },
    );
  }

  /**
   * The scheduled sweep: end every adaptation no job can ever move again.
   *
   * The state it recovers from is the publish queue's copy of the one the
   * generate sweep covers, and `packages/shared/src/jobs.ts` names it: a
   * heartbeat re-dispatch hands handler B a job id handler A still holds, A
   * returns into pg-boss's wrapper, the wrapper completes that id — which is
   * now B's live incarnation — and from then on nothing can retry or
   * dead-letter it. The adaptation stays `publishing`, `markExhausted` never
   * runs, and `approve` does not target `publishing`, so a re-approve cannot
   * move it either.
   *
   * TWO SWEEPS, one tick. The pass above drives off `adaptations`, and there is
   * one stranded shape it can never reach: a claim whose adaptation was DELETED
   * while it was in flight (`publications.adaptation_id` is `SET NULL`, and a
   * channel delete cascades the adaptation). Nothing is left to be `publishing`,
   * so the first query has nothing to find, and the row says "an attempt is out
   * there right now" for ever. It is swept here, on the same schedule, because
   * it is the same recovery: end what no job can ever finish.
   *
   * Never throws, for the same reason `markExhausted` does not: this runs on a
   * schedule with nobody waiting on it, and a rethrow would only redeliver the
   * sweep tick to do the same thing again. The two halves are caught separately
   * so a failure in one still lets the other run.
   */
  async sweepAbandoned(): Promise<void> {
    await this.sweepAbandonedAdaptations();
    await this.sweepStranded();
    await this.sweepOrphanedClaims();
  }

  /**
   * THE THIRD PASS, on the same tick and deliberately with no cadence of its
   * own: rows whose job pg-boss's retention DELETED out from under them.
   *
   * It shares `SWEEP_CRON` with the two passes either side of it because it is
   * the same recovery — end what no job can ever finish — and because the thing
   * it recovers from has already been true for hours by the time it is a
   * candidate at all: a poll five minutes wide adds a rounding error to a
   * latency measured in days. A `PUBLISH_STRANDED_SWEEP_*` variable would be an
   * operator-facing knob on a number that cannot matter, and one more setting
   * that can be set wrong.
   *
   * SEQUENTIAL, not `Promise.all`, and that is the locking rule rather than a
   * style: two bulk writers of `adaptations` running at once would be two
   * transactions walking overlapping-in-principle sets, and the whole of
   * `docs/lock-order.md`'s "same table, two transactions" section is about not
   * doing that. Run one after the other they are two transactions that never
   * meet.
   *
   * Caught separately, like its siblings, so a failure in one still lets the
   * others run; never rethrown, because nothing is waiting on this tick and a
   * rethrow only asks pg-boss to redeliver it.
   */
  private async sweepStranded(): Promise<void> {
    try {
      for (const adaptation of await this.repo.sweepStranded()) {
        // `error`, like its sibling, and never routine: a post a person
        // approved was going to go out and now never will, and the product only
        // found out by scanning for it.
        this.logger.error(
          `SWEPT STRANDED DELIVERY: adaptation ${adaptation.id} was waiting for a queue job that ` +
            `no longer exists anywhere; failed it as "${adaptation.reason}" with outcome ` +
            `"${adaptation.outcome}"` +
            (adaptation.outcome === "unknown"
              ? " — an unresolved send claim means a post MAY be live; check the channel before re-approving."
              : " — nothing had reached the platform.") +
            ` orgId=${adaptation.orgId} channelId=${adaptation.channelId}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`STRANDED-DELIVERY SWEEP FAILED: ${message}`);
    }
  }

  /** Claims whose adaptation is gone — unreachable from the sweep above. */
  private async sweepOrphanedClaims(): Promise<void> {
    try {
      for (const claim of await this.repo.sweepOrphanedClaims()) {
        this.logger.error(
          `RESOLVED ORPHANED SEND CLAIM: publication ${claim.id} was still "in_flight" long after ` +
            "its attempt should have ended, and the adaptation it belonged to has been deleted, so " +
            'nothing could ever resolve it. Recorded as "unknown": a post MAY be live in ' +
            `${claim.channelPlatform ?? "an unknown platform"} channel ` +
            `"${claim.channelName ?? "(unknown)"}". orgId=${claim.orgId}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ORPHANED-CLAIM SWEEP FAILED: ${message}`);
    }
  }

  private async sweepAbandonedAdaptations(): Promise<void> {
    try {
      const swept = await this.repo.sweepAbandoned();
      for (const adaptation of swept) {
        // `error`, not `warn`, and loudest for the `unknown` half: the queue
        // lost a job that was supposed to finish a delivery, and where a claim
        // was left standing nobody can say whether a post is now live in a
        // customer's channel. Neither half is ever routine.
        this.logger.error(
          `SWEPT ABANDONED PUBLISH: adaptation ${adaptation.id} sat in "publishing" with no queue ` +
            `job left anywhere to move it; failed it with outcome "${adaptation.outcome}"` +
            (adaptation.outcome === "unknown"
              ? " — an unresolved send claim means a post MAY be live; check the channel before re-approving."
              : " — nothing had reached the platform.") +
            ` orgId=${adaptation.orgId}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`ABANDONED-PUBLISH SWEEP FAILED: ${message}`);
    }
  }

  /**
   * The attempt ended without an answer: terminal, never retried, and never
   * called a failure.
   *
   * `markFailed` is what moves the adaptation, because `failed` is the only
   * terminal-and-not-published status the adaptation column has and every
   * reader of it already means exactly that. The publications row is where the
   * distinction lives — `unknown`, not `failed` — and `lastError` is where the
   * operator reads it. Returning normally is the whole point: pg-boss completes
   * the job, and no retry sends a second post.
   */
  private async recordUnknownOutcome(
    orgId: string,
    adaptationId: string,
    detail: string,
    fence: AttemptFence,
    claim?: SendClaim,
    partial?: PartialTelegramDelivery,
  ): Promise<void> {
    const reason =
      "DELIVERY OUTCOME UNKNOWN: the post was sent to the platform but the outcome could not be " +
      `confirmed (${detail}). A copy may already be live — check the channel before re-approving, ` +
      "because re-approving will send again.";
    this.logger.error(`${reason} orgId=${orgId} adaptationId=${adaptationId}`);
    await this.safeMarkFailed(
      orgId,
      adaptationId,
      reason,
      "outcome_unknown",
      fence,
      "unknown",
      claim,
      partial,
    );
  }

  /**
   * Hands THIS ATTEMPT'S OWN in-flight claim back after a KNOWN-not-posted
   * ending. Never throws: the caller is about to rethrow a transient error that
   * pg-boss will retry, and a failed release must not replace that with a
   * different error — the claim simply survives, and the next delivery reports
   * an unknown outcome rather than sending again.
   *
   * It takes the `SendClaim` this attempt was given rather than an adaptation
   * id, and that is the fence: an attempt that hung long enough to be overtaken
   * used to delete whatever claim was in flight when it finally failed, which by
   * then could be a LIVE successor's — see `releaseSend`. A release that matches
   * nothing is logged rather than assumed to have worked; it means this
   * attempt's claim was already resolved by somebody else, which is a fact worth
   * reading next to the transient error that follows it.
   */
  private async safeReleaseSend(orgId: string, claim: SendClaim): Promise<void> {
    try {
      if (!(await this.repo.releaseSend(orgId, claim))) {
        this.logger.warn(
          "SEND CLAIM NOT RELEASED: this attempt's claim was already resolved by another attempt, " +
            `so there was nothing of ours to give back. orgId=${orgId} claimId=${claim.id} ` +
            `attempt=${claim.attempt}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "SEND CLAIM RELEASE FAILED: a transient failure could not give its in-flight claim back — " +
          "the next delivery will report an unknown outcome instead of retrying. " +
          `orgId=${orgId} claimId=${claim.id} error=${message}`,
      );
    }
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
    claim: SendClaim,
  ): Promise<void> {
    for (let attempt = 1; attempt <= MARK_PUBLISHED_MAX_ATTEMPTS; attempt++) {
      try {
        await this.repo.markPublished(orgId, adaptationId, result, claim);
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
        await sleep(markPublishedDelayMs(this.markPublishedRetryDelayMs, attempt));
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
   * adaptation status to reconcile manually — never a duplicate post. The one
   * caller that passes `outcome: "unknown"` is the exception to "nothing was
   * delivered", and it is exactly why the publications row needs a status the
   * adaptation column does not have.
   *
   * The other way this can fail to write is the fence refusing it, which is not
   * a failure at all and is handled differently: nothing is stuck, the row
   * simply belongs to a newer decision. See `AttemptFence`.
   */
  private async safeMarkFailed(
    orgId: string,
    adaptationId: string,
    reason: string,
    failureReason: PublishFailureReason,
    fence: AttemptFence,
    outcome: "failed" | "unknown" = "failed",
    claim?: SendClaim,
    partial?: PartialTelegramDelivery,
  ): Promise<void> {
    try {
      if (
        !(await (partial
          ? this.repo.markFailed(
              orgId,
              adaptationId,
              reason,
              failureReason,
              fence,
              outcome,
              claim,
              partial,
            )
          : this.repo.markFailed(
              orgId,
              adaptationId,
              reason,
              failureReason,
              fence,
              outcome,
              claim,
            )))
      ) {
        // Not an error, and emphatically not something to retry or force: the
        // row moved out from under this attempt, which only the api does and
        // only because a human rejected or re-approved. Their decision is the
        // truth now; this attempt's verdict is dropped on purpose.
        this.logger.warn(
          `Terminal outcome NOT recorded for adaptation ${adaptationId}: the row left ` +
            `${fence.status}/attempt ${fence.attemptCount} before this attempt could write it, so a ` +
            `newer decision stands. orgId=${orgId} droppedReason=${reason}`,
        );
      }
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
