/** Telegram's plain-text limits count UTF-16 code units, as JavaScript does. */
export const TELEGRAM_PHOTO_CAPTION_LENGTH = 1024;
export const TELEGRAM_MESSAGE_LENGTH = 4096;
export const TELEGRAM_LONG_POST_LENGTH = 12_000;

export interface TelegramPostParts {
  primaryKind: "photo" | "message";
  primaryText: string;
  replies: string[];
}

function assertPairedSurrogates(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RangeError("Telegram text contains an unpaired surrogate");
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RangeError("Telegram text contains an unpaired surrogate");
    }
  }
}

function boundary(text: string, limit: number, minRequired: number): number {
  const minimum = Math.max(Math.ceil(limit / 2), minRequired);
  for (const granularity of ["sentence", "word", "grapheme"] as const) {
    let last = 0;
    for (const part of new Intl.Segmenter(undefined, { granularity }).segment(text)) {
      const end = part.index + part.segment.length;
      if (end > limit) break;
      last = end;
    }
    if (last >= minimum || granularity === "grapheme") return last;
  }
  return 0;
}

/**
 * Preflight the entire reviewed post before a platform request. Parts rejoin
 * exactly in JS's UTF-16 representation; no trim, markup, or overlap is
 * permitted. The minimum boundary reserves enough room for later requests.
 */
export function telegramPostParts(text: string, covered: boolean): TelegramPostParts {
  if (text.length < 1 || text.length > TELEGRAM_LONG_POST_LENGTH) {
    throw new RangeError(`Telegram text must be 1..${TELEGRAM_LONG_POST_LENGTH} characters`);
  }
  assertPairedSurrogates(text);
  const limits = covered
    ? [
        TELEGRAM_PHOTO_CAPTION_LENGTH,
        TELEGRAM_MESSAGE_LENGTH,
        TELEGRAM_MESSAGE_LENGTH,
        TELEGRAM_MESSAGE_LENGTH,
      ]
    : [TELEGRAM_MESSAGE_LENGTH, TELEGRAM_MESSAGE_LENGTH, TELEGRAM_MESSAGE_LENGTH];
  const parts: string[] = [];
  let remaining = text;
  for (let index = 0; remaining.length > 0 && index < limits.length; index++) {
    const limit = limits[index];
    if (limit === undefined) break;
    if (remaining.length <= limit) {
      // Even a final part shorter than its limit may contain an oversized
      // grapheme, which Telegram cannot receive intact.
      if (boundary(remaining, limit, 0) !== remaining.length) break;
      parts.push(remaining);
      remaining = "";
      break;
    }
    const futureCapacity = limits.slice(index + 1).reduce((sum, value) => sum + value, 0);
    const cut = boundary(remaining, limit, remaining.length - futureCapacity);
    if (cut <= 0) break;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining || parts.length === 0 || parts.join("") !== text) {
    throw new RangeError("Telegram text cannot be split without cutting a grapheme");
  }
  const primaryText = parts[0];
  if (primaryText === undefined) throw new RangeError("Telegram text has no primary part");
  return {
    primaryKind: covered ? "photo" : "message",
    primaryText,
    replies: parts.slice(1),
  };
}

/**
 * Legacy preview shape for the 4096-character editor. Keep it tolerant of
 * incomplete text being typed; publishing uses telegramPostParts' strict
 * preflight. Longer previews should call telegramPostParts directly.
 */
export function telegramPhotoParts(text: string): { caption: string; followup: string | null } {
  if (text.length <= TELEGRAM_PHOTO_CAPTION_LENGTH) return { caption: text, followup: null };
  const cut = boundary(text, TELEGRAM_PHOTO_CAPTION_LENGTH, 0);
  return { caption: text.slice(0, cut), followup: text.slice(cut) };
}
