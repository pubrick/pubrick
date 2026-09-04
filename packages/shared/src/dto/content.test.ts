import { describe, expect, it } from "vitest";
import {
  ADAPTATION_STATUSES,
  adaptationUpdateSchema,
  contentCreateSchema,
  contentUpdateSchema,
  DELIVERY_OUTCOMES,
  isDeliveryOutcome,
  isOutstandingAdaptation,
  MAX_BODY_LENGTH,
  OUTSTANDING_ADAPTATION_STATUSES,
} from "./content.js";

const BRAND = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";

/**
 * The canonical form of a body, pinned at the boundary every writer crosses.
 *
 * This is not a formatting preference. A `<textarea>` strips CR from its API
 * value, so a stored CR makes the provenance lens's overlay — which renders
 * slices of the string, not of the DOM value — lay down more characters than
 * the field it sits on: every highlight after it slides off the words it
 * describes, and the counter reports a length no amount of deleting can reach.
 *
 * It is reachable, and was reached: `POST /api/content` with a CRLF body
 * stored it verbatim and `GET` returned it, and the callers that route through
 * these schemas are exactly the ones the publish gate's docstring names — the
 * public API, the MCP server, a script.
 */
describe("body newline normalisation", () => {
  it("stores a CRLF body with U+000A newlines", () => {
    const parsed = contentCreateSchema.parse({
      brandId: BRAND,
      body: "Line one.\r\nLine two.",
      channelIds: [CHANNEL],
    });
    expect(parsed.body).toBe("Line one.\nLine two.");
  });

  it("normalises a lone CR too, which no keyboard produces and every old export does", () => {
    const parsed = contentCreateSchema.parse({
      brandId: BRAND,
      body: "Line one.\rLine two.",
      channelIds: [CHANNEL],
    });
    expect(parsed.body).toBe("Line one.\nLine two.");
  });

  it("normalises on update, so an edit cannot reintroduce what create removed", () => {
    expect(contentUpdateSchema.parse({ body: "A.\r\nB." }).body).toBe("A.\nB.");
  });

  it("normalises an adaptation override, the other text the lens paints", () => {
    expect(adaptationUpdateSchema.parse({ body: "A.\r\nB." }).body).toBe("A.\nB.");
  });

  it("still lets an override be cleared with null", () => {
    // `null` means "this channel ships the item's own body" and must not be
    // caught by a transform that only knows about strings.
    expect(adaptationUpdateSchema.parse({ body: null }).body).toBeNull();
  });

  it("bounds the length AFTER normalising, so a CRLF body is not refused for a dropped character", () => {
    // `MAX_BODY_LENGTH` is the length of what gets STORED. A body of
    // MAX_BODY_LENGTH + 1 characters that collapses to exactly the limit fits,
    // and refusing it would be refusing a character the product is about to
    // drop anyway.
    const body = `${"x".repeat(MAX_BODY_LENGTH - 1)}\r\n`;
    expect(body).toHaveLength(MAX_BODY_LENGTH + 1);
    const parsed = contentUpdateSchema.parse({ body });
    expect(parsed.body).toHaveLength(MAX_BODY_LENGTH);
  });

  it("still refuses a body over the limit once normalised", () => {
    const body = `${"x".repeat(MAX_BODY_LENGTH)}\r\ny`;
    expect(contentUpdateSchema.safeParse({ body }).success).toBe(false);
  });

  it("still refuses an empty body", () => {
    expect(
      contentCreateSchema.safeParse({ brandId: BRAND, body: "", channelIds: [CHANNEL] }).success,
    ).toBe(false);
    expect(adaptationUpdateSchema.safeParse({ body: "" }).success).toBe(false);
  });

  it("still refuses a PATCH with no fields at all", () => {
    // The transform sits inside the object, so the refine that keeps drizzle
    // from being handed an empty SET clause must survive it.
    expect(contentUpdateSchema.safeParse({}).success).toBe(false);
  });
});

