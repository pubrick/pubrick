import { BadRequestException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type ApiErrorCode,
  COVER_SUPPORTED_PLATFORMS,
  DISMISSABLE_RUN_STATUSES,
  IMAGE_CALL_STEPS,
  isLiveRunStatus,
  LIVE_RUN_STATUSES,
  MAX_AUTO_INLINE_IMAGES,
  MAX_CONCURRENT_RUNS,
  MAX_IMAGE_CALLS_PER_HOUR,
  RUN_ADMISSION_LOCK_NAMESPACE,
  RUN_LIST_STATES,
  type RunCreate,
  type RunListInput,
  type RunStatus,
  runCreateSchema,
  runInputSchema,
  type SettledRunStatus,
} from "@pubrick/shared";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";
import { ZodValidationPipe } from "../validation.pipe";

/**
 * Explicit allowlist, per the house rule. Two columns are deliberately absent:
 * `active_job_id` and `lease_expires_at` are the worker's fencing state
 * (generation-engine spec §5), meaningful only to the handler that holds the lease, and exposing them
 * would invite a client to reason about a lease it cannot take.
 *
 * `steps` is absent too, but for a size reason rather than a secrecy one — see
 * `RUN_DETAIL_COLUMNS`.
 */
const RUN_COLUMNS = {
  id: schema.pipelineRuns.id,
  brandId: schema.pipelineRuns.brandId,
  status: schema.pipelineRuns.status,
  currentStep: schema.pipelineRuns.currentStep,
  contentItemId: schema.pipelineRuns.contentItemId,
  /**
   * A `RunFailure` CODE, aliased away from the column's older name.
   *
   * The column is `text` and used to hold the provider's own error sentence,
   * which is where the submitted API key can be quoted back ("Incorrect API key
   * provided: sk-live-…") — on the very path that ends in a browser. The worker
   * now writes only a member of the closed set, and the web app turns it into a
   * sentence in four languages. The name says which of the two this is, so a
   * client cannot mistake the value for something printable.
   *
   * Rows written before that change still hold prose; the web app renders any
   * value it does not recognise as its generic failure sentence.
   */
  errorCode: schema.pipelineRuns.error,
  dismissedAt: schema.pipelineRuns.dismissedAt,
  /**
   * How many of this run's billed model calls the ledger could not record.
   *
   * The worker writes it (`GenerateRepository.recordUnrecordedCall`); this is
   * where it is read. For a day it was not: the column landed with migration
   * 0013 and three comments describing a receipt that showed it, and nothing
   * selected it — a counter nobody reads is a log line with a schema. The web's
   * receipt prints it, and `AiCredentialsRepository.spend` counts it among the
   * calls the org's figure cannot price.
   *
   * Selected RAW, never `coalesce(…, 0)`: NULL is a run that predates the
   * counter, about which nothing is known, and 0 is a run on which nothing was
   * lost. The receipt says different things for the two. `runDtoSchema` types
   * it nullable for the same reason, and the e2e pins the NULL through.
   */
  unrecordedCalls: schema.pipelineRuns.unrecordedCalls,
  createdAt: schema.pipelineRuns.createdAt,
  updatedAt: schema.pipelineRuns.updatedAt,
};

/**
 * The list's `input`, WITHOUT the pasted article, editorial note text, or
 * SEO phrases,
 * evaluated by Postgres so the 8 000 characters never leave it.
 *
 * The queue strip polls `?state=open` every five seconds and reads the brief,
 * the kind and the host off each row; the material it does not read. It
 * arrived anyway until now, and the set it arrived for is unbounded —
 * `MAX_CONCURRENT_RUNS` caps `queued | running`, while a failed or cancelled
 * run stays OPEN until a human dismisses it. Measured through this route:
 * eight open source runs = 122 265 bytes per response, ~85 MB/hour per tab.
 *
 * Cutting the key HERE rather than deleting it in TypeScript is the whole
 * saving: a row read and then trimmed has already crossed the database
 * connection. The operator is a no-op on a `brief` input, which has no such
 * key, so both arms of the union come back intact minus one field — which is
 * exactly `runListInputSchema`, the shape the wire schema declares.
 *
 * The one reason the browser ever needed the article was `Try again`, which
 * rebuilt a create request out of it; `POST /api/runs/:id/retry` reads it
 * server-side instead.
 */
const RUN_LIST_COLUMNS = {
  ...RUN_COLUMNS,
  input: sql<RunListInput>`${schema.pipelineRuns.input} - 'material'::text - 'editorialFeedback'::text - 'seoKeywords'::text`,
};

