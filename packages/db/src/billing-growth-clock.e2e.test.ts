import { randomUUID } from "node:crypto";
import { RUN_ADMISSION_LOCK_NAMESPACE } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizeBillingGrowth } from "./billing-growth.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";

const identity = { provider: "stripe", environment: "sandbox", accountId: "acct_jobs" } as const;
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("native billing lock clock", () => {
  let connection: ReturnType<typeof createDb>;
  const orgIds: string[] = [];
  const planIds: string[] = [];
  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string, { connectionTimeoutMillis: 5000 });
  }, 60000);
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of orgIds) {
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await connection.db
        .delete(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.orgId, orgId));
    }
    for (const id of planIds)
      await connection.db
        .delete(schema.billingPlanVersions)
        .where(eq(schema.billingPlanVersions.id, id));
    await connection.pool.end();
  });
  async function fixture(limits: Partial<schema.BillingLimits> = {}) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Resource fixture", slug: orgId });
    const planId = randomUUID();
    planIds.push(planId);
    const priceId = `price_${planId}`;
    await connection.db.insert(schema.billingPlanVersions).values({
      id: planId,
      ...identity,
      planId: "job-fixture",
      version: planId,
      priceId,
      price: {
        priceId,
        productId: `product_${planId}`,
        currency: "usd",
        unitAmount: 100,
        interval: "month",
        intervalCount: 1,
      },
      limits: { seats: 2, brands: 2, channels: 1, mediaBytes: 100, concurrentJobs: 1, ...limits },
    });
    const subscriptionId = `sub_${orgId}`;
    const periodEnd = new Date(Date.now() + 86400000);
    await connection.db.insert(schema.billingSubscriptions).values({
      orgId,
      ...identity,
      customerId: `cus_${orgId}`,
      subscriptionId,
      status: "active",
      priceId,
      planVersionId: planId,
      periodStart: new Date(Date.now() - 3600000),
      periodEnd,
      cancelAtPeriodEnd: false,
    });
    await connection.db.insert(schema.organizationBillingState).values({
      orgId,
      subscriptionId,
      planVersionId: planId,
      access: true,
      accessUntil: periodEnd,
    });
    return { orgId };
  }

  it("refuses an entitlement that expires while admission waits for the billing state lock", async () => {
    const f = await fixture();
    const locker = await connection.pool.connect();
    await locker.query("begin");
    await locker.query("select org_id from organization_billing_state where org_id=$1 for update", [
      f.orgId,
    ]);
    const outcome = connection.db
      .transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${f.orgId}))`,
        );
        await tx
          .select({ id: schema.organization.id })
          .from(schema.organization)
          .where(eq(schema.organization.id, f.orgId))
          .for("share");
        await authorizeBillingGrowth(f.orgId, tx, identity, {
          resource: "concurrentJobs",
          occupied: 0,
          additional: 1,
        });
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    try {
      const deadline = Date.now() + 4000;
      let queryStart: Date | undefined;
      while (Date.now() < deadline) {
        const blocked = await connection.pool.query<{ query_start: Date }>(
          "select query_start from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%organization_billing_state%for update%'",
        );
        if (blocked.rows[0]) {
          queryStart = blocked.rows[0].query_start;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (!queryStart) throw new Error("Admission did not wait on the billing row");
      // A real expiry AFTER the blocked SELECT began, and BEFORE it acquires the state.
      await locker.query(
        "update organization_billing_state set access_until=$2::timestamptz + interval '1 millisecond' where org_id=$1",
        [f.orgId, queryStart],
      );
      await locker.query("select pg_sleep(0.02)");
      await locker.query("commit");
      expect(await outcome).toMatchObject({ code: "subscription_required" });
    } finally {
      await locker.query("rollback");
      locker.release();
    }
  });
});
