/** Telegram counts the visible caption separately from a reply's text. */
export const TELEGRAM_PHOTO_CAPTION_LENGTH = 1024;

/**
 * Split a reviewed plain-text post for Telegram's photo + one reply delivery.
 * Keep every character, including whitespace: the preview and the publisher
 * must show/send the same text. Intl.Segmenter is built into Node and browsers;
 * it avoids a dependency and keeps Unicode graphemes intact at the hard edge.
 */
export function telegramPhotoParts(text: string): { caption: string; followup: string | null } {
  if (text.length <= TELEGRAM_PHOTO_CAPTION_LENGTH) {
    return { caption: text, followup: null };
  }

  const minNaturalBoundary = TELEGRAM_PHOTO_CAPTION_LENGTH / 2;
  for (const granularity of ["sentence", "word", "grapheme"] as const) {
    let boundary = 0;
    for (const part of new Intl.Segmenter(undefined, { granularity }).segment(text)) {
      const end = part.index + part.segment.length;
      if (end > TELEGRAM_PHOTO_CAPTION_LENGTH) break;
      boundary = end;
    }
    if (boundary >= minNaturalBoundary || granularity === "grapheme") {
      return { caption: text.slice(0, boundary), followup: text.slice(boundary) };
    }
  }

  // The loop always returns from the grapheme pass, including boundary 0 for
  // a pathological first grapheme longer than Telegram's caption limit.
  return { caption: "", followup: text };
}
