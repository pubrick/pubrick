/** A cached connection check is evidence only for this short window. */
export const CHANNEL_HEALTH_TTL_MS = 6 * 60 * 60 * 1000;

export type ChannelHealthState = "ok" | "failed" | "unknown";

export function channelHealthState(
  ok: boolean | null,
  checkedAt: Date | null,
  now: number = Date.now(),
): ChannelHealthState {
  if (ok === null || checkedAt === null) return "unknown";
  const age = now - checkedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age >= CHANNEL_HEALTH_TTL_MS) return "unknown";
  return ok ? "ok" : "failed";
}
