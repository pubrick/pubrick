import { randomUUID } from "node:crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import {
  type AiCredential,
  adapterFor,
  EDITOR,
  FACTCHECK,
  RESEARCHER,
  type RunStepContext,
  redactSecrets,
  resolveModel,
  runFailureOf,
  type Step,
  type StepAttribution,
  type UsageRecord,
  WRITER,
  withRunFailure,
} from "@pubrick/ai";
import {
  briefRunInputSchema,
  type GenerateJob,
  PermanentError,
  type RunFailure,
  sourceRunInputSchema,
} from "@pubrick/shared";
import { z } from "zod";
import {
  type ClaimedRun,
  type FenceOutcome,
  GenerateRepository,
  type RunContext,
  type TerminalPayload,
} from "./generate.repository";

export type { GenerateJob } from "@pubrick/shared";

/**
 * The pg-boss envelope, not just the payload.
 *
 * The task brief sketches `handle(job: GenerateJob)`, but the fence needs the
 * JOB's identity and `GenerateJob` is only the `data` the api sent. Taking the
 * envelope keeps the handler honest about where its fence token comes from
 * instead of reconstructing a job id from the payload — the mistake
 * `cancelPublish` already learned about one queue over.
 *
 * `signal` is pg-boss's own per-delivery `AbortSignal`. It is aborted at exactly
 * the moment that makes a second handler possible: `Manager#handleWork` wraps
 * the handler in `resolveWithinSeconds(…, expireInSeconds, ac)`, which stops
 * WAITING and aborts — it cannot stop the promise. So the abort is the earliest
 * notice that this delivery has been given up on, arriving before the
 * re-dispatched handler has claimed anything and therefore before the fence
 * itself can tell us. It also fires on a graceful shutdown. Optional, because
 * nothing but pg-boss supplies one.
 */
export type GenerateJobEnvelope = { id: string; data: GenerateJob; signal?: AbortSignal };

/**
 * THE MEMBERS OF `pipeline_runs.input` THIS BUILD CAN RUN — enumerated here,
 * never aliased to `runInputSchema`.
 *
 * The two schemas answer different questions and the day they diverge is the
 * day the alias becomes a bug: `runInputSchema` is *what may be stored*, and it
 * will gain `"topic"` before any worker can execute one. A run of a kind this
 * build does not understand must fail with a sentence rather than be admitted
 * and then crash inside a step — so the list of executable members is written
 * out, and adding one is a deliberate edit to this line rather than something a
 * worker inherits from a DTO change made for the api's sake.
 *
 * `briefRunInputSchema` was this whole declaration until 3a, under a docstring
 * promising exactly this. This is that promise being kept, not abandoned.
 */
const executableRunInputSchema = z.discriminatedUnion("kind", [
  briefRunInputSchema,
  sourceRunInputSchema,
]);
/**
 * Inferred from the schema above, never hand-written as `BriefRunInput |
 * SourceRunInput`: a hand-written alias is a second description of the same
 * list, and the one that silently stops agreeing is always the one no parse
 * runs against.
 */
type ExecutableRunInput = z.infer<typeof executableRunInputSchema>;

/** How a step ended when it did not produce a value. */
const STOPPED = Symbol("stopped");
type Stopped = typeof STOPPED;

/** Bounded — this rides out a database hiccup, it does not retry forever. */
const TERMINAL_WRITE_MAX_ATTEMPTS = 3;

/**
 * One situation, reachable from two places: the channels were already gone when
 * the run started, and they went away while it worked. The user cannot tell
 * those apart and should not have to.
 *
 * The CODE is what the run row stores and the screens translate; the sentence
 * is the log's, in the one language logs are written in.
 */
const EVERY_CHANNEL_DELETED: RunFailure = "every_channel_deleted";
const EVERY_CHANNEL_DELETED_DETAIL =
  "every channel this run was started for has since been deleted";

/**
 * The org's decrypted key, carried from where it is loaded to where a failure is
 * logged.
 *
 * `execute` decrypts it; the catch that writes the log line lives in `handle`,
 * one frame out, and needs it to scrub the provider's own sentence before an
 * operator (or pg-boss's `job.output` column) sees it. A box rather than a
 * return value because the value is wanted on the path where `execute` THROWS.
 */
