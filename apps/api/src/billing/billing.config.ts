import type { BillingIdentity, PriceSnapshot } from "@pubrick/billing";
import { z } from "zod";
import type { PlanDefinition } from "./catalog-core";

/** Operator configuration only. These fields never accept request payloads. */
export const billingEnvironmentSchema = z.object({
  BILLING_DRIVER: z.enum(["stripe-sandbox", "fixture"]).optional(),
  BILLING_ACCOUNT_ID: z.string().optional(),
  BILLING_CATALOG_JSON: z.string().optional(),
  BILLING_STRIPE_SECRET_KEY: z.string().optional(),
  BILLING_STRIPE_WEBHOOK_SECRET: z.string().optional(),
  BILLING_FIXTURE_PRICES_JSON: z.string().optional(),
  BILLING_MAX_OWNED_WORKSPACES: z.coerce
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  BILLING_MAX_CREATES_PER_DAY: z.coerce
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  BILLING_SDK_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(2000),
  BILLING_TICK_BUDGET_MS: z.coerce.number().int().min(100).max(30000).default(10000),
  BILLING_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
});
const finiteLimit = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const name = z.string().trim().min(1).max(100);
const planSchema = z.strictObject({
  id: name,
  version: name,
  priceId: z.string().regex(/^price_[a-zA-Z0-9_]+$/),
  limits: z.strictObject({
    seats: finiteLimit.min(1),
    brands: finiteLimit,
    channels: finiteLimit,
    mediaBytes: finiteLimit,
    concurrentJobs: finiteLimit,
  }),
});
const plansSchema = z
  .array(planSchema)
  .min(1)
  .max(100)
  .refine(
    (plans) =>
      new Set(plans.map((plan) => plan.id)).size === plans.length &&
      new Set(plans.map((plan) => plan.priceId)).size === plans.length,
  );
const pricesSchema = z
  .array(
    z.strictObject({
      priceId: z.string().regex(/^price_[a-zA-Z0-9_]+$/),
      productId: z.string().regex(/^prod_[a-zA-Z0-9_]+$/),
      active: z.literal(true),
      currency: z.string().regex(/^[a-z]{3}$/),
      unitAmount: finiteLimit,
      interval: z.enum(["day", "week", "month", "year"]),
      intervalCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    }),
  )
  .min(1)
  .max(100);
export class BillingConfigurationError extends Error {
  constructor(
    public readonly code:
      | "invalid_configuration"
      | "fixture_inventory_not_empty" = "invalid_configuration",
  ) {
    super(code);
    this.name = "BillingConfigurationError";
  }
}
export type HostedBillingConfig = Readonly<{
  enabled: true;
  driver: "stripe-sandbox" | "fixture";
  identity: BillingIdentity;
  publicOrigin: string;
  plans: readonly PlanDefinition[];
  fixturePrices: readonly PriceSnapshot[];
  secretKey?: string;
  webhookSecret?: string;
  accountPolicy: Readonly<{ maxOwnedWorkspaces: number; maxCreatesPerDay: number }>;
  trial: Readonly<{ enabled: false }>;
  sdkTimeoutMs: number;
  tickBudgetMs: number;
  sweepIntervalMs: number;
}>;
export type BillingConfig = HostedBillingConfig | Readonly<{ enabled: false }>;
export function parseBillingConfig(
  values: Record<string, unknown>,
  context: { deploymentMode: "hosted" | "self-hosted"; nodeEnv?: string; publicOrigin: string },
): BillingConfig {
  if (context.deploymentMode === "self-hosted") return { enabled: false };
  try {
    const env = billingEnvironmentSchema.parse(values);
    if (
      !env.BILLING_DRIVER ||
      !env.BILLING_ACCOUNT_ID ||
      !env.BILLING_CATALOG_JSON ||
      !env.BILLING_MAX_OWNED_WORKSPACES ||
      !env.BILLING_MAX_CREATES_PER_DAY
    )
      throw new BillingConfigurationError();
    const origin = new URL(context.publicOrigin);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
        ))
    )
      throw new BillingConfigurationError();
    const plans = plansSchema.parse(JSON.parse(env.BILLING_CATALOG_JSON));
    const fixture = env.BILLING_DRIVER === "fixture";
    if (
      fixture &&
      (context.nodeEnv === "production" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
      throw new BillingConfigurationError();
    if (
      !new RegExp(fixture ? "^fixture_[a-zA-Z0-9_]+$" : "^acct_[a-zA-Z0-9_]+$").test(
        env.BILLING_ACCOUNT_ID,
      )
    )
      throw new BillingConfigurationError();
    if (
      !fixture &&
      (!env.BILLING_STRIPE_SECRET_KEY?.startsWith("sk_test_") ||
        !env.BILLING_STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"))
    )
      throw new BillingConfigurationError();
    const identity: BillingIdentity = {
      provider: fixture ? "fixture" : "stripe",
      environment: "sandbox",
      accountId: env.BILLING_ACCOUNT_ID,
    };
    const fixturePrices = fixture
      ? pricesSchema
          .parse(JSON.parse(env.BILLING_FIXTURE_PRICES_JSON ?? "null"))
          .map((price) => ({ ...price, identity }))
      : [];
    if (
      fixture &&
      (new Set(fixturePrices.map((price) => price.priceId)).size !== fixturePrices.length ||
        plans.some((plan) => !fixturePrices.some((price) => price.priceId === plan.priceId)))
    )
      throw new BillingConfigurationError();
    return {
      enabled: true,
      driver: env.BILLING_DRIVER,
      identity,
      publicOrigin: origin.origin,
      plans,
      fixturePrices,
      ...(fixture
        ? {}
        : {
            secretKey: env.BILLING_STRIPE_SECRET_KEY,
            webhookSecret: env.BILLING_STRIPE_WEBHOOK_SECRET,
          }),
      accountPolicy: {
        maxOwnedWorkspaces: env.BILLING_MAX_OWNED_WORKSPACES,
        maxCreatesPerDay: env.BILLING_MAX_CREATES_PER_DAY,
      },
      trial: { enabled: false },
      sdkTimeoutMs: env.BILLING_SDK_TIMEOUT_MS,
      tickBudgetMs: env.BILLING_TICK_BUDGET_MS,
      sweepIntervalMs: env.BILLING_SWEEP_INTERVAL_MS,
    };
  } catch {
    throw new BillingConfigurationError();
  }
}
