import { Injectable } from "@nestjs/common";
import { type AiCredential, resolveModel, type StepBrand, type StepUsageSink } from "@pubrick/ai";
import { draftRevisionStep } from "./draft-revision.step";
import {
  classifyRefineFailure,
  type RefineFailure,
  type RefineUsage,
  refineCallContext,
} from "./refine.caller";

export type DraftRevisionOutcome = { usage: RefineUsage[] } & (
  | { ok: true; title: string | null; text: string; reason: string }
  | { ok: false; failure: RefineFailure }
);

/** The provider boundary; e2e tests replace only buildModel. */
@Injectable()
export class DraftRevisionCaller {
  protected buildModel(credential: AiCredential): ReturnType<typeof resolveModel> {
    return resolveModel(credential);
  }

  async run(args: {
    credential: AiCredential;
    brand: StepBrand;
    title: string | null;
    body: string;
    instruction: string;
  }): Promise<DraftRevisionOutcome> {
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
        { title: args.title, body: args.body, instruction: args.instruction },
      );
      return { ok: true, title: output.title, text: output.text, reason: output.reason, usage };
    } catch (error) {
      return { ok: false, failure: classifyRefineFailure(error), usage };
    }
  }
}
