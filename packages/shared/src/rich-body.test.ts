import { describe, expect, it } from "vitest";
import { contentUpdateSchema } from "./dto/content.js";
import { projectRichBody, richBodySchema } from "./rich-body.js";

const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Café ☕" }] },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Visit",
          marks: [{ type: "link", attrs: { href: "https://example.com/a" } }],
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }],
        },
      ],
    },
  ],
} as const;

describe("rich master projection", () => {
  it("projects UTF-16 offsets and link destinations deterministically", () => {
    const parsed = richBodySchema.parse(doc);
    const body = projectRichBody(parsed);
    expect(body).toBe("Café ☕\n\nVisit (https://example.com/a)\n\n- One");
    expect(body.indexOf("Visit")).toBe(8);
    expect(
      contentUpdateSchema.safeParse({
        body,
        richBody: parsed,
        expectedBody: "Old",
        expectedBodyRevision: 0,
      }).success,
    ).toBe(true);
    expect(
      contentUpdateSchema.safeParse({
        body: `${body}!`,
        richBody: parsed,
        expectedBody: "Old",
        expectedBodyRevision: 0,
      }).success,
    ).toBe(false);
  });

  it("refuses raw HTML, image nodes, dangerous links and oversized content", () => {
    const dangerous = structuredClone(doc) as unknown as { content: unknown[] };
    dangerous.content.push({ type: "rawHTML", html: "<script>alert(1)</script>" });
    expect(richBodySchema.safeParse(dangerous).success).toBe(false);
    dangerous.content.pop();
    dangerous.content.push({ type: "image", attrs: { src: "https://bad.example/track" } });
    expect(richBodySchema.safeParse(dangerous).success).toBe(false);
    const badLink = structuredClone(doc) as unknown as {
      content: { content?: { marks?: { attrs?: { href: string } }[] }[] }[];
    };
    if (badLink.content[1]?.content?.[0]?.marks?.[0]?.attrs)
      badLink.content[1].content[0].marks[0].attrs.href = "javascript:alert(1)";
    expect(richBodySchema.safeParse(badLink).success).toBe(false);
    expect(
      richBodySchema.safeParse({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(4097) }] }],
      }).success,
    ).toBe(false);
  });

  it("groups adjacent marked link segments and strips TipTap display attributes", () => {
    const parsed = richBodySchema.parse({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Read ",
                      marks: [
                        {
                          type: "link",
                          attrs: {
                            href: "https://example.com",
                            target: "_blank",
                            rel: "nofollow",
                            class: null,
                          },
                        },
                      ],
                    },
                    {
                      type: "text",
                      text: "more",
                      marks: [
                        { type: "bold" },
                        { type: "link", attrs: { href: "https://example.com" } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(projectRichBody(parsed)).toBe("3. Read more (https://example.com)");
    expect(JSON.stringify(parsed)).not.toContain("_blank");
    expect(JSON.stringify(parsed)).not.toContain("nofollow");
    const tracked = richBodySchema.parse({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Open",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com/a?utm_source=feed&id=4&fbclid=abc",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(projectRichBody(tracked)).toBe("Open (https://example.com/a?id=4)");
  });
});
