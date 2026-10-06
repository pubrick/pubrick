import { parseArgs } from "node:util";

const REQUIRED_PROVIDER_JOURNEY =
  "account, manual approval, verified channel, worker publication and UI tenant switching";

/** Focus a rerun without changing the owned stack or skipping its provider-boundary proof. */
export function journeySelection(args) {
  const { values } = parseArgs({
    args,
    options: { grep: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  if (values.grep === undefined) return undefined;
  if (!values.grep.trim() || values.grep.length > 200)
    throw new Error("Use a nonempty journey pattern of at most 200 characters");
  // Playwright accepts a regular expression. Validate it before allocating the stack.
  new RegExp(values.grep);
  return `(?:${REQUIRED_PROVIDER_JOURNEY})|(?:${values.grep})`;
}
