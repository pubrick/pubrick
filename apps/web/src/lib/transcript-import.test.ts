import { MAX_SOURCE_TEXT_LENGTH } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { importTranscript, TranscriptImportError } from "./transcript-import";

describe("importTranscript", () => {
  it("extracts spoken text from SRT without cue numbers, timestamps, or markup", async () => {
    const result = await importTranscript(
      "talk.srt",
      "\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>Hello &amp; welcome.</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nNext point.\r\n",
    );
    expect(result).toEqual({
      title: "talk.srt",
      material: "Hello & welcome.\nNext point.",
      truncated: false,
    });
  });

  it("extracts VTT cues without header metadata or NOTE blocks", async () => {
    const result = await importTranscript(
      "talk.vtt",
      "WEBVTT\n\nNOTE private production note\nDo not publish\n\n00:00:01.000 --> 00:00:02.000\nFirst idea.\n\n00:00:03.000 --> 00:00:04.000\nSecond idea.",
    );
    expect(result.material).toBe("First idea.\nSecond idea.");
  });

  it("keeps plain text paragraphs, then caps the reviewed material at the source limit", async () => {
    expect((await importTranscript("notes.TXT", "\uFEFFFirst.\r\n\r\nSecond.\r")).material).toBe(
      "First.\n\nSecond.",
    );
    const result = await importTranscript("long.txt", "x".repeat(MAX_SOURCE_TEXT_LENGTH + 9));
    expect(result.material).toHaveLength(MAX_SOURCE_TEXT_LENGTH);
    expect(result.truncated).toBe(true);
  });

  it.each([
    ["transcript.pdf", "Something", "format"],
    ["transcript.srt", "not a subtitle file", "empty"],
    ["transcript.vtt", "WEBVTT\n\nNOTE only metadata", "empty"],
    ["transcript.txt", "   \r\n", "empty"],
    ["transcript.txt", "text\0binary", "format"],
  ] as const)("refuses %s without usable text", async (name, content, code) => {
    await expect(importTranscript(name, content)).rejects.toEqual(new TranscriptImportError(code));
  });
});
