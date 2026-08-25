import { describe, expect, it } from "vitest";
import { orgSlug } from "./slug";

describe("orgSlug", () => {
  it("slugifies a latin name", () => {
    expect(orgSlug("Acme Corp")).toMatch(/^acme-corp-[a-z0-9]+$/);
  });

  it("strips diacritics rather than dropping the word", () => {
    expect(orgSlug("Cafetería Ñandú")).toMatch(/^cafeteria-nandu-[a-z0-9]+$/);
  });

  it("falls back to an org- prefix for non-latin names, never a bare hyphen", () => {
    for (const name of ["Домик", "日本語", "!!!", "   "]) {
      const slug = orgSlug(name);
      expect(slug).toMatch(/^org-[a-z0-9]+$/);
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
    }
  });

  it("produces a different slug on each call", () => {
    expect(orgSlug("Acme")).not.toBe(orgSlug("Acme"));
  });
});
