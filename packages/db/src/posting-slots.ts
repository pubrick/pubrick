import {
  MIN_RESCHEDULE_LEAD_MS,
  POSTING_QUEUE_HORIZON_DAYS,
  type PostingSlot,
} from "@pubrick/shared";
import { DateTime, IANAZone } from "luxon";

export function validPostingTimezone(timezone: string): boolean {
  return timezone === "UTC" || (!/^[+-]/.test(timezone) && IANAZone.isValidZone(timezone));
}

/** Existing Luxon calendar semantics: skip gaps and use the earlier repeated instant. */
export function nextPostingSlot(
  timezone: string,
  slots: readonly PostingSlot[],
  now: Date,
  occupied: ReadonlySet<number>,
): Date | null {
  if (!validPostingTimezone(timezone)) throw new RangeError("Use an IANA time zone");
  const clock = DateTime.fromJSDate(now, { zone: timezone });
  if (!clock.isValid) throw new RangeError("Use a valid clock");
  // UTC retains date labels even when a whole local date does not exist.
  let day = DateTime.fromISO(clock.toISODate() as string, { zone: "UTC" });
  const candidates: number[] = [];
  for (let index = 0; index < POSTING_QUEUE_HORIZON_DAYS; index++, day = day.plus({ days: 1 })) {
    for (const slot of slots) {
      if (slot.weekday !== day.weekday) continue;
      const [hour, minute] = slot.localTime.split(":").map(Number);
      const local = DateTime.fromObject(
        { year: day.year, month: day.month, day: day.day, hour, minute },
        { zone: timezone },
      );
      if (
        !local.isValid ||
        local.toISODate() !== day.toISODate() ||
        local.hour !== hour ||
        local.minute !== minute
      )
        continue;
      const instant = Math.min(...local.getPossibleOffsets().map((value) => value.toMillis()));
      if (instant > now.getTime() + MIN_RESCHEDULE_LEAD_MS && !occupied.has(instant))
        candidates.push(instant);
    }
    if (candidates.length) return new Date(Math.min(...candidates));
  }
  return null;
}
