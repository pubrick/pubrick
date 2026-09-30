import { randomUUID } from "node:crypto";
import { FixtureBillingDriver } from "@pubrick/billing";
import { createDb, resolveBillingEntitlement, runMigrations, schema } from "@pubrick/db";
import { RUN_ADMISSION_LOCK_NAMESPACE } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BillingRepository } from "./billing.repository";
import { BillingCatalog } from "./catalog-core";
import { CheckoutCore } from "./checkout-core";
import { CleanupCore } from "./cleanup-core";

const url = process.env.BILLING_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    process.env.PUBRICK_BILLING_DISPOSABLE !== "1" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !/^\/pubrick_billing_[a-z0-9_]+$/.test(parsed.pathname)
  )
    throw new Error("Billing persistence tests require an explicitly disposable local database");
}
describe.skipIf(!url)("durable billing persistence on a disposable database", () => {
  const connection = createDb(url ?? "postgres://unused");
  const db = connection.db;
  const identity = {
    provider: "fixture" as const,
    environment: "sandbox" as const,
    accountId: `fixture_persistence_${randomUUID().replaceAll("-", "")}`,
  };
  const plan = {
    id: "team",
    version: "v1",
    priceId: "price_team",
    limits: { seats: 2, brands: 2, channels: 2, mediaBytes: 8192, concurrentJobs: 1 },
  };
  const driver = new FixtureBillingDriver({
    accountId: identity.accountId,
    origin: "http://localhost:31300",
    prices: [
      {
        identity,
        priceId: plan.priceId,
        productId: "prod_team",
        active: true,
        currency: "eur",
        unitAmount: 1700,
        interval: "month",
        intervalCount: 1,
      },
    ],
  });
  const catalog = new BillingCatalog(driver, [plan]);
  let clock = new Date();
  const repository = new BillingRepository(db, identity, () => clock);
  async function org() {
    const orgId = `org_${randomUUID()}`,
      userId = `user_${randomUUID()}`;
    await db.insert(schema.user).values({
      id: userId,
      name: "Billing fixture",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Disposable billing", slug: orgId });
    await db
      .insert(schema.member)
      .values({ id: randomUUID(), organizationId: orgId, userId, role: "owner" });
    return { orgId, userId };
  }
  beforeAll(async () => {
    await runMigrations(url as string);
    await catalog.initialize();
    await repository.publishCatalog(catalog.list());
  }, 120000);
  afterAll(() => connection.pool.end());
  it("leases one immutable attempt and reuses the original URLs/key across locale retries", async () => {
    const tenant = await org();
    const [first, second] = await Promise.all([
      repository.begin(tenant.orgId, tenant.userId, catalog.select(plan.id), identity, {
        successUrl: "http://localhost:31300/en/settings",
        cancelUrl: "http://localhost:31300/en/settings",
      }),
      repository.begin(tenant.orgId, tenant.userId, catalog.select(plan.id), identity, {
        successUrl: "http://localhost:31300/ru/settings",
        cancelUrl: "http://localhost:31300/ru/settings",
      }),
    ]);
    const lease = first.kind === "attempt" ? first : second;
    expect(lease.kind).toBe("attempt");
    expect([first.kind, second.kind].sort()).toEqual(["attempt", "pending"]);
    if (lease.kind !== "attempt") throw new Error("fixture");
    await repository.failed(tenant.orgId, lease.attempt, "timeout");
    const retried = await repository.begin(
      tenant.orgId,
      tenant.userId,
      catalog.select(plan.id),
      identity,
      {
        successUrl: "http://localhost:31300/es/settings",
        cancelUrl: "http://localhost:31300/es/settings",
      },
    );
    expect(retried.kind).toBe("attempt");
    if (retried.kind !== "attempt") throw new Error("fixture");
    expect(retried.attempt.successUrl).toBe(lease.attempt.successUrl);
    expect(retried.attempt.checkoutKey).toBe(lease.attempt.checkoutKey);
    expect(
      await repository.complete(tenant.orgId, lease.attempt, {
        id: "cs_stale",
        url: "http://localhost:31300/__billing-fixture/checkout/cs_stale",
      }),
    ).toBe(false);
    const [state] = await db
      .select()
      .from(schema.organizationBillingState)
      .where(eq(schema.organizationBillingState.orgId, tenant.orgId));
    expect(state?.access).toBe(false);
  });
  it("retains tombstone and cleanup when deletion wins before the SDK returns", async () => {
    const tenant = await org();
    const begun = await repository.begin(
      tenant.orgId,
      tenant.userId,
      catalog.select(plan.id),
      identity,
      {
        successUrl: "http://localhost:31300/en/settings",
        cancelUrl: "http://localhost:31300/en/settings",
      },
    );
    if (begun.kind !== "attempt") throw new Error("fixture");
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${tenant.orgId}))`,
      );
      await tx
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, tenant.orgId))
        .for("update");
      await repository.tombstoneInTx(tenant.orgId, tx);
      await tx.delete(schema.organization).where(eq(schema.organization.id, tenant.orgId));
    });
    const customer = await driver.createCustomer({
      orgReference: tenant.orgId,
      idempotencyKey: begun.attempt.customerKey,
    });
    expect(
      await repository.attachCustomer(tenant.orgId, begun.attempt, customer.customerId),
    ).toBeNull();
    const [account] = await db
      .select()
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.orgId, tenant.orgId));
    expect(account).toMatchObject({ deleted: true, customerId: customer.customerId });
    const [cleanup] = await db
      .select()
      .from(schema.billingCleanup)
      .where(eq(schema.billingCleanup.orgId, tenant.orgId));
    expect(cleanup?.kind).toBe("attempt");
    if (!cleanup) throw new Error("fixture");
    await new CleanupCore(driver, repository).process(cleanup);
    const attempt = await repository.getCleanupAttempt(begun.attempt.id);
    expect(attempt?.checkoutId).toBeTruthy();
    expect((await driver.retrieveCheckout(attempt?.checkoutId ?? "")).status).toBe("expired");
  });
  it("deduplicates receipts and refuses stale processing lease application", async () => {
    const event = {
      identity,
      eventId: `evt_${randomUUID().replaceAll("-", "")}`,
      kind: "checkout.completed" as const,
      resourceId: "cs_unused",
    };
    const ids = await Promise.all([repository.receive(event), repository.receive(event)]);
    expect(ids[0]).toBe(ids[1]);
    clock = new Date();
    const claims = await Promise.all([
      repository.claim(ids[0] ?? ""),
      repository.claim(ids[0] ?? ""),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean);
    if (!claim) throw new Error("fixture");
    clock = new Date(clock.getTime() + 121000);
    const next = await repository.claim(claim.id);
    expect(next?.lease).not.toBe(claim.lease);
    await repository.ignored(claim, "nonowned");
    const [stored] = await db
      .select()
      .from(schema.billingReceipts)
      .where(eq(schema.billingReceipts.id, claim.id));
    expect(stored?.status).toBe("processing");
  });
  it("never grants an unconfigured tenant and refuses catalog edits at the same version", async () => {
    const tenant = await org();
    const decision = await db.transaction((tx) =>
      resolveBillingEntitlement(tenant.orgId, tx, new Date()),
    );
    expect(decision.decision).toBe("unconfigured");
    await expect(
      repository.publishCatalog([
        { ...catalog.select(plan.id), limits: { ...plan.limits, seats: 99 } },
      ]),
    ).rejects.toThrow("configuration");
  });
  it("applies normalized subscription facts while historical ticks keep the newer entitlement", async () => {
    const tenant = await org();
    await new CheckoutCore(driver, catalog, repository, "http://localhost:31300").start(
      tenant.orgId,
      tenant.userId,
      plan.id,
      "en",
    );
    const [account] = await db
      .select()
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.orgId, tenant.orgId));
    if (!account?.customerId) throw new Error("fixture");
    const suffix = randomUUID().replaceAll("-", "");
    const old = `sub_old_${suffix}`,
      current = `sub_current_${suffix}`;
    async function apply(subscriptionId: string, status: "active" | "canceled") {
      const id = await repository.receive({
        identity,
        eventId: `evt_${randomUUID().replaceAll("-", "")}`,
        kind: "subscription.changed",
        resourceId: subscriptionId,
      });
      const claim = await repository.claim(id),
        mapping = await repository.mapping(identity, account?.customerId ?? "", subscriptionId);
      if (!claim || !mapping) throw new Error("fixture");
      return repository.apply(
        tenant.orgId,
        claim,
        mapping,
        {
          identity,
          customerId: account?.customerId ?? "",
          subscriptionId,
          priceId: plan.priceId,
          status,
          periodStart: Math.floor(clock.getTime() / 1000),
          periodEnd: Math.floor(clock.getTime() / 1000) + 3600,
          cancelAtPeriodEnd: false,
        },
        catalog.select(plan.id),
      );
    }
    expect(await apply(old, "canceled")).toBe("applied");
    expect(await apply(current, "active")).toBe("applied");
    expect(await apply(old, "canceled")).toBe("applied");
    const [state] = await db
      .select()
      .from(schema.organizationBillingState)
      .where(eq(schema.organizationBillingState.orgId, tenant.orgId));
    expect(state).toMatchObject({ subscriptionId: current, access: true });
    const entitlement = await db.transaction((tx) =>
      resolveBillingEntitlement(tenant.orgId, tx, clock),
    );
    expect(entitlement).toMatchObject({ decision: "active", identity, limits: plan.limits });
  });
});
