/** A public channel post URL. Private /c links must never reach MTProto comment reads. */
export function isPublicTelegramPostUrl(
  url: string | null,
  externalId: string | null,
): url is string {
  if (!url || !externalId) return false;
  const match = /^https:\/\/t\.me\/([A-Za-z0-9_]{5,32})\/([1-9]\d*)$/.exec(url);
  return match !== null && Number.isSafeInteger(Number(match[2])) && match[2] === externalId;
}
