import { RUN_ADMISSION_LOCK_NAMESPACE } from "@pubrick/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import { resolveBillingEntitlement } from "./billing-entitlement.js";
import {
  assertBillingGrowth,
  BillingGrowthError,
  type BillingGrowthIdentity,
} from "./billing-growth.js";
import type { createDb } from "./client.js";
import { organization } from "./schema/auth.js";
import { hostedAiCallLeases } from "./schema/hosted-ai-call-leases.js";

type Database = ReturnType<typeof createDb>["db"];
export type AiCallKind = "text" | "image" | "embedding" | "probe";
export type AiCallAdmissionMode =
  | { mode: "self-hosted" }
  | { mode: "hosted"; identity: BillingGrowthIdentity };
export type HostedAiCallLease = {
  id: string;
  kind: AiCallKind;
  dispatchDeadlineAt: Date;
  leaseExpiresAt: Date;
};
export type HostedAiCallScope = {
  signal: AbortSignal;
  dispatchBudgetMs: 120000 | 30000;
  leaseId: string | null;
};
export class AiCallAdmissionError extends Error {
  constructor(
    readonly code:
      | "aborted"
      | "organization_unavailable"
      | "subscription_required"
      | "billing_identity_mismatch"
      | "concurrency_limit"
      | "probe_concurrency_limit"
      | "admission_unavailable",
  ) {
    super(code);
    this.name = "AiCallAdmissionError";
  }
}
export function aiCallDispatchBudget(kind: AiCallKind): 120000 | 30000 {
  if (kind === "text" || kind === "image") return 120000;
  if (kind === "embedding" || kind === "probe") return 30000;
  throw new AiCallAdmissionError("admission_unavailable");
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AiCallAdmissionError("aborted");
}
/** Caller uses a pool with bounded connectionTimeoutMillis. No provider I/O in this transaction. */
export async function acquireHostedAiCall(
  orgId: string,
  db: Database,
  mode: AiCallAdmissionMode,
  kind: AiCallKind,
  signal?: AbortSignal,
): Promise<HostedAiCallLease | null> {
  checkSignal(signal);
  const budget = aiCallDispatchBudget(kind);
  if (mode.mode === "self-hosted") return null;
  let lease: HostedAiCallLease;
  try {
    lease = await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
      );
      checkSignal(signal);
      const [tenant] = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, orgId))
        .for("key share");
      if (!tenant) throw new AiCallAdmissionError("organization_unavailable");
      const clock = async () => {
        const [row] = await tx
          .select({ now: sql<Date>`clock_timestamp()` })
          .from(organization)
          .where(eq(organization.id, orgId));
        if (!row) throw new AiCallAdmissionError("organization_unavailable");
        return new Date(row.now);
      };
      const entitlement =
        kind === "probe" ? null : await resolveBillingEntitlement(orgId, tx, await clock());
      const now = await clock();
      // The billing row lock can wait: expiration must be checked against the clock AFTER acquiring it.
      if (entitlement && (!entitlement.accessUntil || entitlement.accessUntil <= now))
        entitlement.decision = "expired";
      const [usage] = await tx
        .select({ count: sql<string>`count(*)::text` })
        .from(hostedAiCallLeases)
        .where(
          and(
            eq(hostedAiCallLeases.orgId, orgId),
            gt(hostedAiCallLeases.leaseExpiresAt, now),
            kind === "probe" ? eq(hostedAiCallLeases.kind, "probe") : undefined,
          ),
        );
      const occupied = Number(usage?.count);
      if (!Number.isSafeInteger(occupied) || occupied < 0)
        throw new AiCallAdmissionError("admission_unavailable");
      if (kind === "probe") {
        if (occupied >= 1) throw new AiCallAdmissionError("probe_concurrency_limit");
      } else if (entitlement)
        assertBillingGrowth(entitlement, mode.identity, "concurrentJobs", occupied, 1);
      checkSignal(signal);
      // Own-tenant bounded cleanup; never sweep other organizations during admission.
      await tx.execute(
        sql`delete from ${hostedAiCallLeases} where ${hostedAiCallLeases.id} in (select id from ${hostedAiCallLeases} where org_id = ${orgId} and lease_expires_at <= ${now} order by lease_expires_at, id limit 1000)`,
      );
      const dispatchDeadlineAt = new Date(now.getTime() + budget);
      const [inserted] = await tx
        .insert(hostedAiCallLeases)
        .values({
          orgId,
          kind,
          createdAt: now,
          dispatchDeadlineAt,
          leaseExpiresAt: new Date(dispatchDeadlineAt.getTime() + 60000),
        })
        .returning({
          id: hostedAiCallLeases.id,
          kind: hostedAiCallLeases.kind,
          dispatchDeadlineAt: hostedAiCallLeases.dispatchDeadlineAt,
          leaseExpiresAt: hostedAiCallLeases.leaseExpiresAt,
        });
      if (!inserted) throw new AiCallAdmissionError("admission_unavailable");
      return inserted;
    });
  } catch (error) {
    if (error instanceof AiCallAdmissionError) throw error;
    if (error instanceof BillingGrowthError)
      throw new AiCallAdmissionError(
        error.code === "resource_limit" ? "concurrency_limit" : error.code,
      );
    throw new AiCallAdmissionError(signal?.aborted ? "aborted" : "admission_unavailable");
  }
  if (signal?.aborted) {
    try {
      await releaseHostedAiCall(orgId, db, lease.id);
    } catch {
      /* TTL safely retains uncertain release. */
    }
    throw new AiCallAdmissionError("aborted");
  }
  return lease;
}
/** UUID fencing prevents an older callback from releasing a newer dispatch. */
export async function releaseHostedAiCall(
  orgId: string,
  db: Database,
  leaseId: string,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx
        .delete(hostedAiCallLeases)
        .where(and(eq(hostedAiCallLeases.orgId, orgId), eq(hostedAiCallLeases.id, leaseId)));
    });
  } catch {
    throw new AiCallAdmissionError("admission_unavailable");
  }
}
/** Every physical SDK dispatch (including each retry) must forward scope.signal. */
export async function withHostedAiCall<T>(
  orgId: string,
  db: Database,
  mode: AiCallAdmissionMode,
  kind: AiCallKind,
  callerSignal: AbortSignal | undefined,
  dispatch: (scope: HostedAiCallScope) => Promise<T>,
  options?: { onReleaseFailure?: () => void },
): Promise<T> {
  checkSignal(callerSignal);
  const dispatchBudgetMs = aiCallDispatchBudget(kind);
  const timeout = AbortSignal.timeout(dispatchBudgetMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const lease = await acquireHostedAiCall(orgId, db, mode, kind, signal);
  try {
    checkSignal(signal);
    // Await the real promise; racing cancellation would prematurely release an unsettled physical call.
    return await dispatch({ signal, dispatchBudgetMs, leaseId: lease?.id ?? null });
  } finally {
    if (lease) {
      try {
        await releaseHostedAiCall(orgId, db, lease.id);
      } catch {
        try {
          options?.onReleaseFailure?.();
        } catch {
          /* Diagnostics must not cause duplicate SDK retry. */
        }
      }
    }
  }
}
