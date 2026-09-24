import { Injectable } from "@nestjs/common";
import { type AiCredential, resolveModel, type StepBrand, type StepUsageSink } from "@pubrick/ai";
import { draftRevisionStep } from "./draft-revision.step";
import {
  classifyRefineFailure,
  type RefineOutcome,
  type RefineUsage,
  refineCallContext,
} from "./refine.caller";

/** The provider boundary; e2e tests replace only buildModel. */
@Injectable()
export class DraftRevisionCaller {
  protected buildModel(credential: AiCredential): ReturnType<typeof resolveModel> {
    return resolveModel(credential);
  }

  async run(args: {
    credential: AiCredential;
    brand: StepBrand;
    body: string;
    instruction: string;
  }): Promise<RefineOutcome> {
    const usage: RefineUsage[] = [];
    const sink: StepUsageSink = (record, attribution) => {
      usage.push({ record, attribution });
    };
    try {
      const output = await draftRevisionStep().run(
        refineCallContext(
          this.buildModel(args.credential),
          args.credential.provider,
          args.brand,
          sink,
        ),
        { body: args.body, instruction: args.instruction },
      );
      return { ok: true, text: output.text, reason: output.reason, usage };
    } catch (error) {
      return { ok: false, failure: classifyRefineFailure(error), usage };
    }
  }
}
