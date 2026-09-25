import { BadRequestException } from "@nestjs/common";
import {
  MAX_SOURCE_TEXT_LENGTH,
  refusalBody,
  type SourceExtractionResponse,
} from "@pubrick/shared";
import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";

const MAX_YOUTUBE_RESPONSE_BYTES = 2 * 1024 * 1024;
const YOUTUBE_TIMEOUT_MS = 10_000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const id =
    host === "youtu.be"
      ? parts.length === 1
        ? parts[0]
        : null
      : url.pathname === "/watch"
        ? url.searchParams.get("v")
        : parts.length === 2 && ["shorts", "live", "embed"].includes(parts[0] ?? "")
          ? parts[1]
          : null;
  return id && VIDEO_ID.test(id) ? id : null;
}

export function isYoutubeUrl(url: URL): boolean {
  return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(
    url.hostname.toLowerCase(),
  );
}

/** The transcript library sees only a video ID and this bounded YouTube-only transport. */
export async function youtubeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(String(input));
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "www.youtube.com" && url.hostname !== "youtube.com") ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Unexpected transcript transport destination");
  }
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(YOUTUBE_TIMEOUT_MS),
  });
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_YOUTUBE_RESPONSE_BYTES) throw new Error("Transcript response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new Response(new Blob(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: { "content-type": response.headers.get("content-type") ?? "text/plain" },
  });
}

export async function extractYoutubeTranscript(
  videoId: string,
  load: typeof fetchTranscript = fetchTranscript,
): Promise<SourceExtractionResponse> {
  try {
    const cues = await load(videoId, { fetch: youtubeFetch });
    const text = cues
      .map((cue) => cue.text.replaceAll("\u0000", "").trim())
      .filter(Boolean)
      .join("\n");
    if (!text) throw new YoutubeTranscriptNotAvailableError(videoId);
    let material = text.slice(0, MAX_SOURCE_TEXT_LENGTH);
    const last = material.charCodeAt(material.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) material = material.slice(0, -1);
    return { title: "", material, truncated: text.length > material.length, kind: "video" };
  } catch (error) {
    const unavailable =
      error instanceof YoutubeTranscriptDisabledError ||
      error instanceof YoutubeTranscriptNotAvailableError ||
      error instanceof YoutubeTranscriptVideoUnavailableError;
    throw new BadRequestException(
      refusalBody(
        400,
        unavailable ? "source_transcript_unavailable" : "source_fetch_failed",
        unavailable
          ? "No public transcript is available for this video"
          : "The video transcript could not be fetched",
      ),
    );
  }
}
