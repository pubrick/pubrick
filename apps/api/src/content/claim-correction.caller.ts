import { Injectable } from "@nestjs/common";
import { type AiCredential, resolveModel, type StepBrand, type StepUsageSink } from "@pubrick/ai";
import { type ClaimCorrectionInput, claimCorrectionStep } from "./claim-correction.step";
import { classifyRefineFailure, type RefineUsage, refineCallContext } from "./refine.caller";

export type ClaimCorrectionOutcome = { usage: RefineUsage[] } & (
  | { ok: true; replacement: string; reason: string }
  | { ok: false; failure: "timed_out" | "failed" }
);

@Injectable()
export class ClaimCorrectionCaller {
  protected buildModel(credential: AiCredential): ReturnType<typeof resolveModel> {
    return resolveModel(credential);
  }

  async run(args: {
    credential: AiCredential;
    brand: StepBrand;
    input: ClaimCorrectionInput;
  }): Promise<ClaimCorrectionOutcome> {
    const usage: RefineUsage[] = [];
    const sink: StepUsageSink = (record, attribution) => {
      usage.push({ record, attribution });
    };
    try {
      const output = await claimCorrectionStep().run(
        refineCallContext(
          this.buildModel(args.credential),
          args.credential.provider,
          args.brand,
          sink,
        ),
        args.input,
      );
      return { ok: true, replacement: output.replacement, reason: output.reason, usage };
    } catch (error) {
      return { ok: false, failure: classifyRefineFailure(error), usage };
    }
  }
}
