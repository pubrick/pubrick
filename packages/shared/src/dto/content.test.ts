import { describe, expect, it } from "vitest";
import {
  ADAPTATION_STATUSES,
  adaptationUpdateSchema,
  CONTENT_STATUSES,
  contentCreateSchema,
  contentUpdateSchema,
  DELIVERY_OUTCOMES,
  isDeliveryOutcome,
  isOutstandingAdaptation,
  MAX_BODY_LENGTH,
  MAX_REFINE_CALLS_PER_HOUR,
  OUTSTANDING_ADAPTATION_STATUSES,
  REFINE_VERBS,
  refineRequestSchema,
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
 * `content_items.status` and `adaptations.status` are typed FROM these two
 * arrays in `@pubrick/db` (`text(col, { enum: CONTENT_STATUSES })`, etc.) and
 * the database's own CHECK constraints are built from the same arrays via
 * `enumCheck` — so a member silently dropped here silently narrows both the
 * TypeScript type and the migration's CHECK at once, and nothing that merely
 * compares one to the other can ever notice: they would still agree, just
 * about a smaller set than the product actually has. `PINNED_ITEM_MESSAGE` and
 * `PINNED_ADAPTATION_MESSAGE` in apps/api are `Record`s keyed by these unions
 * exactly so a status added later is a compile error; a status quietly
 * REMOVED from here is not caught by that mechanism at all, because a
 * `Record` with a spare key compiles fine. This is the one place that can
 * still catch it — by naming the actual members rather than deriving them
 * from anything that could have dropped one too.
 */
describe("the draft and delivery lifecycles keep every status they had", () => {
  it("content status", () => {
    expect(CONTENT_STATUSES).toEqual(["draft", "approved", "rejected", "published", "failed"]);
  });

  it("adaptation status", () => {
    expect(ADAPTATION_STATUSES).toEqual([
      "pending",
      "scheduled",
      "queued",
      "publishing",
      "published",
      "failed",
    ]);
  });
});

/**
 * The verb set is closed by decision, not by omission — see `REFINE_VERBS`'s
 * own docstring. Pinned the same way `CONTENT_STATUSES` and
 * `ADAPTATION_STATUSES` are above: a member silently dropped here would not
 * merely narrow a menu, it would narrow `refine_proposals.verb`'s CHECK
 * constraint (a later task) at once, and nothing that compares one to the
 * other could notice — they would still agree, just about a smaller set.
 */
describe("the refine verb set", () => {
  it("is exactly three, and no more, until a later increment decides otherwise", () => {
    expect(REFINE_VERBS).toEqual(["shorten", "warmer", "punchier"]);
  });
});

/**
 * What a refine request may say, and what it may not.
 *
 * The shape rules only; "the range lies inside THIS body" is the repository's,
 * because a schema cannot see the body. Pinned here because every one of these
 * is a way to spend somebody's money on a selection that is not one.
 */
describe("the refine request", () => {
  const ok = { verb: "shorten" as const, start: 0, end: 12 };

  it("takes a verb and a half-open range, and nothing else", () => {
    const parsed = refineRequestSchema.parse({ ...ok, selectedText: "Café ouvert." });
    // The whole point of the schema: text a caller sent is not carried through.
    // `z.object` strips it, so the repository can only ever read its own body.
    expect(parsed).toEqual(ok);
  });

  it("refuses a collapsed caret — there is nothing to replace", () => {
    expect(refineRequestSchema.safeParse({ ...ok, start: 7, end: 7 }).success).toBe(false);
  });

  it("refuses a backwards range", () => {
    expect(refineRequestSchema.safeParse({ ...ok, start: 12, end: 7 }).success).toBe(false);
  });

  it("refuses a range no body could hold, and a fractional one", () => {
    expect(
      refineRequestSchema.safeParse({ ...ok, end: MAX_BODY_LENGTH + 1 }).success,
      "an end past the longest body there can be",
    ).toBe(false);
    expect(refineRequestSchema.safeParse({ ...ok, start: -1 }).success).toBe(false);
    expect(refineRequestSchema.safeParse({ ...ok, start: 0.5, end: 3 }).success).toBe(false);
  });

  it("refuses a verb outside the closed set", () => {
    expect(refineRequestSchema.safeParse({ ...ok, verb: "translate" }).success).toBe(false);
    // The prototype keys a `verb in ROLE_LINES` test would admit.
    expect(refineRequestSchema.safeParse({ ...ok, verb: "constructor" }).success).toBe(false);
  });
});

/**
 * The refine allowance, pinned the way `MAX_TEST_CALLS_PER_HOUR` is: by
 * re-deriving the promise its docstring makes, never by asserting the literal.
 *
 * `expect(...).toBe(120)` would fire on any edit, including a reasoned one,
 * and would tell the next reader nothing about why 120. What must stay true is
 * the ratio — whatever the number is, this endpoint must not be a way to spend
 * somebody else's money.
 */
describe("MAX_REFINE_CALLS_PER_HOUR", () => {
  /**
   * The upper end of the constant's own per-CALL estimate, which is the unit
   * the allowance counts: the ledger writes one row per PHYSICAL call. The
   * per-PRESS figure in the same docstring is twice this, because `maxRetries:
   * 0` allows a press two round trips — deriving the ceiling from that one
   * states a promise twice as expensive as the one the constant makes, which is
   * what this test used to do.
   */
  const MAX_COST_PER_REFINE_CALL_USD = 0.0025;

  /**
   * How much dearer than `gemini-3.7-flash` the priciest model the price table
   * knows is (`gemini-3.1-pro-preview`, $2/$12 against $0.75/$3.75). The
   * estimate above is the cheap model's, and the model is the ORG's choice, so
   * the promise has to hold at the top of the table too.
   */
  const PRICIEST_MODEL_MULTIPLE = 3;

  /**
   * What an unthrottled loop over this route could spend in an hour, taken
   * from `MAX_TEST_CALLS_PER_HOUR`'s own anchor: the api has no throttler, so
   * the hole is the same one, and a refine call is the more expensive of the
   * two (it carries a whole body).
   */
  const UNBOUNDED_HOURLY_SPEND_ESTIMATE_USD = 140;

  it("keeps worst-case hourly spend at least two orders of magnitude below an unbounded route", () => {
    const worstCaseHourlySpend = MAX_REFINE_CALLS_PER_HOUR * MAX_COST_PER_REFINE_CALL_USD;
    expect(worstCaseHourlySpend).toBeLessThan(UNBOUNDED_HOURLY_SPEND_ESTIMATE_USD / 100);
    // ...on the model the org actually chose, and not only on the cheap one the
    // number was picked against.
    expect(worstCaseHourlySpend * PRICIEST_MODEL_MULTIPLE).toBeLessThan(
      UNBOUNDED_HOURLY_SPEND_ESTIMATE_USD / 100,
    );
  });

  it("is a positive, finite number of calls — not disabled by 0, Infinity or a fraction", () => {
    expect(MAX_REFINE_CALLS_PER_HOUR).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_REFINE_CALLS_PER_HOUR)).toBe(true);
    expect(Number.isFinite(MAX_REFINE_CALLS_PER_HOUR)).toBe(true);
  });

  it("leaves room for a session of honest editing", () => {
    // The other direction, and the one a limit gets wrong far more often: a
    // person who reads each proposal before deciding cannot approach this.
    // Two calls per press is the worst case (`maxRetries: 0` plus the repair
    // retry), so this is the fewest presses the allowance can buy.
    const pressesInAnHour = MAX_REFINE_CALLS_PER_HOUR / 2;
    expect(pressesInAnHour).toBeGreaterThanOrEqual(30);
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
