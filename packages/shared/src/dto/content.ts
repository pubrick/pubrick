import { z } from "zod";
import { normalizeNewlines } from "../provenance.js";

export const MAX_BODY_LENGTH = 4096;

/**
 * A post body, in the one canonical form the rest of the product may assume:
 * newlines are U+000A and nothing else.
 *
 * The normalisation is not tidying. A `<textarea>` strips CR from its API
 * value, so a body carrying one makes the provenance lens's overlay — which
 * renders slices of the string, not of the DOM value — lay down a different
 * number of characters than the field it sits on, sliding every highlight
 * after it off the words it describes and making the counter report a length
 * the field does not hold. `normalizeNewlines`' own docstring has the full
 * mechanism.
 *
 * It belongs **here**, at the DTO, because this is the boundary every writer
 * crosses: the web app, the public API, the MCP server, a script. Fixing it in
 * the component would leave the gate and the mask comparing a stored CR body
 * against a stored CR-free version row.
 *
 * Normalise first, bound second: `MAX_BODY_LENGTH` is the length of what gets
 * *stored*, and CRLF input that fits once collapsed must not be refused for a
 * character the product is about to drop anyway.
 */
const bodyText = z
  .string()
  .transform(normalizeNewlines)
  .pipe(z.string().min(1).max(MAX_BODY_LENGTH));

export const contentCreateSchema = z.object({
  brandId: z.string().uuid(),
  title: z.string().max(300).optional(),
  body: bodyText,
  channelIds: z.array(z.string().uuid()).min(1).max(20),
});
export type ContentCreate = z.infer<typeof contentCreateSchema>;

/**
 * Every field is optional (it is a PATCH), so `{}` parses — but an empty SET
 * clause makes drizzle throw "No values to set", which surfaces as a 500 on
 * what is really a malformed request. Require at least one field.
 */
export const contentUpdateSchema = z
  .object({
    title: z.string().max(300).optional(),
    body: bodyText.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });
export type ContentUpdate = z.infer<typeof contentUpdateSchema>;

export const adaptationUpdateSchema = z.object({
  /** `null` clears the override; this channel then ships the item's own body. */
  body: bodyText.nullable(),
});
export type AdaptationUpdate = z.infer<typeof adaptationUpdateSchema>;

export const contentApproveSchema = z.object({
  /**
   * ISO timestamp; when omitted the post is queued immediately. Must be in the
   * future: pg-boss treats a past `startAfter` as "run now", so a typo'd or
   * stale date would silently publish immediately instead of being scheduled.
   */
  scheduledAt: z
    .string()
    .datetime()
    .refine((value) => new Date(value).getTime() > Date.now(), {
      message: "scheduledAt must be in the future",
    })
    .optional(),
});
export type ContentApprove = z.infer<typeof contentApproveSchema>;
