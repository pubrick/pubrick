import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html.js";

describe("escapeHtml", () => {
  it("escapes the three characters Telegram requires", () => {
    expect(escapeHtml('a & b < c > d "q"')).toBe('a &amp; b &lt; c &gt; d "q"');
  });

  it("escapes ampersands before angle brackets so entities are not double-escaped", () => {
    expect(escapeHtml("<b>")).toBe("&lt;b&gt;");
  });
});
