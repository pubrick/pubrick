import { Injectable } from "@nestjs/common";
import {
  type AiCredential,
  resolveModel,
  type StepBrand,
  type StepChannel,
  type StepUsageSink,
} from "@pubrick/ai";
import { readaptStep } from "./readapt.step";
import {
  classifyRefineFailure,
  type RefineOutcome,
  type RefineUsage,
  refineCallContext,
} from "./refine.caller";

export type ReadaptOutcome = RefineOutcome;

/** The only provider boundary for editor-side channel adaptation. */
@Injectable()
export class ReadaptCaller {
  protected buildModel(credential: AiCredential): ReturnType<typeof resolveModel> {
    return resolveModel(credential);
  }

  async run(args: {
    credential: AiCredential;
    brand: StepBrand;
    channel: StepChannel;
    masterBody: string;
    previousBody: string | null;
  }): Promise<ReadaptOutcome> {
    const usage: RefineUsage[] = [];
    const sink: StepUsageSink = (record, attribution) => {
      usage.push({ record, attribution });
    };
    try {
      const step = readaptStep(args.channel);
      const answer = await step.run(
        refineCallContext(
          this.buildModel(args.credential),
          args.credential.provider,
          args.brand,
          sink,
        ),
        { masterBody: args.masterBody, previousBody: args.previousBody },
      );
      return { ok: true, text: answer.body, reason: answer.reason, usage };
    } catch (error) {
      return { ok: false, failure: classifyRefineFailure(error), usage };
    }
  }
}
