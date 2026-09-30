import { HttpException } from "@nestjs/common";
import { resolveTenantQuotaMode } from "@pubrick/billing";
import {
  BillingGrowthError,
  ResourceAdmissionError,
  type TenantResourceQuotaMode,
} from "@pubrick/db";

import { authorizeRequestActor } from "./request-authority-admission";

/** Operator environment only; no request/header/tenant setting selects deployment policy. */
export function tenantQuotaMode(): TenantResourceQuotaMode {
  const mode = resolveTenantQuotaMode(process.env, process.env.NODE_ENV);
  return mode.mode === "hosted" ? { ...mode, authorizeActor: authorizeRequestActor } : mode;
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
      const status =
        error.code === "target_unavailable" ? 404 : error.code === "authority_revoked" ? 403 : 503;
      const code = status === 404 ? "not_found" : status === 403 ? "forbidden" : "unavailable";
      throw new HttpException({ code, message: code }, status);
    }
    throw error;
  }
}
