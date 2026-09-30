import {
  type BillingConfig,
  BillingConfigurationError,
  parseBillingConfig,
} from "./billing/billing.config";
import { env } from "./env";

function loadRuntimeBillingConfig(): BillingConfig {
  try {
    return parseBillingConfig(process.env, {
      deploymentMode: env.PUBRICK_DEPLOYMENT_MODE,
      nodeEnv: process.env.NODE_ENV,
      publicOrigin: env.WEB_ORIGIN,
    });
  } catch (error) {
    if (error instanceof BillingConfigurationError)
      error.message =
        "Hosted billing configuration is invalid. Configure the operator driver, account, catalog and finite account policy; see docs/hosted-identity.md. Fixture billing requires a loopback nonproduction instance.";
    throw error;
  }
}
/** One instance policy shared by auth capabilities and Nest composition, never request input. */
export const billingConfig = loadRuntimeBillingConfig();
