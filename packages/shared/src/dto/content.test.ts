import { describe, expect, it } from "vitest";
import {
  ADAPTATION_STATUSES,
  adaptationUpdateSchema,
  CONTENT_PAGE_SIZE,
  CONTENT_STATUSES,
  contentCreateSchema,
  contentUpdateSchema,
  DELIVERY_OUTCOMES,
  decodeContentCursor,
  encodeContentCursor,
  isDeliveryOutcome,
  isOutstandingAdaptation,
  MAX_BODY_LENGTH,
  MAX_CONTENT_PAGE_SIZE,
  MAX_REFINE_CALLS_PER_HOUR,
  nextItemStatus,
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
    expect(CONTENT_STATUSES).toEqual([
      "draft",
      "approved",
      "partially_published",
      "rejected",
      "published",
      "failed",
      "archived",
    ]);
  });

  it("adaptation status", () => {
    expect(ADAPTATION_STATUSES).toEqual([
      "pending",
      "manual_ready",
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
 * THE OTHER CHARACTER A BODY CANNOT CARRY, and unlike a CR it cannot be
 * normalised away.
 *
 * Postgres stores no U+0000 in `text` or `jsonb`: the insert throws `22021`
 * AFTER every schema in this file has said yes, so the caller's reward for a
 * pasted NUL was a 500 on a request that was merely unstorable. It is refused
 * at the DTO for `normalizeNewlines`' own reason — this is the boundary every
 * writer crosses — and refused rather than stripped, because dropping a
 * character silently edits what somebody wrote.
 *
 * Field-qualified, like every other refinement here: the api answers
 * `invalid_request`, and the path is what tells a developer which member.
 */
describe("a body that cannot be stored at all", () => {
  const NUL = "\u0000";

  it("refuses a NUL in a created body, naming the field", () => {
    const denied = contentCreateSchema.safeParse({
      brandId: BRAND,
      body: `Ship it.${NUL}`,
      channelIds: [CHANNEL],
    });
    expect(denied.success).toBe(false);
    expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["body"]]);
  });

  it("refuses a NUL in a created title", () => {
    const denied = contentCreateSchema.safeParse({
      brandId: BRAND,
      title: `Launch${NUL}`,
      body: "Ship it.",
      channelIds: [CHANNEL],
    });
    expect(denied.success).toBe(false);
    expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["title"]]);
  });

  it("refuses a NUL on the PATCH path, which is where it was found", () => {
    expect(contentUpdateSchema.safeParse({ body: `Edited.${NUL}` }).success).toBe(false);
    expect(contentUpdateSchema.safeParse({ title: `Edited${NUL}` }).success).toBe(false);
  });

  it("refuses a NUL in a channel override, which is stored in the same column shape", () => {
    expect(adaptationUpdateSchema.safeParse({ body: `A channel take.${NUL}` }).success).toBe(false);
  });

  /**
   * The refusal is about U+0000 and nothing else. A schema that refused every
   * control character would refuse a tab — which a person can type into a
   * textarea and which Postgres stores without complaint — and the two tests
   * above would not notice.
   */
  it("still admits the control characters a column can hold", () => {
    const body = "Tabbed.\tAnd newlined.\n";
    expect(contentCreateSchema.parse({ brandId: BRAND, body, channelIds: [CHANNEL] }).body).toBe(
      body,
    );
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

  it("answers for every adaptation status, including manual work with no job", () => {
    expect(ADAPTATION_STATUSES.filter((s) => !isOutstandingAdaptation(s))).toEqual([
      "pending",
      "manual_ready",
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

/**
 * THE PROMOTION RULE, asked of the fold itself.
 *
 * The rule has two callers in two processes — the worker when a delivery lands,
 * the api when a person settles an unknown one by hand — and before this fold
 * existed it was one `if/else` inside the worker that nobody else could reach.
 * A copy in the api would be a second answer free to drift, and the screen that
 * would show the drift is the same screen: an item stuck at `approved` beside
 * live posts refuses to be edited and still accepts a reject.
 *
 * ONE TEST PER ARM, and one for each arm's own negation, because a fold whose
 * arms are only tested through their happy case is satisfied by deleting the
 * one that is never contradicted.
 */
describe("what an item's status becomes when its deliveries have moved", () => {
  it("promotes to published only when every delivery published", () => {
    expect(nextItemStatus(["published"])).toBe("published");
    expect(nextItemStatus(["published", "published"])).toBe("published");
    // Not `undefined` any more, and not `published` either — the third arm
    // below owns this shape.
    expect(nextItemStatus(["published", "failed"])).toBe("partially_published");
    expect(nextItemStatus(["published", "queued"])).toBeUndefined();
    expect(nextItemStatus(["published", "manual_ready"])).toBeUndefined();
  });

  it("fails the item only when every delivery failed", () => {
    expect(nextItemStatus(["failed"])).toBe("failed");
    expect(nextItemStatus(["failed", "failed"])).toBe("failed");
    expect(nextItemStatus(["failed", "queued"])).toBeUndefined();
  });

  /**
   * THE THIRD ARM: every delivery is over and they did not agree.
   *
   * The arm exists because its absence had an answer too, and that answer was
   * a lie — `undefined` left the item at `approved`, the colour of work in
   * flight, for ever, beside a channel that is live and a channel that never
   * will be. Terminal, NOT final: a later delivery recomputes the item, so a
   * retry of the failed half promotes it to `published` through the first arm
   * with nothing here to undo.
   */
  it("says a post is partly out when its deliveries are over and disagree", () => {
    expect(nextItemStatus(["published", "failed"])).toBe("partially_published");
    expect(nextItemStatus(["failed", "published"])).toBe("partially_published");
    expect(nextItemStatus(["published", "failed", "failed"])).toBe("partially_published");
    expect(nextItemStatus(["published", "published", "failed"])).toBe("partially_published");
    // Its own negations, one per clause: not terminal, all published, all
    // failed. A third arm tested only through its happy case is satisfied by
    // an arm that answers `partially_published` for everything the two above
    // did not claim first — including a fan-out still in flight.
    expect(nextItemStatus(["published", "queued"])).toBeUndefined();
    expect(nextItemStatus(["failed", "publishing"])).toBeUndefined();
    expect(nextItemStatus(["published", "published"])).toBe("published");
    expect(nextItemStatus(["failed", "failed"])).toBe("failed");
  });

  /**
   * Nothing has been decided while a delivery is still moving, and that is the
   * whole of what `undefined` means: the caller leaves the item where it is.
   */
  it("decides nothing while any delivery is still outstanding", () => {
    for (const status of ADAPTATION_STATUSES) {
      if (status === "published" || status === "failed") continue;
      expect(nextItemStatus([status])).toBeUndefined();
      expect(nextItemStatus([status, "published"])).toBeUndefined();
      expect(nextItemStatus([status, "failed"])).toBeUndefined();
    }
  });

  /**
   * THE EMPTY SET, which both `every` arms answer `true` for.
   *
   * An item whose channels have all been deleted has no adaptation left to
   * speak for it. Without the guard the first arm wins and the item is promoted
   * to `published` — a permanent claim that posts went out, made about an item
   * that has nowhere to have sent them.
   */
  it("decides nothing for an item with no deliveries at all", () => {
    expect(nextItemStatus([])).toBeUndefined();
  });
});

/**
 * THE QUEUE'S CURSOR — the one thing on `GET /api/content` a caller may not
 * read, and must hand back byte for byte.
 *
 * It is opaque because the ordering it encodes is the api's to change: today
 * `(created_at, id)` newest first, tomorrow whatever a reorderable queue
 * (`docs/ux-patterns.md` §1.2) needs. A caller that parsed it would pin that
 * choice from outside. Opacity is only a promise, though, and this file's job
 * is the half that is enforceable: what goes in comes back out, and what did
 * NOT come out of `encode` is refused rather than half-read.
 *
 * `null` for every refusal, never a throw and never a partial cursor: the
 * caller is the api's route handler, which turns it into one 400 with a code.
 */
describe("the queue page cursor", () => {
  const AT = "2026-09-11T19:09:52.123456Z";
  const ID = "33333333-3333-4333-8333-333333333333";

  it("round-trips the sort key it was built from, microseconds included", () => {
    const decoded = decodeContentCursor(encodeContentCursor({ createdAt: AT, id: ID }));
    expect(decoded).toEqual({ createdAt: AT, id: ID });
  });

  /**
   * MICROSECONDS, AND THIS IS THE ASSERTION THE WHOLE FORMAT EXISTS FOR.
   *
   * `created_at` is `timestamptz`, which Postgres keeps to the microsecond;
   * a JS `Date` holds milliseconds. A cursor carrying the driver's `Date`
   * would therefore name an instant slightly EARLIER than the row it came
   * from, and `(created_at, id) < cursor` would not exclude that row — the
   * last card of one page reappears as the first card of the next, silently,
   * on exactly the boundary nobody looks at. So the api renders the key in
   * SQL (`to_char(... 'US')`) and this format carries all six digits.
   */
  it("keeps a microsecond that a JS Date would round away", () => {
    const encoded = encodeContentCursor({ createdAt: AT, id: ID });
    expect(new Date(AT).toISOString()).toBe("2026-09-11T19:09:52.123Z");
    expect(decodeContentCursor(encoded)?.createdAt).toBe(AT);
  });

  it("is base64url: no padding, and nothing needing escaping in a query string", () => {
    const encoded = encodeContentCursor({ createdAt: AT, id: ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it.each([
    ["empty", ""],
    ["not base64url at all", "not a cursor!"],
    ["base64url of nothing that parses", "YWJj"],
    ["a timestamp with no id", "MjAyNi0wOS0xMVQxOTowOTo1Mi4xMjM0NTZa"],
    [
      "a plausible timestamp that is not the canonical form",
      "MjAyNnwzMzMzMzMzMy0zMzMzLTQzMzMtODMzMy0zMzMzMzMzMzMzMzM",
    ],
    ["an id that is not a uuid", "MjAyNi0wOS0xMVQxOTowOTo1Mi4xMjM0NTZafG5vdC1hLXV1aWQ"],
  ])("refuses %s", (_label, raw) => {
    expect(decodeContentCursor(raw)).toBeNull();
  });

  /**
   * The page bounds, pinned as values rather than as "whatever the constant
   * says": 50 is the owner's decision (design 0009 §6, answered 2026-09-11)
   * and 200 is the ceiling the api refuses above. Both are read by the api's
   * validation and by the web's own request, so a silent change to either
   * would move what the product does without moving a line anybody reviews.
   */
  it("bounds a page at 50 by default and 200 at most", () => {
    expect(CONTENT_PAGE_SIZE).toBe(50);
    expect(MAX_CONTENT_PAGE_SIZE).toBe(200);
  });
});
