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
  channelIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    // Duplicates are rejected, exactly as `runCreateSchema` rejects them, and
    // for a sharper reason than the run's: here a repeated id is a repeated
    // POST. `create()` writes one `adaptations` row per resolved channel, and
    // an adaptation IS a delivery — `approve` enqueues one publish job per row
    // — so an item admitted with the same channel twice would carry two rows
    // for one channel and send the post there twice, from a single approval.
    // The `publications` in-flight and published indexes cannot see it: both
    // are scoped to ONE adaptation, and these are two.
    //
    // This was NOT caught before, whatever the sibling schema's comment says.
    // What `create()` has is a COUNT comparison — it resolves the requested
    // ids against the brand's channels and compares `channels.length` with
    // `data.channelIds.length` — which a repeated id fails for the same
    // arithmetic reason a stranger's id does, and which therefore answers
    // "One or more channels do not belong to this brand": a 404 about tenancy
    // for a request whose channels are all present, all this brand's, and all
    // permitted. The caller is told to fix the one thing that is not wrong.
    // The refusal belongs here, where the fault is nameable, and the count
    // comparison goes back to meaning only what it can actually tell apart.
    //
    // It is not the guarantee either — `adaptations_one_live_per_item_channel`
    // is. This is the boundary that gives a human the right sentence.
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "channelIds must not contain duplicates",
    }),
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

/**
 * WHAT HAPPENED TO ONE CHANNEL'S POST — the `deliveryOutcome` the api reports
 * on every adaptation it returns, and the only field a screen needs in order to
 * label a delivery.
 *
 * Six of the seven values are the adaptation row's own `status`, forwarded:
 *
 * - `pending` — created, not approved yet. Nothing has been sent.
 * - `scheduled` — approved for a future time; the queue holds the job until it.
 * - `queued` — approved and handed to the queue; a worker will pick it up.
 * - `publishing` — a worker is talking to the platform right now.
 * - `published` — the platform accepted the post. This is the one outcome that
 *   carries an `externalUrl`.
 * - `failed` — the attempt ended and NOTHING reached the platform. Safe to
 *   approve again: re-approving sends the post for the first time.
 *
 * The seventh has no column of its own and is the reason this field exists:
 *
 * - `unknown` — the request may have left this process and never came back.
 *   The post may be live in the channel and nothing here can tell. It carries
 *   no `externalUrl` — there is no answer to have learned one from — and it is
 *   emphatically NOT `failed`: re-approving an unknown delivery can put a
 *   SECOND copy in someone's channel, so a human has to open the channel and
 *   look first.
 *
 * The adaptation column cannot hold that seventh value: `failed` is its only
 * terminal-and-not-published state, and the distinction lives one table over,
 * on the `publications` receipt the worker writes per attempt (`unknown`
 * there). The api joins the two — a `failed` adaptation whose most recent
 * finished receipt says `unknown` is reported here as `unknown` — so that a
 * browser never has to, and so the queue and the item screen cannot disagree.
 * The status is part of the pair on purpose: a re-approved adaptation is
 * `queued` again, and an older attempt's `unknown` receipt must not keep
 * describing the delivery that is currently in flight.
 */
export const DELIVERY_OUTCOMES = [
  "pending",
  "scheduled",
  "queued",
  "publishing",
  "published",
  "failed",
  "unknown",
] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** Is this string one of the outcomes? Guards a value read back off the wire. */
export function isDeliveryOutcome(value: unknown): value is DeliveryOutcome {
  return typeof value === "string" && (DELIVERY_OUTCOMES as readonly string[]).includes(value);
}
