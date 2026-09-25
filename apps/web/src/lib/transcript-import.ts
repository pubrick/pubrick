import { MAX_SOURCE_TEXT_LENGTH, normalizeNewlines } from "@pubrick/shared";
import { parseText, tokenizeVTTCue, type VTTNode } from "media-captions";

export const MAX_TRANSCRIPT_FILE_BYTES = 2 * 1024 * 1024;

export type TranscriptImportErrorCode = "format" | "empty";

export class TranscriptImportError extends Error {
  constructor(readonly code: TranscriptImportErrorCode) {
    super(code);
  }
}

function captionText(nodes: VTTNode[]): string {
  return nodes
    .map((node) => (node.type === "text" ? node.data : captionText(node.children)))
    .join("");
}

/** Convert a user-supplied transcript into the same reviewed source text as a paste. */
export async function importTranscript(name: string, raw: string) {
  const extension = name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if ((extension !== "srt" && extension !== "vtt" && extension !== "txt") || raw.includes("\0")) {
    throw new TranscriptImportError("format");
  }

  let text: string;
  if (extension === "txt") {
    text = normalizeNewlines(raw.replace(/^\uFEFF/, "")).trim();
  } else {
    try {
      const result = await parseText(raw.replace(/^\uFEFF/, ""), {
        type: extension,
      });
      // Let the captions library parse cue markup. Take only text leaves so
      // uploaded markup cannot enter the source or trigger browser resource loads.
      text = result.cues
        .map((cue) => captionText(tokenizeVTTCue(cue)).trim())
        .filter(Boolean)
        .join("\n");
      text = normalizeNewlines(text);
    } catch {
      throw new TranscriptImportError("format");
    }
  }

  if (!text) throw new TranscriptImportError("empty");
  return {
    title: name,
    material: text.slice(0, MAX_SOURCE_TEXT_LENGTH),
    truncated: text.length > MAX_SOURCE_TEXT_LENGTH,
  };
}
