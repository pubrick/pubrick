import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiImageCaller, imageCostUsd } from "./gemini-image.caller";

afterEach(() => vi.unstubAllGlobals());

describe("Gemini image wire call", () => {
  it("sends a source image for an edit and returns only the final image", async () => {
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      expect(body.contents[0].parts).toEqual([
        { text: "Change the background" },
        { inlineData: { mimeType: "image/jpeg", data: Buffer.from("source").toString("base64") } },
      ]);
      expect(options.headers).toMatchObject({ "x-goog-api-key": "private-key" });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    thought: true,
                    inlineData: {
                      mimeType: "image/png",
                      data: Buffer.from("interim").toString("base64"),
                    },
                  },
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: Buffer.from("image").toString("base64"),
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new GeminiImageCaller().call(
      "private-key",
      "Change the background",
      Buffer.from("source"),
    );
    expect(result).toMatchObject({
      bytes: Buffer.from("image"),
      mimeType: "image/png",
      outcome: "completed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies an interrupted request as potentially billed without echoing provider text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private-key leaked by provider");
      }),
    );
    const result = await new GeminiImageCaller().call("private-key", "A landscape");
    expect(result.outcome).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("private-key");
  });

  it("prices only responses with image modality counts", () => {
    expect(
      imageCostUsd({
        promptTokenCount: 100,
        thoughtsTokenCount: 10,
        candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
      }),
    ).toBeCloseTo(0.06728);
    expect(imageCostUsd({ promptTokenCount: 100, candidatesTokenCount: 1120 })).toBeNull();
  });
});
