import { z } from "zod";
import type { BillingIdentity } from "./types.js";

export type TenantQuotaMode =
  | Readonly<{ mode: "self-hosted" }>
  | Readonly<{ mode: "hosted"; identity: BillingIdentity }>;
export type TenantQuotaEnvironment = {
  PUBRICK_DEPLOYMENT_MODE?: string;
  BILLING_DRIVER?: string;
  BILLING_ACCOUNT_ID?: string;
};
export class TenantQuotaConfigurationError extends Error {
  readonly code = "invalid_configuration";
  constructor() {
    super("invalid_configuration");
    this.name = "TenantQuotaConfigurationError";
  }
}
const modeSchema = z.enum(["self-hosted", "hosted"]).default("self-hosted");
const identitySchema = z.discriminatedUnion("BILLING_DRIVER", [
  z.object({
    BILLING_DRIVER: z.literal("stripe-sandbox"),
    BILLING_ACCOUNT_ID: z
      .string()
      .max(100)
      .regex(/^acct_[a-zA-Z0-9_]+$/)
      .refine((value) => value === value.trim()),
  }),
  z.object({
    BILLING_DRIVER: z.literal("fixture"),
    BILLING_ACCOUNT_ID: z
      .string()
      .max(100)
      .regex(/^fixture_[a-zA-Z0-9_]+$/)
      .refine((value) => value === value.trim()),
  }),
]);
/** Pure server-only configuration. No environment reads, database imports or live-key assumptions. */
export function resolveTenantQuotaMode(
  values: TenantQuotaEnvironment,
  nodeEnv?: string,
): TenantQuotaMode {
  try {
    const mode = modeSchema.parse(values.PUBRICK_DEPLOYMENT_MODE);
    if (mode === "self-hosted") return { mode };
    const config = identitySchema.parse(values);
    if (config.BILLING_DRIVER === "fixture" && nodeEnv === "production")
      throw new TenantQuotaConfigurationError();
    return {
      mode,
      identity: {
        provider: config.BILLING_DRIVER === "fixture" ? "fixture" : "stripe",
        environment: "sandbox",
        accountId: config.BILLING_ACCOUNT_ID,
      },
    };
  } catch {
    throw new TenantQuotaConfigurationError();
  }
}
