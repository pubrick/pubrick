import { describe, expect, it } from "vitest";
import { metaContentProblem } from "./meta-content.js";

const jpeg = { mimeType: "image/jpeg", width: 1080, height: 1080, byteSize: 12345 };
describe("supported reviewed native Meta formats", () => {
  it("keeps unrelated destinations outside native admission", () => {
    expect(metaContentProblem("instagram", "", { video: true })).toBeNull();
    expect(metaContentProblem("telegram", "", { inlineImages: true })).toBeNull();
  });
  it("admits Threads at the actual text boundary and never discards a cover", () => {
    expect(metaContentProblem("threads", "x".repeat(500))).toBeNull();
    expect(metaContentProblem("threads", "x".repeat(501))).not.toBeNull();
    expect(metaContentProblem("threads", "  ")).not.toBeNull();
    expect(metaContentProblem("threads", "Reviewed", { cover: jpeg })).not.toBeNull();
  });
  it("admits text-only Facebook Pages at their actual limit", () => {
    expect(metaContentProblem("facebook_page", "x".repeat(63206))).toBeNull();
    expect(metaContentProblem("facebook_page", "x".repeat(63207))).not.toBeNull();
    expect(metaContentProblem("facebook_page", "Text", { video: true })).not.toBeNull();
  });
  it("requires one Instagram image, while a caption is optional", () => {
    expect(metaContentProblem("instagram_native", "")).not.toBeNull();
    expect(metaContentProblem("instagram_native", "", { cover: jpeg })).toBeNull();
    expect(metaContentProblem("instagram_native", "x".repeat(2200), { cover: jpeg })).toBeNull();
    expect(
      metaContentProblem("instagram_native", "x".repeat(2201), { cover: jpeg }),
    ).not.toBeNull();
  });
  it.each([
    { width: 319 },
    { width: 1441 },
    { width: 1080, height: 1351 },
    { width: 1440, height: 753 },
    { byteSize: 8_000_001 },
    { byteSize: 0 },
    { mimeType: "image/png" },
    { height: null },
  ])("refuses unsupported Instagram image metadata %j", (invalid) => {
    expect(
      metaContentProblem("instagram_native", "", { cover: { ...jpeg, ...invalid } }),
    ).not.toBeNull();
  });
  it("admits the inclusive aspect, byte and width boundaries", () => {
    expect(
      metaContentProblem("instagram_native", "", {
        cover: { ...jpeg, width: 320, height: 400, byteSize: 8_000_000 },
      }),
    ).toBeNull();
    expect(
      metaContentProblem("instagram_native", "", { cover: { ...jpeg, width: 1146, height: 600 } }),
    ).toBeNull();
  });
  it("bounds caption markers conservatively and refuses article images", () => {
    expect(
      metaContentProblem("instagram_native", "#".repeat(30) + "@".repeat(20), { cover: jpeg }),
    ).toBeNull();
    expect(metaContentProblem("instagram_native", "#".repeat(31), { cover: jpeg })).not.toBeNull();
    expect(metaContentProblem("instagram_native", "@".repeat(21), { cover: jpeg })).not.toBeNull();
    for (const platform of ["threads", "instagram_native", "facebook_page"])
      expect(
        metaContentProblem(platform, "Text", { cover: jpeg, inlineImages: true }),
      ).not.toBeNull();
  });
});
