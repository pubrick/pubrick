import { describe, expect, it } from "vitest";
import { safeRichHtmlBlocks } from "../content/rich-html";

describe("public rich HTML", () => {
  it("renders only allowed HTML and escapes document text", () => {
    const rich = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "A <script>alert(1)</script>" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Read",
              marks: [{ type: "link", attrs: { href: "https://example.com/a?x=1&y=2" } }],
            },
          ],
        },
      ],
    };
    const html = safeRichHtmlBlocks(
      rich,
      "A <script>alert(1)</script>\n\nRead (https://example.com/a?x=1&y=2)",
    );
    expect(html?.[0]).toContain("<h2>A &lt;script&gt;alert(1)&lt;/script&gt;</h2>");
    expect(html?.[1]).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(html?.join(" ")).not.toContain("<script>");
  });

  it("falls back on invalid or stale stored JSON", () => {
    expect(safeRichHtmlBlocks({ type: "doc", content: [{ type: "image" }] }, "text")).toBeNull();
    expect(
      safeRichHtmlBlocks(
        {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "wrong" }] }],
        },
        "text",
      ),
    ).toBeNull();
  });
});
