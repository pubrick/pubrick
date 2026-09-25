import { describe, expect, it } from "vitest";
import { freezeRelatedNews } from "./related-news";

describe("freezeRelatedNews", () => {
  it("bounds UTF-8 context, drops unsafe URLs and never selects more than two", () => {
    const rows = [1, 2, 3].map((n) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      title: "報".repeat(300),
      summary: "é".repeat(800),
      url: n === 1 ? "javascript:alert(1)" : `https://example.com/${n}`,
    }));
    const selected = freezeRelatedNews(rows);
    expect(selected).toHaveLength(2);
    expect(selected[0]?.url).toBeNull();
    expect(selected[1]?.url).toBe("https://example.com/2");
    expect(
      selected.reduce((total, item) => total + Buffer.byteLength(item.title + item.summary), 0),
    ).toBeLessThanOrEqual(2048);
    const first = rows[0];
    if (!first) throw new Error("Missing story fixture");
    expect(
      freezeRelatedNews([{ ...first, url: "https://user:secret@example.com/story" }])[0]?.url,
    ).toBeNull();
  });
});
