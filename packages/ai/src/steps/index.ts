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
/**
 * How a step is built — exported, while `callStep` is not.
 *
 * The five roles above are not the only steps there will ever be: the API's
 * editor-side calls are made from outside this package, and with no subpath map
 * in `package.json` the barrel is the only door. So `defineStep` and the
 * `Material` its callback returns are public.
 *
 * That gives away none of the three things this module's boundary is actually
 * for. A step still hands over role lines and material SEPARATELY and has no
 * say in where either goes, so material still cannot reach `instructions`; the
 * schema a caller reads off `step.schema` is still the one reference sent to
 * the model; and a step still cannot emit a ledger row without its own name
 * attached, because attribution is built here and is not in the context a
 * caller supplies. An earlier draft of the 2b-2 spec argued that exporting this
 * loosened the boundary — it does not, and it is `callStep` staying private
 * that keeps all three true. Reach it any other way and you are writing a
 * `run` by hand, which is the thing being prevented.
 */
export { defineStep, type Material } from "./prompt.js";
export { RESEARCHER, type ResearchOutput, researchSchema } from "./researcher.js";
export type {
  RunStepContext,
  Step,
  StepAttribution,
  StepBrand,
  StepContext,
  StepUsageSink,
} from "./types.js";
export { type DraftOutput, draftSchema, WRITER, type WriterInput } from "./writer.js";
