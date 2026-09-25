/**
 * Channel tags are editorial fields, but the channel body is the exact text
 * sent to the platform. Keep one deterministic composition rule for both.
 */
export function normalizeHashtags(input: readonly string[]): string[] {
  const tags = input
    .map((value) =>
      value
        .trim()
        .replace(/^#+/, "")
        .replace(/[^\p{L}\p{M}\p{N}_]+/gu, "_")
        .replace(/^_+|_+$/gu, ""),
    )
    .filter(Boolean);
  return [...new Set(tags)];
}

export function hashtagSuffix(tags: readonly string[]): string {
  return normalizeHashtags(tags)
    .map((tag) => `#${tag}`)
    .join(" ");
}

export function stripHashtagSuffix(body: string, tags: readonly string[]): string {
  const suffix = hashtagSuffix(tags);
  if (!suffix) return body;
  if (body === suffix) return "";
  return body.endsWith(`\n\n${suffix}`) ? body.slice(0, -(suffix.length + 2)) : body;
}

/** `body` is editor/model-authored text, never an already composed body. */
export function withHashtags(body: string, tags: readonly string[]): string {
  const suffix = hashtagSuffix(tags);
  if (!suffix || !body.trim()) return body;
  return `${body.trimEnd()}\n\n${suffix}`;
}

export function replaceHashtags(
  body: string,
  previousTags: readonly string[],
  nextTags: readonly string[],
): string {
  return withHashtags(stripHashtagSuffix(body, previousTags), nextTags);
}
