import {
  EDITORIAL_PLAN_HORIZON_DAYS,
  EDITORIAL_PLAN_MAX_RANGE_DAYS,
  type EditorialPlanPreviewResult,
  editorialPlanScheduleSchema,
} from "@pubrick/shared";
import { DateTime, IANAZone } from "luxon";

/** Validates semantic calendar constraints in the same path used by preview and planning. */
export function validateEditorialPlanSchedule(input: unknown) {
  const schedule = editorialPlanScheduleSchema.parse(input);
  if (
    schedule.timezone !== "UTC" &&
    (/^[+-]/.test(schedule.timezone) || !IANAZone.isValidZone(schedule.timezone))
  ) {
    throw new RangeError("Use an IANA time zone");
  }
  const start = DateTime.fromISO(schedule.startDate, { zone: "UTC" });
  const end = DateTime.fromISO(schedule.endDate, { zone: "UTC" });
  if (
    !start.isValid ||
    !end.isValid ||
    start.toISODate() !== schedule.startDate ||
    end.toISODate() !== schedule.endDate
  ) {
    throw new RangeError("Use real ISO calendar dates");
  }
  if (end.diff(start, "days").days > EDITORIAL_PLAN_MAX_RANGE_DAYS) {
    throw new RangeError("End date must be at most 366 days after start date");
  }
  return schedule;
}

/** New/replanned identities only. Persistence preserves existing planned snapshots on routine scans. */
export function calculateEditorialPlanOccurrences(
  input: unknown,
  now: Date,
): EditorialPlanPreviewResult {
  const schedule = validateEditorialPlanSchedule(input);
  const clock = DateTime.fromJSDate(now, { zone: "UTC" });
  if (!clock.isValid) throw new RangeError("Use a valid fixed UTC clock");
  const today = clock.setZone(schedule.timezone).toISODate();
  if (!today) throw new RangeError("Cannot resolve local date");
  // A UTC calendar cursor retains even dates entirely absent in the requested zone (e.g. Samoa).
  let day = DateTime.fromISO(today, { zone: "UTC" });
  const [hour, minute] = schedule.localTime.split(":").map(Number);
  const occurrences: EditorialPlanPreviewResult["occurrences"] = [];
  for (let index = 0; index < EDITORIAL_PLAN_HORIZON_DAYS; index++, day = day.plus({ days: 1 })) {
    const localDate = day.toISODate();
    if (
      !localDate ||
      localDate < schedule.startDate ||
      localDate > schedule.endDate ||
      !schedule.weekdays.includes(day.weekday)
    )
      continue;
    const candidate = DateTime.fromObject(
      { year: day.year, month: day.month, day: day.day, hour, minute },
      { zone: schedule.timezone },
    );
    const base = { localDate, localTime: schedule.localTime, timezone: schedule.timezone };
    if (
      !candidate.isValid ||
      candidate.toISODate() !== localDate ||
      candidate.hour !== hour ||
      candidate.minute !== minute
    ) {
      occurrences.push({
        ...base,
        scheduledAt: null,
        offsetMinutes: null,
        state: "skipped",
        reason: "dst_gap",
      });
      continue;
    }
    const earliest = candidate
      .getPossibleOffsets()
      .reduce((a, b) => (a.toMillis() < b.toMillis() ? a : b));
    const expired = earliest.toMillis() <= clock.toMillis();
    occurrences.push({
      ...base,
      scheduledAt: earliest.toUTC().toJSDate().toISOString(),
      offsetMinutes: earliest.offset,
      state: expired ? "skipped" : "planned",
      reason: expired ? "generation_window_expired" : null,
    });
  }
  return { calculatedAt: clock.toJSDate().toISOString(), occurrences };
}
