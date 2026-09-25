import {
  InvalidTemplateSnapshotError,
  validateTemplateSnapshot as validateSharedTemplateSnapshot,
  withRunFailure,
} from "@pubrick/ai";
import type { schema } from "@pubrick/db";
import { PermanentError } from "@pubrick/shared";

export {
  digest,
  MAX_PINNED_INSTRUCTION_BYTES,
  pinnedInstructionMap,
  receiptDigest,
  TEMPLATE_ENGINE_VERSION,
} from "@pubrick/ai";

/** DB's JSONB hint deliberately remains wider than the validated AI schema. */
export type TemplateSnapshot = NonNullable<
  (typeof schema.pipelineRuns.$inferSelect)["templateSnapshot"]
>;

/** Worker failures are permanent and carry only a closed public error code. */
export function validateTemplateSnapshot(raw: unknown) {
  try {
    return validateSharedTemplateSnapshot(raw);
  } catch (error) {
    if (!(error instanceof InvalidTemplateSnapshotError)) throw error;
    throw withRunFailure(new PermanentError(error.message), "internal");
  }
}