type SecretBox = { apiKey?: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Scrub the provider's own sentence in place, on the error that is about to be
 * rethrown to pg-boss.
 *
 * pg-boss serialises a failed handler's error into `pgboss.job.output`, which
 * is a second place a decrypted key would come to rest — not a browser, but
 * plaintext in a table that outlives the run. Mutated rather than replaced so
 * the class, the cause and the stack all survive: the queue reads none of them,
 * but whoever is debugging does.
 */
function redactInPlace(error: unknown, secret: string | undefined): unknown {
  if (error instanceof Error) error.message = redactSecrets(error.message, secret);
  return error;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

type ModelFactory = (credential: AiCredential, modelId?: string) => ReturnType<typeof resolveModel>;

/** Everything one run's step loop carries around. */
type RunState = {
  orgId: string;
  runId: string;
  brandId: string;
  fence: string;
  ctx: RunStepContext;
  checkpoints: ClaimedRun["steps"];
  /** Ledger rows produced per step key, mirrored into that step's checkpoint. */
  usage: Map<string, UsageRecord[]>;
  signal: AbortSignal | undefined;
};

@Injectable()
export class GenerateService {
  private readonly logger = new Logger(GenerateService.name);

  /**
   * The two parameters after `repo` are test seams, not providers — same reason
   * and same `@Optional()` as `PublishService`: Nest resolves every constructor
   * parameter by its reflected type, and a function type reflects as bare
   * `Object`, which would make `WorkerModule` fail to boot.
   */
  constructor(
    private readonly repo: GenerateRepository,
    @Optional() private readonly buildModel: ModelFactory = resolveModel,
    /** Backoff unit between terminal-write attempts; 0 in tests for determinism. */
    @Optional() private readonly terminalRetryDelayMs: number = 200,
  ) {}

  /**
   * Run one generation, from wherever its checkpoints left off.
   *
   * The failure policy is deliberately asymmetric, and both halves are load
   * bearing. A PERMANENT error is recorded on the run and the handler RETURNS
   * NORMALLY, which completes the pg-boss job: rethrowing would retry a job that
   * cannot succeed, and each retry is another model call the org pays for.
   * Anything else — a transient provider error, or an unclassified failure such
   * as a dropped database connection — is rethrown so pg-boss retries, which is
   * nearly free because every finished step is checkpointed.
   *
   * Losing the fence, being cancelled, and finding the run row deleted are none
   * of them errors: they log and return. A retry would only lose again, and
   * `DELETE /api/brands/:id` cascading to `pipeline_runs` is an ordinary thing
   * for a user to do while a run is in flight.
   */
  async handle(job: GenerateJobEnvelope): Promise<void> {
    const { runId, orgId } = job.data;
    // `<job id>#<nonce>`: see `GenerateRepository.claim`. pg-boss reuses a job's
    // id across retries, so the job id alone cannot tell "the previous handler
    // is dead and I am its retry" from "the previous handler is alive and I am
    // its expiry re-dispatch". The nonce makes the later delivery the owner and
    // the earlier one stop.
    const fence = `${job.id}#${randomUUID()}`;

    const claimed = await this.repo.claim(orgId, runId, fence, job.id);
    if (!claimed) {
      const why = await this.repo.explain(orgId, runId, fence);
      this.logger.log(`Run ${runId} not claimed (${why}); another handler owns it or it is over`);
      return;
    }

    let payload: TerminalPayload | Stopped;
    // Filled in by `execute` the moment the org's key is decrypted, so the
    // catch below can take that key back out of whatever the provider said.
    const secret: SecretBox = {};
    try {
      payload = await this.execute(claimed, fence, job.signal, secret);
    } catch (error) {
      // The two halves of a failure, and they go to two different places. The
      // CODE is stored and shown, in the reader's own language; the provider's
      // own sentence is only ever logged, and only after `redactSecrets` — it
      // is the sentence that quotes the submitted key back at us.
      const failure = runFailureOf(error) ?? "internal";
      const detail = redactSecrets(messageOf(error), secret.apiKey);

      if (error instanceof PermanentError) {
        await this.recordFailure(orgId, runId, fence, failure, detail);
        return;
      }
      // Best effort: the point of this write is visibility, and losing it must
      // not swallow the error that actually needs to reach pg-boss.
      try {
        await this.repo.recordTransient(orgId, runId, fence, failure);
      } catch (writeError) {
        this.logger.warn(
          `Could not record a transient error on run ${runId}: ` +
            `${redactSecrets(messageOf(writeError), secret.apiKey)}`,
        );
      }
      this.logger.warn(`Run ${runId} hit a transient failure (${failure}): ${detail}`);
      throw redactInPlace(error, secret.apiKey);
    }

    if (payload === STOPPED) return;
    await this.finish(orgId, runId, fence, claimed.brandId, payload);
  }

  /**
   * pg-boss DLQ consumer: the retries ran out with no permanent error ever
   * firing, so the run is stuck with nothing left to move it.
   *
   * Never throws — a dead-letter delivery has nowhere left to go, and rethrowing
   * would only bounce the copy around.
   */
  async markExhausted(job: GenerateJob): Promise<void> {
    try {
      const marked = await this.repo.markExhausted(job.orgId, job.runId, "retries_exhausted");
      if (marked) this.logger.warn(`Run ${job.runId} failed: retries exhausted`);
    } catch (error) {
      this.logger.error(
        `MARK EXHAUSTED FAILED: run ${job.runId} may be stuck in a non-terminal status. ` +
          `orgId=${job.orgId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The scheduled sweep: fail every run that no job can ever move again.
   *
   * The state it recovers from is not hypothetical and not reachable by any
   * other path. pg-boss re-inserts a failed job under the SAME id, so a
   * heartbeat re-dispatch gives handler B a job id handler A still holds. The
   * fence does its work — B claims, A stops — but A then returns into pg-boss's
   * wrapper, which runs `complete()` for that id and lands it on B's live
   * incarnation. B carries on with a job that is already `completed`; if B then
   * throws a retryable provider error, `failJobsById`'s `state < 'completed'`
   * guard makes the failure a no-op. No retry, no dead letter, and therefore no
   * `markExhausted` — the run stays `running` for ever.
   *
   * Never throws, for the same reason `markExhausted` does not: this runs on a
   * schedule with nobody waiting on it, and a rethrow would only re-deliver the
   * sweep job to do the same thing again.
   */
  async sweepAbandoned(): Promise<void> {
    try {
      const swept = await this.repo.sweepAbandoned();
      for (const run of swept) {
        // `error`, not `warn`. A swept run means the queue lost a job that was
        // supposed to move it — the org paid for work that produced nothing and
        // an operator should go and look at why. It is never routine.
        this.logger.error(
          `SWEPT ABANDONED RUN: run ${run.id} sat in "running" two lease periods past its lease ` +
            "with no pg-boss job left anywhere to move it; failed it so it cannot hold a " +
            `concurrency slot for ever. orgId=${run.orgId}`,
        );
      }
    } catch (error) {
      this.logger.error(`ABANDONED-RUN SWEEP FAILED: ${messageOf(error)}`);
    }
  }

  /** The five roles, in order, resuming past whatever already has a checkpoint. */
  private async execute(
    run: ClaimedRun,
    fence: string,
    signal: AbortSignal | undefined,
    secret: SecretBox,
  ): Promise<TerminalPayload | Stopped> {
    const input = this.parseInput(run.input);
    const context = await this.loadContext(run, input.channelIds);
    if (context === undefined) {
      // The brand is gone, which means this run row is gone too (the FK cascades)
      // or is about to be. Ordinary fence loss, not an error.
      this.logger.log(`Run ${run.id} stopped: its brand no longer exists`);
      return STOPPED;
    }

    const credential = await this.repo.credential(run.orgId);
    if (!credential) {
      throw withRunFailure(
        new PermanentError("no AI provider key is configured for this organization"),
        "no_api_key",
      );
    }
    // From here on the key is in scope, so anything thrown from here on may
    // quote it. `handle` reads this to scrub what it logs.
    secret.apiKey = credential.apiKey;

    const usage = new Map<string, UsageRecord[]>();
    const state: RunState = {
      orgId: run.orgId,
      runId: run.id,
      brandId: run.brandId,
      fence,
      checkpoints: { ...run.steps },
      usage,
      signal,
      // The signal is polled at the step boundary (see `runStep`) and is
      // DELIBERATELY not passed into `ctx` as `abortSignal`. `StepContext`
      // accepts one and `callStep` forwards it, so `abortSignal: state.signal`
      // is a one-token edit that looks like finishing the job. It is a
      // regression, and the chain is short:
      //
      //   - an abort inside the SDK throws an `AbortError`;
      //   - `classifyAiError` maps that to a `PermanentError` — correct there,
      //     because a caller that withdrew its request must not be billed for
      //     a retry;
      //   - but `handle` treats EVERY `PermanentError` as a terminal run
      //     failure: `recordFailure`, then return normally, completing the job;
      //   - and pg-boss aborts on expiry BEFORE the re-dispatched delivery
      //     claims, so the losing handler still holds the fence. Its
      //     `recordFailure` lands (`status = 'running'` and the fence still
      //     match), the run goes to `failed`, and the re-dispatch's `claim` —
      //     `status in ('queued','running')` — then refuses it.
      //
      // Net: an expired delivery permanently kills a run that today resumes by
      // itself from its checkpoints, and tells the user "the model call was
      // cancelled before it finished" about something nobody cancelled. The
      // signal means "this DELIVERY is over", not "this RUN is over"; only the
      // step-boundary poll reads it that way. An in-flight call is left to
      // finish so the work it is already paying for gets checkpointed.
      ctx: {
        brand: context.brand,
        // THE THREE TEXT FIELDS COME FROM THE ARM THE RUN WAS STORED AS, and
        // each arm names all three: `RunStepContext` makes them
        // required-and-nullable so that an absence is STATED by the builder
        // rather than inherited, which is what keeps the three steps that read
        // them from labelling a block with no text in it.
        //
        // `input.text` is passed THROUGH on both arms and never `?? ""`. On the
        // source arm it is `string | null`, and `""` is the one value that
        // survives every guard downstream while meaning the wrong thing: a
        // labelled but empty BRIEF block tells the model the person wrote
        // nothing USEFUL rather than that they wrote nothing, on three paid
        // calls in a row. `sourceRunInputSchema.text` is `.min(1).nullable()`
        // precisely so `null` is the only way to say "no brief".
        ...(input.kind === "brief"
          ? // A brief run has no material to work from and nothing to
            // attribute; `text` is non-nullable on this arm.
            { brief: input.text, material: null, sourceUrl: null }
          : // A source run may also carry a brief — "or both" is a storable
            // shape — so the brief is not assumed absent here.
            //
            // `sourceUrl` rides along because no later step should be able to
            // receive the material without also being able to see that a URL
            // was recorded. It is ATTRIBUTION, and no step emits it into a
            // block: a URL in a prompt invites the model to write as though it
            // had read the page, and nothing here ever fetched it.
            { brief: input.text, material: input.material, sourceUrl: input.sourceUrl }),
        model: this.buildModel(credential),
        // The credential's provider, never a guess from the model id: it decides
        // which price table every ledger row of this run is costed against.
        provider: credential.provider,
        onUsage: async (record: UsageRecord, attribution: StepAttribution) => {
          const bucket = usage.get(attribution.step);
          if (bucket) bucket.push(record);
          else usage.set(attribution.step, [record]);
          await this.repo.recordUsage(run.orgId, run.id, attribution, record);
        },
        // What happens when the line above fails. Without a handler here the
        // package falls back to a bare `console.error` — outside this logger,
        // outside anything an operator greps, and outside the database
        // entirely — while the SAME method's foreign-key narrowing writes
        // through `this.logger` two lines away. Two channels for one loss, and
        // the durable one was the one that carried nothing.
        onUsageError: (error: unknown, record: UsageRecord) =>
          this.recordUnrecordedCall(run.orgId, run.id, error, record),
      },
    };

    const research = await this.runStep(state, RESEARCHER, undefined);
    if (research === STOPPED) return STOPPED;

    const draft = await this.runStep(state, WRITER, { research });
    if (draft === STOPPED) return STOPPED;

    const edited = await this.runStep(state, EDITOR, { research, body: draft.body });
    if (edited === STOPPED) return STOPPED;

    // The claims list rides with the draft in the run's own checkpoint map; this
    // increment verifies nothing and stores nothing on the content item that
    // could be mistaken for a check having happened.
    const checked = await this.runStep(state, FACTCHECK, { body: edited.body });
    if (checked === STOPPED) return STOPPED;

    const adaptations: Array<{ channelId: string; body: string }> = [];
    for (const channel of context.channels) {
      // Its checkpoint key is `adapter:<channelId>`, so a crash mid-fan-out
      // re-runs only the channels that had not finished.
      const adapted = await this.runStep(state, adapterFor(channel), { body: edited.body });
      if (adapted === STOPPED) return STOPPED;
      adaptations.push({ channelId: channel.id, body: adapted.body });
    }

    return { body: edited.body, adaptations };
  }

  /**
   * One step: skip it if it already has a checkpoint, otherwise re-take the
   * fence, run it, and checkpoint the result.
   *
   * The fence is re-taken BEFORE the model call, never after: checking only at
   * the end means the handler that lost has already spent the money before
   * finding out.
   */
  private async runStep<I, O>(
    state: RunState,
    // A run always has a brief, so it can drive both kinds of step. The
    // assignability only runs this way: `Step<I, O, StepContext>` — the
    // fact-checker and the adapters — satisfies this parameter, while a step
    // that needs a brief could not be passed to a `Step<I, O, StepContext>`
    // parameter at all.
    step: Step<I, O, RunStepContext>,
    input: I,
  ): Promise<O | Stopped> {
    const resumed = this.resume(state, step);
    if (resumed !== undefined) return resumed;

    // pg-boss has given up on this delivery — it expired, or the worker is
    // shutting down. Checked at the step boundary, before any money is spent,
    // and deliberately NOT before the terminal write: by then the run is paid
    // for, and writing the draft it bought is strictly better than discarding
    // it. This is earlier notice than the fence can give, because the
    // re-dispatched handler may not have claimed the run yet.
    if (state.signal?.aborted === true) {
      this.logger.log(
        `Run ${state.runId} stopped at step ${step.name}: this delivery was aborted (expired or shutting down)`,
      );
      return STOPPED;
    }

    if (!(await this.repo.beginStep(state.orgId, state.runId, state.fence, step.name))) {
      return this.stop(state, step.name);
    }

    const output = await step.run(state.ctx, input);

    const written = await this.repo.writeCheckpoint(
      state.orgId,
      state.runId,
      state.fence,
      step.name,
      {
        status: "succeeded",
        output,
        usage: state.usage.get(step.name) ?? [],
        finishedAt: new Date().toISOString(),
      },
    );
    if (written !== "held") {
      // The call was made and its ledger rows are written; only the checkpoint is
      // lost. Stopping here is right either way — whoever owns the run now will
      // redo this step, and we must not go on to the terminal write.
      return this.stop(state, step.name, written);
    }

    state.checkpoints[step.name] = { status: "succeeded", output };
    return output;
  }

  /**
   * A step whose checkpoint already holds a valid output is skipped — that is
   * the whole point of checkpoints, and the reason a resumed run costs nothing
   * for the steps that already succeeded.
   *
   * The stored output is validated against the step's OWN schema, here rather
   * than inside the step: a `ZodError` thrown from a step would reach pg-boss
   * unclassified and be retried until the attempts ran out. A checkpoint that
   * does not parse is treated as a cache miss and the step is re-run — a schema
   * that changed under an in-flight run should cost one call, not brick the run.
   */
  private resume<I, O>(state: RunState, step: Step<I, O, RunStepContext>): O | undefined {
    const checkpoint = state.checkpoints[step.name];
    if (checkpoint?.status !== "succeeded") return undefined;

    const parsed = step.schema.safeParse(checkpoint.output);
    if (!parsed.success) {
      this.logger.warn(
        `Checkpoint for step ${step.name} of run ${state.runId} does not match its schema; ` +
          "re-running the step",
      );
      return undefined;
    }
    return parsed.data;
  }

  private async stop(state: RunState, step: string, known?: FenceOutcome): Promise<Stopped> {
    const why =
      known !== undefined && known !== "held"
        ? known
        : await this.repo.explain(state.orgId, state.runId, state.fence);
    this.logger.log(`Run ${state.runId} stopped at step ${step} (${why})`);
    return STOPPED;
  }

  /**
   * A billed call whose ledger row could not be written: say so where an
   * operator will see it, and record it where a RECEIPT can.
   *
   * Both, not either. The log line is what a person debugging reads; it is not
   * a record, because nobody reads a log to find out what their month cost.
   * `pipeline_runs.unrecorded_calls` is the record — the run row outlives the
   * step, and it is the one place a loss can be counted after the ledger has
   * refused it. `spend()` sums the rows that exist, so without this an
   * understated total is indistinguishable from a correct one.
   *
   * Never throws. It is called from `generateStructured`'s failure path, which
   * is on the success path of a call the provider has ALREADY charged for: the
   * text is in hand, and the whole reason a ledger failure does not raise is
   * that losing the text as well would be strictly worse. If even the counter
   * cannot be written, that is the end of the road and it is logged as such.
   */
  private async recordUnrecordedCall(
    orgId: string,
    runId: string,
    error: unknown,
    record: UsageRecord,
  ): Promise<void> {
    this.logger.error(
      `USAGE RECORDING FAILED: a billed ${record.provider}/${record.modelId} call on run ${runId} ` +
        "could not be written to the ledger — this org's spend is understated by it. " +
        `orgId=${orgId} inputTokens=${record.inputTokens} outputTokens=${record.outputTokens} ` +
        `costUsd=${record.costUsd} error=${messageOf(error)}`,
    );
    try {
      await this.repo.recordUnrecordedCall(orgId, runId);
    } catch (writeError) {
      this.logger.error(
        `UNRECORDED-CALL COUNTER FAILED: run ${runId} was billed for a call that is now recorded ` +
          `NOWHERE — neither in the ledger nor on the run. orgId=${orgId} ` +
          `error=${messageOf(writeError)}`,
      );
    }
  }

  /**
   * `pipeline_runs.input` as this increment can execute it.
   *
   * Parsed rather than trusted, because it is a jsonb column: a row written by
   * an older build, or by a future `kind: "topic"` producer this worker does
   * not understand yet, must fail the run with a sentence rather than throw a
   * `TypeError` deep inside a step and be retried until the attempts run out.
   *
   * The schemas are `@pubrick/shared`'s — the same declarations
   * `pipeline_runs.input` is typed from, so the column's shape and the parse
   * cannot describe different things. Deliberately
   * `executableRunInputSchema` — the `brief` and `source` MEMBERS, spelled out
   * above — and not the column-wide `runInputSchema`: a stored kind this build
   * cannot run is refused here, in one place, before a step is paid for.
   */
  private parseInput(input: unknown): ExecutableRunInput {
    const parsed = executableRunInputSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    // `internal`, not a code of its own: a row this build cannot parse was
    // written by another build of OURS, and there is nothing the reader of the
    // strip can do about it. The zod detail goes to the log with the rest.
    throw withRunFailure(
      new PermanentError(`this run's input cannot be executed by this worker: ${detail}`),
      "internal",
    );
  }

  /**
   * The brand and the channels still standing.
   *
   * A channel deleted mid-run does not throw the whole run away: the remaining
   * channels still get their adaptations, and the deleted one's checkpoint (if
   * it had one) is simply never read again. Losing EVERY channel is different —
   * the terminal write would produce an item with zero adaptations, which
   * `approve` would happily mark approved while enqueueing nothing at all, which
   * is the exact shape `RunsRepository.resolveChannels` refuses at admission.
   */
  private async loadContext(
    run: ClaimedRun,
    channelIds: readonly string[],
  ): Promise<RunContext | undefined> {
    const context = await this.repo.context(run.orgId, run.brandId, channelIds);
    if (!context) return undefined;
    if (context.channels.length === 0) {
      throw withRunFailure(new PermanentError(EVERY_CHANNEL_DELETED_DETAIL), EVERY_CHANNEL_DELETED);
    }
    if (context.channels.length !== channelIds.length) {
      this.logger.warn(
        `Run ${run.id}: ${channelIds.length - context.channels.length} of its channels no longer ` +
          "exist; generating for the rest",
      );
    }
    return context;
  }

  /**
   * The terminal write, with a small bounded retry for a database hiccup.
   *
   * Once it has COMMITTED this handler never throws again — the only thing after
   * it is a log line. A failure to commit is a different matter and IS rethrown
   * after the attempts run out: nothing was written, every step is checkpointed
   * so a retry re-spends nothing, and stranding the run at `running` with a
   * completed job would be the silent stall the queue strip exists to prevent.
   *
   * The dangerous case is neither of those but the ambiguous commit — the
   * transaction landed and the client saw the connection drop. That is why the
   * claim refuses a run that is no longer `queued | running`: the retry cannot
   * re-claim a `succeeded` run, so it cannot write a second content item.
   */
  private async finish(
    orgId: string,
    runId: string,
    fence: string,
    brandId: string,
    payload: TerminalPayload,
  ): Promise<void> {
    for (let attempt = 1; attempt <= TERMINAL_WRITE_MAX_ATTEMPTS; attempt++) {
      try {
        const outcome = await this.repo.finish(orgId, runId, fence, brandId, payload);
        if (outcome === "held") {
          this.logger.log(
            `Run ${runId} succeeded with ${payload.adaptations.length} adaptation(s)`,
          );
        } else if (outcome === "no-channels") {
          // Every channel went away while the run was working. There is no draft
          // to store — an item with zero adaptations is one `approve` would mark
          // approved while enqueueing nothing — so this ends as the same
          // permanent failure `loadContext` raises when the channels were already
          // gone at the start. It is terminal by definition: no retry can bring a
          // deleted channel back.
          await this.recordFailure(
            orgId,
            runId,
            fence,
            EVERY_CHANNEL_DELETED,
            EVERY_CHANNEL_DELETED_DETAIL,
          );
        } else {
          this.logger.log(`Run ${runId} produced no draft (${outcome})`);
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === TERMINAL_WRITE_MAX_ATTEMPTS) {
          this.logger.error(
            `TERMINAL WRITE FAILED: run ${runId} finished generating but its draft could not be ` +
              `written after ${TERMINAL_WRITE_MAX_ATTEMPTS} attempts; retrying the job. ` +
              `orgId=${orgId} lastError=${message}`,
          );
          throw error;
        }
        await sleep(this.terminalRetryDelayMs * attempt);
      }
    }
  }

  /**
   * A permanent failure must reach the run row, or the strip shows a run that is
   * running forever. Retried a bounded number of times, then logged loudly —
   * rethrowing would hand pg-boss a job whose whole point is that it must not be
   * retried.
   */
  private async recordFailure(
    orgId: string,
    runId: string,
    fence: string,
    failure: RunFailure,
    /** The provider's own words, already redacted. Logged, never stored. */
    detail: string,
  ): Promise<void> {
    for (let attempt = 1; attempt <= TERMINAL_WRITE_MAX_ATTEMPTS; attempt++) {
      try {
        const outcome = await this.repo.recordFailure(orgId, runId, fence, failure);
        if (outcome === "held") this.logger.warn(`Run ${runId} failed (${failure}): ${detail}`);
        else this.logger.log(`Run ${runId} failed (${failure}) but the fence was already lost`);
        return;
      } catch (error) {
        if (attempt === TERMINAL_WRITE_MAX_ATTEMPTS) {
          this.logger.error(
            `MARK FAILED WRITE FAILED: run ${runId} may be stuck in "running" with no job left to ` +
              `move it. orgId=${orgId} reason=${failure} error=${messageOf(error)}`,
          );
          return;
        }
        await sleep(this.terminalRetryDelayMs * attempt);
      }
    }
  }
}