/**
 * One run, for the progress receipt at `/content/runs/[id]`, which renders the
 * five steps as a live checklist and therefore needs the checkpoint map — and
 * the WHOLE input, article included, which is what the receipt and the source
 * strip above a draft render.
 *
 * The list carries neither: each checkpoint holds that step's whole model
 * output, so a queue strip showing a dozen runs would ship several hundred
 * kilobytes of draft text on every poll to render a row that only reads
 * `status`, `currentStep` and `errorCode`. The material was the same mistake
 * one column over — see `RUN_LIST_COLUMNS`.
 */
const RUN_DETAIL_COLUMNS = {
  ...RUN_COLUMNS,
  input: schema.pipelineRuns.input,
  steps: schema.pipelineRuns.steps,
};

/**
 * Statuses a run can still be cancelled from — the two in which something is
 * either about to spend money or is spending it right now.
 *
 * That is `LIVE_RUN_STATUSES` (`@pubrick/shared`), and it is imported rather
 * than spelled out here: the same two-member literal stood in six places across
 * this app and the worker, so "is a run in this status still the queue's?" had
 * six chances to be answered differently for a status that does not exist yet.
 *
 * The exhaustiveness the local copy bought is unchanged, because the shared
 * declaration is `as const satisfies readonly RunStatus[]` and so keeps its
 * literal member types: `SettledRunStatus` is `Exclude`d from them, and the two
 * message maps below are `Record`s over that. Adding a status to `RUN_STATUSES`
 * without deciding what cancel and dismiss mean for it is still a compile error
 * here, not a confident wrong sentence in the UI.
 */
type CancellableStatus = (typeof LIVE_RUN_STATUSES)[number];

/** The 409 body for cancelling, in the words of the status the user is looking at. */
const NOT_CANCELLABLE_MESSAGE: Record<SettledRunStatus, string> = {
  succeeded: "This run has already finished; its draft is ready",
  failed: "This run has already failed; there is nothing left to cancel",
  cancelled: "This run has already been cancelled",
};

/**
 * The same refusal as the code the web turns into a translated sentence.
 *
 * The status is in the code's NAME rather than in an argument, for the reason
 * the record above is keyed by status at all: "this run has already finished;
 * its draft is ready" and "there is nothing left to cancel" are three different
 * true things, and a single code plus a status argument would push the choice
 * between them into the browser. Total over `SettledRunStatus` here as well, so a
 * new run status is a compile error twice rather than a code that silently
 * matches the wrong sentence.
 */
const NOT_CANCELLABLE_CODE: Record<SettledRunStatus, ApiErrorCode> = {
  succeeded: "run_not_cancellable_succeeded",
  failed: "run_not_cancellable_failed",
  cancelled: "run_not_cancellable_cancelled",
};

/**
 * The 409 body for dismissing. Dismissing is how a human clears a FINISHED run
 * off the queue strip; a live run is not on the strip because of `dismissed_at`
 * (the open filter ignores it for `queued`/`running`), so accepting the dismiss
 * would write a timestamp that changes nothing and report success for it.
 */
const NOT_DISMISSABLE_MESSAGE: Record<CancellableStatus, string> = {
  queued: "A queued run cannot be dismissed; cancel it first",
  running: "A running run cannot be dismissed; cancel it first",
};

/** The same two refusals as codes — see `NOT_CANCELLABLE_CODE`. */
const NOT_DISMISSABLE_CODE: Record<CancellableStatus, ApiErrorCode> = {
  queued: "run_not_dismissable_queued",
  running: "run_not_dismissable_running",
};

function isCancellable(status: RunStatus): status is CancellableStatus {
  return isLiveRunStatus(status);
}

/**
 * Namespace for the per-org admission lock. Arbitrary but fixed, and in the
 * TWO-argument advisory-lock space, which Postgres keeps entirely separate from
 * the one-argument space `runMigrations` uses — so the two can never collide
 * however their keys hash.
 */

/**
 * The two schemas `retry` validates with, through the SAME pipe the HTTP
 * boundary uses — so a refusal reads `invalid_request` with zod's own
 * field-qualified issues, exactly as it would had the browser sent the body.
 *
 * A retry is a request like any other; the only difference is that its body
 * comes out of `pipeline_runs.input` instead of off the wire. Writing a second
 * mapping from zod issues to a refusal here would be a second answer to "how
 * does this API say a body is malformed", for the one caller whose body nobody
 * typed.
 *
 * The STORED input is parsed first, and not merely read through the drizzle
 * `$type<RunInput>()` that types it: jsonb has no shape the database checks, so
 * that type is a claim about what the last writer did, not a fact. A row
 * carrying a `kind` this build cannot rebuild a request for — the `topic` the
 * union is discriminated for — must be refused rather than quietly retried as
 * whichever member its remaining fields happen to satisfy.
 */
