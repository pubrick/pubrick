import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Only media accounting may be unknown during historical deletion reconciliation. */
export const billingUsageSchema = z.strictObject({
  seats: count,
  brands: count,
  channels: count,
  mediaBytes: count.nullable(),
  concurrentJobs: count,
});
export type BillingUsage = z.infer<typeof billingUsageSchema>;