/**
 * A repeated channel id is a repeated POST.
 *
 * `create()` writes one `adaptations` row per resolved channel and an
 * adaptation IS a delivery — `approve` enqueues one publish job per row — so an
 * item admitted with the same channel twice sends the post there twice from a
 * single approval. Measured before this refine and the matching unique index
 * existed: writing the second adaptation directly and approving the item
 * enqueued two live publish jobs under one channel's group.
 *
 * The refine is the boundary that gives a human the right sentence; the
 * database's `adaptations_one_live_per_item_channel` is the guarantee.
 */
describe("duplicate channels on create", () => {
  it("refuses the same channel twice", () => {
    const parsed = contentCreateSchema.safeParse({
      brandId: BRAND,
      body: "Ship it.",
      channelIds: [CHANNEL, CHANNEL],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("must not contain duplicates");
  });

  it("still admits a genuine fan-out to two different channels", () => {
    const second = "33333333-3333-4333-8333-333333333333";
    const parsed = contentCreateSchema.safeParse({
      brandId: BRAND,
      body: "Ship it.",
      channelIds: [CHANNEL, second],
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * Why the refusal cannot be left to the repository, which is where it used to
   * land by accident: `create()` resolves the requested ids against the brand's
   * channels and compares `channels.length` with `data.channelIds.length`, so a
   * REPEATED id fails that arithmetic exactly as a STRANGER'S id does — and is
   * answered with "One or more channels do not belong to this brand". A 404
   * about tenancy, for a request whose channels are all present, all this
   * brand's and all permitted. This test is the pin on the distinction: the
   * duplicate is refused here, by name, before the count comparison is asked a
   * question it cannot tell apart.
   */
  it("names duplication rather than tenancy", () => {
    const parsed = contentCreateSchema.safeParse({
      brandId: BRAND,
      body: "Ship it.",
      channelIds: [CHANNEL, CHANNEL],
    });
    expect(JSON.stringify(parsed.error?.issues)).not.toContain("belong to this brand");
  });
});

/**
 * The set four call sites used to spell out for themselves, in two apps and
 * from two directions: "what must I cancel?" (`BrandsRepository.delete`,
 * `ChannelsRepository.delete`, `ContentRepository.reject`) and "what may I
 * send?" (`PublishRepository`'s claim). One fact — a live pg-boss publish job
 * exists for this row — so one list, and these are what notice a member moving.
 *
 * The complement matters as much as the set: `pending` and `failed` have no job
 * to cancel, and `published` is history. `publishing` was once missing from the
 * cancel half, and a reject during a retry chain then matched nothing, leaving
 * the adaptation there for ever with no job behind it.
 */
describe("which deliveries still have a publish job", () => {
  it("is exactly the three statuses a job is behind", () => {
    expect([...OUTSTANDING_ADAPTATION_STATUSES]).toEqual(["queued", "scheduled", "publishing"]);
  });

  it("answers for every adaptation status, and leaves the three with no job out", () => {
    expect(ADAPTATION_STATUSES.filter((s) => !isOutstandingAdaptation(s))).toEqual([
      "pending",
      "published",
      "failed",
    ]);
  });
});

/**
 * The api's `deliveryOutcome` is the adaptation column plus the one value the
 * column cannot hold. Derived rather than listed, so this asserts the SHAPE of
 * the derivation — that nothing but `unknown` was added, and that the column's
 * own order is preserved — rather than re-listing the members.
 */
describe("what the wire can say about a delivery", () => {
  it("adds exactly one value to the adaptation column's own", () => {
    expect(
      DELIVERY_OUTCOMES.filter((o) => !(ADAPTATION_STATUSES as readonly string[]).includes(o)),
    ).toEqual(["unknown"]);
  });

  it("recognises every one of them, and nothing else", () => {
    for (const outcome of DELIVERY_OUTCOMES) expect(isDeliveryOutcome(outcome)).toBe(true);
    expect(isDeliveryOutcome("in_flight")).toBe(false);
  });
});
