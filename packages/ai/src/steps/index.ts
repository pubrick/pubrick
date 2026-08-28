/**
 * The five roles a generation run plays, in order: researcher, writer, editor,
 * fact-checker, adapter (once per channel).
 *
 * Each is a `Step` with the checkpoint key the run stores it under —
 * `researcher | writer | editor | factcheck`, or `adapter:<channelId>` — a zod
 * output schema, and a `run` that makes exactly one metered model call through
 * `generateStructured`. Steps never touch the SDK directly: the prompt boundary
 * (`prompt.ts`) and the metering both live on that path.
 */
export {
  type AdaptationOutput,
  type AdapterInput,
  adaptationLimit,
  adapterFor,
  type Platform,
  type StepChannel,
} from "./adapter.js";
export { EDITOR, type EditOutput, type EditorInput, editSchema } from "./editor.js";
export {
  CLAIMS_TO_VERIFY_LABEL,
  FACTCHECK,
  type FactcheckInput,
  type FactcheckOutput,
  factcheckSchema,
} from "./factcheck.js";
export { RESEARCHER, type ResearchOutput, researchSchema } from "./researcher.js";
export type { Step, StepBrand, StepContext } from "./types.js";
export { type DraftOutput, draftSchema, WRITER, type WriterInput } from "./writer.js";
