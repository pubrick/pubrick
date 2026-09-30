import { BadRequestException } from "@nestjs/common";
import { MAX_SOURCE_TEXT_LENGTH } from "@pubrick/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractYoutubeTranscript, youtubeFetch, youtubeVideoId } from "./youtube-transcript";

afterEach(() => vi.unstubAllGlobals());

describe("YouTube transcript import", () => {
  it("accepts only a video ID from known YouTube URL shapes", () => {
    for (const url of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12",
      "https://m.youtube.com/shorts/dQw4w9WgXcQ",
      "https://youtube.com/live/dQw4w9WgXcQ",
    ]) {
      expect(youtubeVideoId(new URL(url))).toBe("dQw4w9WgXcQ");
    }
    for (const url of [
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/@creator",
      "https://youtu.be/dQw4w9WgXcQ/other",
      "https://www.youtube.com/watch?v=invalid",
    ]) {
      expect(youtubeVideoId(new URL(url))).toBeNull();
    }
  });

  it("returns real cue text, bounded to the generation limit", async () => {
    const load = vi.fn(async () => [
      { text: "First caption", duration: 1, offset: 0 },
      { text: "Second caption. ".repeat(1000), duration: 1, offset: 1 },
    ]);
    const result = await extractYoutubeTranscript("dQw4w9WgXcQ", load);
    expect(result.kind).toBe("video");
    expect(result.material).toContain("First caption\nSecond caption.");
    expect(result.material.length).toBeLessThanOrEqual(MAX_SOURCE_TEXT_LENGTH);
    expect(result.truncated).toBe(true);
    expect(load).toHaveBeenCalledWith("dQw4w9WgXcQ", { fetch: youtubeFetch });
  });

  it("does not claim a transcript when the provider returns no cues", async () => {
    const error = await extractYoutubeTranscript("dQw4w9WgXcQ", async () => []).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: "source_transcript_unavailable",
    });
  });

  it("never follows a caption track off YouTube", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(youtubeFetch("https://youtube.com.evil.test/api/timedtext")).rejects.toThrow();
    await expect(youtubeFetch("http://www.youtube.com/api/timedtext")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves streamed caption bytes from a shared backing buffer", async () => {
    const bytes = new TextEncoder().encode("<text>Shared caption ✓</text>");
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.length + 4));
    shared.set(bytes, 2);
    const chunk = shared.subarray(2, bytes.length + 2);
    // BlobPart excludes SharedArrayBuffer-backed views. Guard the constructor
    // rather than allowing native Node Blob to abort on this invalid input.
    const NativeBlob = Blob;
    vi.stubGlobal(
      "Blob",
      class extends NativeBlob {
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
          if (
            parts.some(
              (part) => ArrayBuffer.isView(part) && part.buffer instanceof SharedArrayBuffer,
            )
          )
            throw new TypeError("Shared buffers are not BlobPart values");
          super(parts, options);
        }
      },
    );
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status: 206, headers: { "content-type": "text/xml" } },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const bounded = await youtubeFetch("https://www.youtube.com/api/timedtext");
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get("content-type")).toBe("text/xml");
    expect(await bounded.text()).toBe(new TextDecoder().decode(bytes));
  });

  it("bounds each YouTube response before the transcript library parses it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))),
    );
    await expect(youtubeFetch("https://www.youtube.com/api/timedtext")).rejects.toThrow(
      "Transcript response too large",
    );
  });
});
