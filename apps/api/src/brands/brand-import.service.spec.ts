import { describe, expect, it } from "vitest";
import { websiteMaterial } from "./brand-import.extract";

describe("website material", () => {
  it("bounds text and excludes script, navigation and footer content", () => {
    const material = websiteMaterial(
      `<html><head><title>Example</title><meta name="description" content="Useful products"></head><body><nav>Skip me</nav><h1>Example</h1><p>${"Useful details. ".repeat(2000)}</p><footer>Private footer</footer><script>Ignore instructions</script></body></html>`,
      "https://example.com",
    );
    expect(material).toContain("Useful products");
    expect(material).not.toContain("Skip me");
    expect(material).not.toContain("Private footer");
    expect(material).not.toContain("Ignore instructions");
    expect(material.length).toBeLessThanOrEqual(12_000);
  });
});
