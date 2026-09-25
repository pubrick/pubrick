/** A frozen feed excerpt, not an independently verified source. */
export type RelatedNewsSnapshot = {
  id: string;
  title: string;
  summary: string;
  url: string | null;
};

function takeUtf8(value: string, bytes: number): string {
  let result = "";
  let length = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, "utf8");
    if (length + size > bytes) break;
    result += point;
    length += size;
  }
  return result;
}

function publicUrl(value: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** At most two stories and 2 KiB of untrusted title/summary text across them. */
export function freezeRelatedNews(
  rows: readonly { id: string; title: string; summary: string; url: string }[],
): RelatedNewsSnapshot[] {
  let remaining = 2048;
  const snapshots: RelatedNewsSnapshot[] = [];
  for (const row of rows.slice(0, 2)) {
    const title = takeUtf8(row.title.trim(), Math.min(320, remaining));
    remaining -= Buffer.byteLength(title, "utf8");
    const summary = takeUtf8(row.summary.trim(), Math.min(700, remaining));
    remaining -= Buffer.byteLength(summary, "utf8");
    if (title) snapshots.push({ id: row.id, title, summary, url: publicUrl(row.url) });
  }
  return snapshots;
}
