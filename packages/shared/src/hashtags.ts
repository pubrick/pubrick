/**
 * Channel tags are editorial fields, but the channel body is the exact text
 * sent to the platform. Keep one deterministic composition rule for both.
 */
export function normalizeHashtags(input: readonly string[]): string[] {
  const tags = input
    .map((value) => value.trim().replace(/^#+/, "").trim().replace(/\s+/gu, "_"))
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
  const trimmed = body.trimEnd();
  if (trimmed === suffix) return "";
  const split = trimmed.lastIndexOf("\n\n");
  if (split < 0) return body;
  const lastBlock = trimmed.slice(split + 2);
  const previous = new Set(suffix.split(" "));
  const tokens = lastBlock.split(" ");
  if (tokens.length === 0 || !tokens.every((token) => previous.has(token))) return body;
  return trimmed.slice(0, split);
}

export function withHashtags(body: string, tags: readonly string[]): string {
  const suffix = hashtagSuffix(tags);
  if (!suffix || !body.trim()) return body;
  const trimmed = body.trimEnd();
  if (trimmed === suffix || trimmed.endsWith(`\n\n${suffix}`)) return body;
  const trailingBlock = trimmed.match(/(?:^|\n\n)(#[^\s#]+(?: #[^\s#]+)*)$/u);
  if (trailingBlock) {
    const existing = trailingBlock[1]?.split(" ") ?? [];
    const desired = suffix.split(" ");
    if (existing.every((tag) => desired.includes(tag))) {
      return `${trimmed.slice(0, -existing.join(" ").length)}${suffix}`;
    }
  }
  return `${trimmed}\n\n${suffix}`;
}

export function replaceHashtags(
  body: string,
  previousTags: readonly string[],
  nextTags: readonly string[],
): string {
  return withHashtags(stripHashtagSuffix(body, previousTags), nextTags);
}
