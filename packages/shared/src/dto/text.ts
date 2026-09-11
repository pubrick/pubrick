/**
 * THE ONE CHARACTER NO COLUMN CAN HOLD.
 *
 * Postgres `text` and `jsonb` cannot store U+0000 — the insert is refused with
 * `22021` (`unsupported Unicode escape sequence` from jsonb, `invalid byte
 * sequence` from text), the driver throws after every validation has passed,
 * and the caller gets a 500 for a request that is simply not storable. A NUL
 * reaches a body the same way a CR does: a paste out of a binary file, a
 * clipboard round-trip through a terminal, an API client assembling a string
 * from bytes. `normalizeNewlines` made the OTHER unstorable-ish character a
 * boundary rule (`CLAUDE.md`); this is the same boundary and the same
 * argument, except that a NUL cannot be normalised into anything — dropping it
 * would silently edit what somebody wrote, and the honest answer is a refusal
 * the caller can read.
 *
 * It lives beside the DTOs rather than in `provenance.ts`: that module answers
 * "who typed this text", and this answers "can this text be stored at all".
 * Every writer crosses a DTO — the web app, the public API, the MCP server, a
 * script — which is why the check belongs here and not in a repository.
 */
export function hasNulByte(text: string): boolean {
  return text.includes("\u0000");
}

/**
 * The developer-facing half of that refusal. It is field-qualified by zod's own
 * path (each member carries its own `.refine`), exactly as every other
 * refinement in these schemas is, and a reader never sees it: the api answers
 * `invalid_request` and the web renders `Errors.invalid_request`.
 */
export const NO_NUL_BYTE_MESSAGE = "must not contain a NUL byte (U+0000)";