const parseStoredInput = new ZodValidationPipe(runInputSchema);
const parseRunCreate = new ZodValidationPipe(runCreateSchema);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

@Injectable()
export class RunsRepository {
  constructor(private readonly queue: QueueService) {}

  /**
   * The queue strip's query. `open` is not a status and deliberately not a
   * member of `RUN_STATUSES` (see `RUN_LIST_STATES`): it spans three statuses
   * plus a `dismissed_at` predicate, so a repository that validated it against
   * the status enum — the pattern `ContentRepository.list` follows for
   * `?status=` — would reject the one value the web app actually sends.
   *
   * Failures sort first because a failed run is the only outcome with nothing
   * else to show for it: it creates no content item, so if its strip were
   * buried under successful chatter the failure would be invisible everywhere.
   * Newest first within that, so a fresh failure outranks a stale one.
   */
  async list(orgId: string, state?: string, visibleBrandIds: string[] | null = null) {
    if (state !== undefined && !(RUN_LIST_STATES as readonly string[]).includes(state)) {
      throw new BadRequestException(
        `Unknown state: ${state}. Expected one of: ${RUN_LIST_STATES.join(", ")}`,
      );
    }
    const open = or(
      inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
      and(
        inArray(schema.pipelineRuns.status, [...DISMISSABLE_RUN_STATUSES]),
        isNull(schema.pipelineRuns.dismissedAt),
      ),
    );
    // The org filter sits OUTSIDE the state branch, and that is structural, not
    // stylistic: written as a ternary between two `and(eq(orgId), …)` arms it
    // was two independent copies of the tenancy predicate, and a test covering
    // one arm proves nothing about the other. `and()` drops the `undefined`, so
    // the unfiltered case is the same single `eq` rather than a second spelling
    // of it. There is now exactly one place to delete, and a test on either
    // branch catches it.
    return db
      .select(RUN_LIST_COLUMNS)
      .from(schema.pipelineRuns)
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          state === "open" ? open : undefined,
          visibleBrandIds === null
            ? undefined
            : inArray(schema.pipelineRuns.brandId, visibleBrandIds),
        ),
      )
      .orderBy(
        desc(sql`${schema.pipelineRuns.status} = 'failed'`),
        desc(schema.pipelineRuns.createdAt),
      );
  }

  async get(orgId: string, id: string) {
    const rows = await db
      .select(RUN_DETAIL_COLUMNS)
      .from(schema.pipelineRuns)
      .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)))
      .limit(1);
    const run = rows[0];
    if (!run) throw notFound("run_not_found", "Run not found");
    return run;
  }

  /**
   * Resolves the channels a run will fan out to, refusing the two request
   * shapes whose damage only shows up at the END of the pipeline.
   *
   * A brand with NO channels is a 400 rather than an accepted run: the terminal
   * write would otherwise produce a content item with zero adaptations — an
   * item `approve` marks approved while enqueueing nothing, a post that looks
   * sent and never was. `contentCreateSchema` refuses the same thing up front
   * with `channelIds.min(1)`; this is the same rule where the brand, not the
   * request, is what has nothing to publish to. It is checked BEFORE ownership
   * so the message names the actual problem ("this brand has no channels")
   * rather than blaming the ids the caller sent.
   */
  private async resolveChannels(orgId: string, data: RunCreate): Promise<void> {
    const brand = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
      .limit(1);
    if (brand.length === 0) throw notFound("brand_not_found", "Brand not found");

    const brandChannels = await db
      .select({ id: schema.channels.id, platform: schema.channels.platform })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.brandId, data.brandId)));
    if (brandChannels.length === 0) {
      throw badRequest(
        "brand_has_no_channels",
        "This brand has no channels; add one before generating",
      );
    }

    const owned = new Set(brandChannels.map((channel) => channel.id));
    if (data.channelIds.some((id) => !owned.has(id))) {
      // Same wording and same status as ContentRepository.create: from the
      // caller's side it is the identical mistake.
      throw notFound("channels_not_in_brand", "One or more channels do not belong to this brand");
    }
    if (data.generateCover) {
      const chosen = brandChannels.filter((channel) => data.channelIds.includes(channel.id));
      if (
        chosen.some(
          (channel) => !(COVER_SUPPORTED_PLATFORMS as readonly string[]).includes(channel.platform),
        )
      ) {
        throw badRequest(
          "content_media_unsupported",
          "Covers currently publish only to Telegram, VK, MAX, and Bluesky channels",
        );
      }
    }
    if (data.generateCover || data.generateInlineImages) {
      const google = await db
        .select({ id: schema.aiCredentials.id })
        .from(schema.aiCredentials)
        .where(
          and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, "google")),
        )
        .limit(1);
      if (!google[0]) {
        throw badRequest(
          data.generateCover ? "cover_requires_google_key" : "inline_images_require_google_key",
          "Add a Google AI key before requesting generated images",
        );
      }
    }
  }

  /**
   * The admission cap, taken INSIDE the caller's transaction and behind a
   * per-org advisory lock.
   *
   * The lock is what makes this a cap rather than a suggestion. Under READ
   * COMMITTED two simultaneous requests would both count 2, both admit, and the
   * org would run 4 — the exact failure mode a spend guard cannot have, since
   * the whole point is that nothing else bounds the bill.
   * `pg_advisory_xact_lock` is released on commit or rollback, is taken before
   * this transaction holds any row lock (so it cannot participate in a
   * deadlock), and only ever contends with another create for the SAME org.
   */
  private async admit(
    tx: Tx,
    orgId: string,
    generateCover = false,
    generateInlineImages = false,
  ): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
    );
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.pipelineRuns)
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
        ),
      );
    const inFlight = rows[0]?.count ?? 0;
    if (inFlight >= MAX_CONCURRENT_RUNS) {
      throw conflict(
        "run_limit_reached",
        `This organization already has ${MAX_CONCURRENT_RUNS} generation runs queued or running; wait for one to finish or cancel it`,
      );
    }
    const requestedImageCalls =
      Number(generateCover) + (generateInlineImages ? MAX_AUTO_INLINE_IMAGES : 0);
    if (requestedImageCalls > 0) {
      const spent = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.usageLedger)
        .where(
          and(
            eq(schema.usageLedger.orgId, orgId),
            inArray(schema.usageLedger.step, [...IMAGE_CALL_STEPS]),
            sql`${schema.usageLedger.createdAt} > now() - interval '1 hour'`,
          ),
        );
      const reserved = await tx
        .select({
          count: sql<number>`coalesce(sum((case when ${schema.pipelineRuns.input}->>'generateCover' = 'true' then 1 else 0 end) + (case when ${schema.pipelineRuns.input}->>'generateInlineImages' = 'true' then ${MAX_AUTO_INLINE_IMAGES} else 0 end)), 0)::int`,
        })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            inArray(schema.pipelineRuns.status, [...LIVE_RUN_STATUSES]),
          ),
        );
      if (
        (spent[0]?.count ?? 0) + (reserved[0]?.count ?? 0) + requestedImageCalls >
        MAX_IMAGE_CALLS_PER_HOUR
      ) {
        throw conflict("media_generation_limit", "The hourly image generation limit is reached");
      }
    }
  }

  /**
   * Starts a run: the `pipeline_runs` insert and the pg-boss job land in ONE
   * transaction, so the database and the queue can never disagree about whether
   * a run exists (house rule: enqueue in the same transaction as the domain
   * write).
   *
   * The admission cap is checked inside that transaction too, not before it: a
   * count taken outside would be stale by the time the insert commits, which is
   * the same reason it is taken under the advisory lock.
   */
  async create(orgId: string, data: RunCreate) {
    await this.resolveChannels(orgId, data);

    // The SAME two expressions `runCreateSchema`'s cross-field refine uses, read
    // once each here. Trimmed, because `material: "   "` passes
    // `z.string().min(1)`: branching untrimmed would store `kind: "source"` with
    // three spaces of material — and pay for a SOURCE block of whitespace on
    // three model calls — over a request the refine had already admitted on the
    // brief alone.
    //
    // The brief's trim is what makes a blank one `null` rather than `""`, and
    // `?? null` alone would not: the compose screen sends `brief` unconditionally
    // from an empty-string default, so an ordinary paste-only run arrives as
    // `{brief: "", material: "…"}` and `"" ?? null` is `""`. A stored `""` buys a
    // labelled but EMPTY brief block on three paid calls, which tells the model
    // the person wrote nothing USEFUL rather than that they wrote nothing.
    // `sourceRunInputSchema.text`'s `.min(1)` is the guard behind this line;
    // never reach for `?? ""` anywhere on this path.
    const brief = (data.brief ?? "").trim() === "" ? null : (data.brief as string);
    const material = (data.material ?? "").trim() === "" ? null : (data.material as string);

    const id = await db.transaction(async (tx) => {
      await this.admit(tx, orgId, data.generateCover, data.generateInlineImages);
      // Capture a bounded, deterministic by-value snapshot under the same
      // transaction as admission and enqueue. Both sides of the join carry the
      // tenant predicate; the item supplies the brand boundary.
      const editorialFeedback = data.useEditorialFeedback
        ? (
            await tx
              .select({ id: schema.editorialNotes.id, note: schema.editorialNotes.note })
              .from(schema.editorialNotes)
              .innerJoin(
                schema.contentItems,
                eq(schema.editorialNotes.contentItemId, schema.contentItems.id),
              )
              .where(
                and(
                  eq(schema.editorialNotes.orgId, orgId),
                  eq(schema.contentItems.orgId, orgId),
                  eq(schema.contentItems.brandId, data.brandId),
                ),
              )
              .orderBy(desc(schema.editorialNotes.createdAt), desc(schema.editorialNotes.id))
              .limit(5)
          ).map(({ id, note }) => ({
            id,
            // A split surrogate pair is not valid JSONB text in PostgreSQL.
            note: note.slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
          }))
        : undefined;
      const inserted = await tx
        .insert(schema.pipelineRuns)
        .values({
          orgId,
          brandId: data.brandId,
          // MATERIAL decides the kind: a brief is an instruction ABOUT the
          // material, not a second thing to work from, so a request carrying
          // both is a source run with `text` set. A `sourceUrl` with no material
          // has nothing to attribute and is dropped — the belt behind the
          // compose screen's own inline refusal.
          input:
            material === null
              ? // The refine guarantees at least one of the two is non-blank, so
                // with no material the brief is non-null. This is the one place
                // that guarantee is invisible to the compiler.
                {
                  kind: "brief",
                  text: brief as string,
                  channelIds: data.channelIds,
                  ...(data.generateCover && { generateCover: true }),
                  ...(data.generateInlineImages && { generateInlineImages: true }),
                  ...(data.seoKeywords && { seoKeywords: data.seoKeywords }),
                  ...(data.useEditorialFeedback && {
                    useEditorialFeedback: true,
                    editorialFeedback,
                  }),
                  ...(data.contentType && { contentType: data.contentType }),
                }
              : {
                  kind: "source",
                  text: brief,
                  sourceUrl: data.sourceUrl ?? null,
                  material,
                  channelIds: data.channelIds,
                  ...(data.generateCover && { generateCover: true }),
                  ...(data.generateInlineImages && { generateInlineImages: true }),
                  ...(data.seoKeywords && { seoKeywords: data.seoKeywords }),
                  ...(data.useEditorialFeedback && {
                    useEditorialFeedback: true,
                    editorialFeedback,
                  }),
                  ...(data.contentType && { contentType: data.contentType }),
                },
        })
        .returning({ id: schema.pipelineRuns.id });
      const runId = inserted[0]?.id as string;
      await this.queue.enqueueGenerate(tx, { id: runId, orgId });
      return runId;
    });

    return this.get(orgId, id);
  }

  /**
   * Asks for the same run again, from what the API already stores.
   *
   * THE BODY NEVER LEAVES THE SERVER. Try again used to be `POST /api/runs`
   * with a request the queue screen rebuilt out of `run.input`, which is why
   * the open-runs list had to carry every open run's whole pasted article on a
   * five-second poll, unbounded in the number of runs (measured: 122 265 bytes
   * for eight open runs, ~85 MB/hour per tab). Nothing in a browser needs 8 000
   * characters of somebody else's article to press a button, so it is no longer
   * sent one.
   *
   * It re-admits through `create` rather than inserting a row of its own, and
   * that is the whole design: the cross-field refine, the admission cap under
   * its advisory lock, the brand-and-channel resolution and the
   * enqueue-in-the-same-transaction rule are ONE path. A retry that wrote its
   * own insert would be a second way into `pipeline_runs` and the one the spend
   * guard does not cover — a run per click, past the cap, with no job behind it.
   * It takes no lock of its own either, so `docs/lock-order.md` is unchanged:
   * this is one org-scoped SELECT followed by `create`'s own transaction.
   *
   * Any status may be retried. The queue screen only offers the button on a
   * terminal run, but "is this worth asking again" is the reader's judgement,
   * and a retry of a live run is bounded by the same cap as any other create.
   * Nothing about the run being retried changes — dismissing it is a separate
   * act, done by the screen once the new run is known to exist.
   */
  async retry(orgId: string, id: string) {
    const rows = await db
      .select({ brandId: schema.pipelineRuns.brandId, input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)))
      .limit(1);
    const row = rows[0];
    // The same 404 an id that never existed gets: a caller asking about another
    // org's run learns nothing from the answer, least of all that it is there.
    if (!row) throw notFound("run_not_found", "Run not found");

    const stored = parseStoredInput.transform(row.input);
    // `?? undefined` on both nullable members, and it is the same defect twice:
    // the STORED shape spells "absent" as `null` while the REQUEST spells it as
    // an omitted key, and `z.string().optional()` refuses `null` on the type
    // check before any refine runs. The brand comes off the ROW rather than out
    // of the input, which does not carry it.
    return this.create(
      orgId,
      parseRunCreate.transform({
        brandId: row.brandId,
        contentType: stored.contentType,
        generateCover: stored.generateCover,
        generateInlineImages: stored.generateInlineImages,
        seoKeywords: stored.seoKeywords,
        useEditorialFeedback: stored.useEditorialFeedback,
        brief: stored.text ?? undefined,
        ...(stored.kind === "source"
          ? { material: stored.material, sourceUrl: stored.sourceUrl ?? undefined }
          : {}),
        channelIds: stored.channelIds,
      }),
    );
  }

  /**
   * Locks one run row for the rest of the caller's transaction and returns its
   * status, so a verdict taken from it cannot go stale before the write that
   * depends on it.
   *
   * `FOR UPDATE` is load-bearing rather than decoration: the worker claims a
   * run with an UPDATE on this same row (the fence, generation-engine spec §5), which takes the
   * same lock. Locking here serialises "is this still cancellable?" against "I
   * am running it now" — either we see the worker's claim, or the worker's
   * claim waits for this transaction and then re-reads a status it must stop
   * on.
   */
  private async lockRun(tx: Tx, orgId: string, id: string): Promise<RunStatus> {
    const rows = await tx
      .select({ status: schema.pipelineRuns.status })
      .from(schema.pipelineRuns)
      .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)))
      .limit(1)
      .for("update");
    const run = rows[0];
    if (!run) throw notFound("run_not_found", "Run not found");
    return run.status;
  }

  /**
   * Cancels a run AND the job behind it, in one transaction.
   *
   * Writing the status alone would not be a cancellation at all — the same
   * lesson `ContentRepository.reject` learned about publish jobs, and worse
   * here, because the job it leaves alive keeps spending the org's money to
   * completion and then writes a content item nobody asked for. The worker
   * re-reads this status under its fence before each step and returns without
   * throwing once it sees `cancelled`.
   *
   * Ledger rows already written are deliberately kept: the money was spent, and
   * a cancellation that erased the record of it would misreport the org's bill.
   */
  async cancel(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      const status = await this.lockRun(tx, orgId, id);
      if (!isCancellable(status)) {
        throw conflict(NOT_CANCELLABLE_CODE[status], NOT_CANCELLABLE_MESSAGE[status]);
      }
      await this.queue.cancelGenerate(tx, id, orgId);
      // Query builder, not `db.execute(sql\`…\`)`: `updated_at`'s `$onUpdate`
      // fires for a built UPDATE and never for raw SQL, so a raw statement here
      // would have to set the timestamp itself (as the worker's raw checkpoint
      // writes do).
      await tx
        .update(schema.pipelineRuns)
        .set({ status: "cancelled" })
        .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)));
    });
    return this.get(orgId, id);
  }

  /**
   * Clears a finished run off the queue strip. Only the strip changes: the run
   * row, its error and its ledger rows all stay, because dismissing is
   * acknowledging a failure, not deleting the record of one.
   */
  async dismiss(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      const status = await this.lockRun(tx, orgId, id);
      if (isCancellable(status)) {
        throw conflict(NOT_DISMISSABLE_CODE[status], NOT_DISMISSABLE_MESSAGE[status]);
      }
      await tx
        .update(schema.pipelineRuns)
        .set({ dismissedAt: new Date() })
        .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)));
    });
    return this.get(orgId, id);
  }
}
