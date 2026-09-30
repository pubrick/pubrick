import { HttpException } from "@nestjs/common";
import { resolveTenantQuotaMode } from "@pubrick/billing";
import {
  BillingGrowthError,
  ResourceAdmissionError,
  type TenantResourceQuotaMode,
} from "@pubrick/db";

/** Operator environment only; no request/header/tenant setting selects deployment policy. */
export function tenantQuotaMode(): TenantResourceQuotaMode {
  return resolveTenantQuotaMode(process.env, process.env.NODE_ENV);
}

/** Keep the same closed refusal shape on every resource writer. */
export async function withQuotaErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof BillingGrowthError) {
      const status =
        error.code === "subscription_required" ? 402 : error.code === "resource_limit" ? 409 : 503;
      throw new HttpException(
        { code: error.code, message: error.code, resource: error.resource },
        status,
      );
    }
    if (error instanceof ResourceAdmissionError) {
      const status = error.code === "target_unavailable" ? 404 : 503;
      const code = status === 404 ? "not_found" : "unavailable";
      throw new HttpException({ code, message: code }, status);
    }
    throw error;
  }
}
