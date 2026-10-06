/** Exact supported native formats; shared admission prevents silent attachment loss. */
export interface MetaContentMedia {
  cover?: {
    mimeType: string;
    width: number | null;
    height: number | null;
    byteSize: number;
  } | null;
  video?: boolean;
  inlineImages?: boolean;
}

export function metaContentProblem(
  platform: string,
  text: string,
  media: MetaContentMedia = {},
): string | null {
  if (!["threads", "instagram_native", "facebook_page"].includes(platform)) return null;
  if (media.video || media.inlineImages)
    return "Native Meta channels currently support no video or article images";
  if (platform !== "instagram_native") {
    if (media.cover) return "Threads and Facebook Pages currently support text only";
    const limit = platform === "threads" ? 500 : 63206;
    return !text.trim() || text.length > limit
      ? `This destination requires 1 to ${limit} characters`
      : null;
  }
  const image = media.cover;
  if (
    image?.mimeType !== "image/jpeg" ||
    !image.width ||
    !image.height ||
    image.byteSize > 8_000_000 ||
    image.byteSize <= 0 ||
    image.width < 320 ||
    image.width > 1440 ||
    image.width * 5 < image.height * 4 ||
    image.width * 100 > image.height * 191
  )
    return "Instagram requires one JPEG of at most 8 MB, width 320–1440 pixels, and aspect ratio 4:5–1.91:1";
  if (text.length > 2200 || text.split("#").length - 1 > 30 || text.split("@").length - 1 > 20)
    return "Instagram captions support at most 2200 characters, 30 # markers and 20 @ markers";
  return null;
}
