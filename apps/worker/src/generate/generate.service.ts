import { randomUUID } from "node:crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import {
  type AiCredential,
  adapterFor,
  EDITOR,
  FACTCHECK,
  RESEARCHER,
  resolveModel,
  type Step,
  type StepAttribution,
  type StepContext,
  type UsageRecord,
  WRITER,
} from "@pubrick/ai";
import { type GenerateJob, PermanentError } from "@pubrick/shared";
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

/** How a step ended when it did not produce a value. */
const STOPPED = Symbol("stopped");
type Stopped = typeof STOPPED;

/** Bounded — this rides out a database hiccup, it does not retry forever. */
const TERMINAL_WRITE_MAX_ATTEMPTS = 3;

/**
 * One sentence for one situation, reachable from two places: the channels were
 * already gone when the run started, and they went away while it worked. The
 * user cannot tell those apart and should not have to.
 */
const EVERY_CHANNEL_DELETED =
  "Every channel this run was started for has since been deleted. Add a channel and try again.";

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * `pipeline_runs.input` as this increment can execute it.
 *
 * Parsed here rather than trusted, because it is a jsonb column: a row written
 * by an older build, or by a future `kind: "topic"` producer this worker does
 * not understand yet, must fail the run with a sentence rather than throw a
 * `TypeError` deep inside a step and be retried until the attempts run out.
 */
const briefInputSchema = z.object({
  kind: z.literal("brief"),
  text: z.string().min(1),
  channelIds: z.array(z.string().uuid()).min(1),
});

type ModelFactory = (credential: AiCredential, modelId?: string) => ReturnType<typeof resolveModel>;

/** Everything one run's step loop carries around. */
type RunState = {
  orgId: string;
  runId: string;
  brandId: string;
  fence: string;
  ctx: StepContext;
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
    try {
      payload = await this.execute(claimed, fence, job.signal);
    } catch (error) {
      if (error instanceof PermanentError) {
        await this.recordFailure(orgId, runId, fence, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      // Best effort: the point of this write is visibility, and losing it must
      // not swallow the error that actually needs to reach pg-boss.
      try {
        await this.repo.recordTransient(orgId, runId, fence, message);
      } catch (writeError) {
        this.logger.warn(
          `Could not record a transient error on run ${runId}: ` +
            `${writeError instanceof Error ? writeError.message : String(writeError)}`,
        );
      }
      throw error;
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
      const marked = await this.repo.markExhausted(
        job.orgId,
        job.runId,
        "This run was retried until its attempts ran out. Try again.",
      );
      if (marked) this.logger.warn(`Run ${job.runId} failed: retries exhausted`);
    } catch (error) {
      this.logger.error(
        `MARK EXHAUSTED FAILED: run ${job.runId} may be stuck in a non-terminal status. ` +
          `orgId=${job.orgId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The five roles, in order, resuming past whatever already has a checkpoint. */
  private async execute(
    run: ClaimedRun,
    fence: string,
    signal: AbortSignal | undefined,
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
      throw new PermanentError(
        "No AI provider key is configured for this organization. Add one in Settings, then try again.",
      );
    }

    const usage = new Map<string, UsageRecord[]>();
    const state: RunState = {
      orgId: run.orgId,
      runId: run.id,
      brandId: run.brandId,
      fence,
      checkpoints: { ...run.steps },
      usage,
      signal,
      ctx: {
        brand: context.brand,
        brief: input.text,
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
  private async runStep<I, O>(state: RunState, step: Step<I, O>, input: I): Promise<O | Stopped> {
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
  private resume<I, O>(state: RunState, step: Step<I, O>): O | undefined {
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

  private parseInput(input: unknown): z.infer<typeof briefInputSchema> {
    const parsed = briefInputSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PermanentError(`This run's input cannot be executed by this worker: ${detail}`);
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
      throw new PermanentError(EVERY_CHANNEL_DELETED);
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
          await this.recordFailure(orgId, runId, fence, EVERY_CHANNEL_DELETED);
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
    message: string,
  ): Promise<void> {
    for (let attempt = 1; attempt <= TERMINAL_WRITE_MAX_ATTEMPTS; attempt++) {
      try {
        const outcome = await this.repo.recordFailure(orgId, runId, fence, message);
        if (outcome === "held") this.logger.warn(`Run ${runId} failed: ${message}`);
        else this.logger.log(`Run ${runId} failed (${message}) but the fence was already lost`);
        return;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (attempt === TERMINAL_WRITE_MAX_ATTEMPTS) {
          this.logger.error(
            `MARK FAILED WRITE FAILED: run ${runId} may be stuck in "running" with no job left to ` +
              `move it. orgId=${orgId} reason=${message} error=${detail}`,
          );
          return;
        }
        await sleep(this.terminalRetryDelayMs * attempt);
      }
    }
  }
}
