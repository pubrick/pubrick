import { expect, it } from "vitest";
import { billingUsageSchema } from "./billing.js";

const usage = { seats: 1, brands: 1, channels: 0, mediaBytes: 100, concurrentJobs: 0 };
it("allows only an explicit unknown media count, preserving other authoritative counters", () => {
  expect(billingUsageSchema.parse({ ...usage, mediaBytes: null })).toEqual({
    ...usage,
    mediaBytes: null,
  });
  for (const field of ["seats", "brands", "channels", "concurrentJobs"])
    expect(billingUsageSchema.safeParse({ ...usage, [field]: null }).success).toBe(false);
  for (const mediaBytes of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "100"])
    expect(billingUsageSchema.safeParse({ ...usage, mediaBytes }).success).toBe(false);
});
