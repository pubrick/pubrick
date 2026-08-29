import { describe, expect, it } from "vitest";
import {
  adaptationUpdateSchema,
  contentCreateSchema,
  contentUpdateSchema,
  MAX_BODY_LENGTH,
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
