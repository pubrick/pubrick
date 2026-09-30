import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  BillingIdentity,
  SessionResult,
  SubscriptionSnapshot,
  VerifiedEvent,
} from "@pubrick/billing";
import type { createDb } from "@pubrick/db";
import { type BillingTransaction, schema } from "@pubrick/db";
import { RUN_ADMISSION_LOCK_NAMESPACE } from "@pubrick/shared";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { CatalogPlan } from "./catalog-core";
import { attemptRecovery, entitlementReplacement, subscriptionAccess } from "./persistence-policy";
import type {
  BillingMapping,
  CheckoutAttempt,
  CheckoutStore,
  ReceiptClaim,
  ReceiptStore,
} from "./ports";
import { BillingCoreError, sameIdentity } from "./ports";

type Database = ReturnType<typeof createDb>["db"];
type AttemptRow = typeof schema.billingCheckoutAttempts.$inferSelect;
type AccountRow = typeof schema.billingAccounts.$inferSelect;
// Strictly below the vendor's minimum 24h retention, with time for bounded I/O.
const RECOVERY_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 120_000;
const identityWhere = (
  table: {
    provider: AnyPgColumn;
    environment: AnyPgColumn;
    accountId: AnyPgColumn;
  },
  identity: BillingIdentity,
) =>
  and(
    eq(table.provider, identity.provider),
    eq(table.environment, identity.environment),
    eq(table.accountId, identity.accountId),
  );

/** Injected database/config: importing this module never connects or reads process.env. */
export class BillingRepository implements CheckoutStore, ReceiptStore {
  constructor(
    private readonly db: Database,
    readonly identity: BillingIdentity,
    private readonly now = () => new Date(),
  ) {}
  private assertIdentity(value: { provider: string; environment: string; accountId: string }) {
    if (!sameIdentity(value as BillingIdentity, this.identity))
      throw new BillingCoreError("identity_mismatch");
  }
  private async organization(orgId: string, tx: BillingTransaction) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
    );
    const [org] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId))
      .for("update");
    return org;
  }
  async publishCatalog(plans: readonly CatalogPlan[]) {
    await this.db.transaction(async (tx) => {
      for (const plan of plans) {
        this.assertIdentity(plan.price.identity);
        const value = {
          ...this.identity,
          planId: plan.id,
          version: plan.version,
          priceId: plan.priceId,
          price: {
            priceId: plan.price.priceId,
            productId: plan.price.productId,
            currency: plan.price.currency,
            unitAmount: plan.price.unitAmount,
            interval: plan.price.interval,
            intervalCount: plan.price.intervalCount,
          },
          limits: plan.limits,
        };
        await tx.insert(schema.billingPlanVersions).values(value).onConflictDoNothing();
        const [stored] = await tx
          .select()
          .from(schema.billingPlanVersions)
          .where(
            and(
              identityWhere(schema.billingPlanVersions, this.identity),
              eq(schema.billingPlanVersions.planId, plan.id),
              eq(schema.billingPlanVersions.version, plan.version),
            ),
          );
        if (
          !stored ||
          stored.priceId !== plan.priceId ||
          !isDeepStrictEqual(stored.price, value.price) ||
          !isDeepStrictEqual(stored.limits, value.limits)
        )
          throw new BillingCoreError("configuration");
      }
    });
  }
  async history(): Promise<CatalogPlan[]> {
    const rows = await this.db
      .select()
      .from(schema.billingPlanVersions)
      .where(identityWhere(schema.billingPlanVersions, this.identity));
    return rows.map((row) => ({
      id: row.planId,
      version: row.version,
      priceId: row.priceId,
      limits: row.limits,
      price: { ...row.price, identity: this.identity, active: true },
    }));
  }
  private async plan(tx: BillingTransaction, id: string, version: string) {
    const [plan] = await tx
      .select()
      .from(schema.billingPlanVersions)
      .where(
        and(
          identityWhere(schema.billingPlanVersions, this.identity),
          eq(schema.billingPlanVersions.planId, id),
          eq(schema.billingPlanVersions.version, version),
        ),
      );
    if (!plan) throw new BillingCoreError("invalid_plan");
    return plan;
  }
  private async account(orgId: string, tx: BillingTransaction) {
    const [row] = await tx
      .select()
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.orgId, orgId))
      .for("update");
    if (row) this.assertIdentity(row);
    return row;
  }
  private async attemptView(row: AttemptRow, tx: BillingTransaction): Promise<CheckoutAttempt> {
    const [plan] = await tx
      .select()
      .from(schema.billingPlanVersions)
      .where(eq(schema.billingPlanVersions.id, row.planVersionId));
    if (!plan) throw new BillingCoreError("invalid_plan");
    this.assertIdentity(row);
    return {
      orgId: row.orgId,
      id: row.id,
      revision: row.revision,
      identity: this.identity,
      planId: plan.planId,
      planVersion: plan.version,
      priceId: row.priceId,
      customerId: row.customerId,
      customerKey: row.customerKey,
      checkoutKey: row.checkoutKey,
      successUrl: row.successUrl,
      cancelUrl: row.cancelUrl,
      ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    };
  }
  async begin(
    orgId: string,
    userId: string,
    plan: CatalogPlan,
    identity: BillingIdentity,
    urls: { successUrl: string; cancelUrl: string },
  ): ReturnType<CheckoutStore["begin"]> {
    this.assertIdentity(identity);
    return this.db.transaction(async (tx) => {
      if (!(await this.organization(orgId, tx))) throw new BillingCoreError("invalid_attempt");
      const [member] = await tx
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
        .for("share");
      if (!member || !["owner", "admin"].includes(member.role))
        throw new BillingCoreError("invalid_attempt");
      const storedPlan = await this.plan(tx, plan.id, plan.version);
      await tx.insert(schema.organizationBillingState).values({ orgId }).onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(schema.organizationBillingState)
        .where(eq(schema.organizationBillingState.orgId, orgId))
        .for("update");
      if (state?.access && state.accessUntil && state.accessUntil > this.now())
        throw new BillingCoreError("invalid_attempt");
      let account = await this.account(orgId, tx);
      const now = this.now();
      if (!account) {
        [account] = await tx
          .insert(schema.billingAccounts)
          .values({
            orgId,
            ...identity,
            customerKey: `customer:${randomUUID()}`,
            customerIssuedAt: now,
            customerRecoveryDeadline: new Date(now.getTime() + RECOVERY_MS),
          })
          .returning();
      }
      if (!account || account.deleted) throw new BillingCoreError("invalid_attempt");
      let [row] = await tx
        .select()
        .from(schema.billingCheckoutAttempts)
        .where(
          and(
            eq(schema.billingCheckoutAttempts.orgId, orgId),
            inArray(schema.billingCheckoutAttempts.status, ["pending", "ready", "operator_action"]),
          ),
        )
        .for("update");
      if (row && (row.planVersionId !== storedPlan.id || row.deleted))
        throw new BillingCoreError("invalid_attempt");
      if (!row)
        [row] = await tx
          .insert(schema.billingCheckoutAttempts)
          .values({
            orgId,
            ...identity,
            planVersionId: storedPlan.id,
            priceId: plan.priceId,
            customerId: account.customerId,
            customerKey: account.customerKey,
            checkoutKey: `checkout:${randomUUID()}`,
            ...urls,
            issuedAt: now,
            recoveryDeadline: new Date(now.getTime() + RECOVERY_MS),
          })
          .returning();
      if (!row) throw new BillingCoreError("invalid_attempt");
      return this.leaseAttempt(row, account, tx, now, true);
    });
  }
  private async leaseAttempt(
    row: AttemptRow,
    account: AccountRow,
    tx: BillingTransaction,
    now: Date,
    ready: boolean,
  ): ReturnType<CheckoutStore["begin"]> {
    if (row.status === "operator_action") throw new BillingCoreError("retry_required");
    if (row.status === "ready" && ready && row.checkoutId && row.checkoutUrl)
      return { kind: "ready", session: { id: row.checkoutId, url: row.checkoutUrl } };
    if (row.leaseExpiresAt && row.leaseExpiresAt > now) return { kind: "pending" };
    if (
      (!account.customerId && account.customerRecoveryDeadline <= now) ||
      attemptRecovery(
        {
          issuedAt: row.issuedAt.getTime(),
          recoveryDeadline: row.recoveryDeadline.getTime(),
          checkoutId: row.checkoutId,
        },
        now.getTime(),
      ) === "operator_action"
    ) {
      await tx
        .update(schema.billingCheckoutAttempts)
        .set({
          status: "operator_action",
          errorCode: "recovery_expired",
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(schema.billingCheckoutAttempts.id, row.id));
      return { kind: "pending" };
    }
    const [leased] = await tx
      .update(schema.billingCheckoutAttempts)
      .set({
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(schema.billingCheckoutAttempts.id, row.id))
      .returning();
    if (!leased) throw new BillingCoreError("invalid_attempt");
    return { kind: "attempt", attempt: await this.attemptView(leased, tx) };
  }
  async claimAttempt(id: string): Promise<CheckoutAttempt | null> {
    const [hint] = await this.db
      .select({ orgId: schema.billingCheckoutAttempts.orgId })
      .from(schema.billingCheckoutAttempts)
      .where(eq(schema.billingCheckoutAttempts.id, id));
    if (!hint) return null;
    return this.db.transaction(async (tx) => {
      await this.organization(hint.orgId, tx);
      const account = await this.account(hint.orgId, tx);
      if (!account || account.deleted) return null;
      const [row] = await tx
        .select()
        .from(schema.billingCheckoutAttempts)
        .where(eq(schema.billingCheckoutAttempts.id, id))
        .for("update");
      if (!row || row.deleted || row.status !== "pending" || row.checkoutId) return null;
      const result = await this.leaseAttempt(row, account, tx, this.now(), false);
      return result.kind === "attempt" ? result.attempt : null;
    });
  }
  private validLease(row: AttemptRow, attempt: CheckoutAttempt) {
    return (
      row.leaseToken === attempt.leaseToken &&
      row.revision === attempt.revision &&
      !!row.leaseExpiresAt &&
      row.leaseExpiresAt > this.now()
    );
  }
  private async cleanup(
    tx: BillingTransaction,
    orgId: string,
    identity: BillingIdentity,
    kind: "attempt" | "subscription",
    resourceId: string,
  ) {
    await tx
      .insert(schema.billingCleanup)
      .values({
        orgId,
        ...identity,
        kind,
        resourceId,
        idempotencyKey: `cleanup:${kind}:${resourceId}`,
      })
      .onConflictDoNothing();
  }
  async attachCustomer(
    orgId: string,
    attempt: CheckoutAttempt,
    customerId: string,
  ): Promise<CheckoutAttempt | null> {
    return this.db.transaction(async (tx) => {
      const org = await this.organization(orgId, tx);
      if (org) {
        await tx.insert(schema.organizationBillingState).values({ orgId }).onConflictDoNothing();
        await tx
          .select()
          .from(schema.organizationBillingState)
          .where(eq(schema.organizationBillingState.orgId, orgId))
          .for("update");
      }
      const account = await this.account(orgId, tx);
      const [row] = await tx
        .select()
        .from(schema.billingCheckoutAttempts)
        .where(
          and(
            eq(schema.billingCheckoutAttempts.id, attempt.id),
            eq(schema.billingCheckoutAttempts.orgId, orgId),
          ),
        )
        .for("update");
      if (!row || !account) throw new BillingCoreError("invalid_attempt");
      if (account.customerId && account.customerId !== customerId)
        throw new BillingCoreError("identity_mismatch");
      // Immutable external ownership is retained even if deletion/stale completion won.
      await tx
        .update(schema.billingAccounts)
        .set({ customerId, updatedAt: this.now() })
        .where(eq(schema.billingAccounts.orgId, orgId));
      if (!org || account.deleted || row.deleted) {
        await tx
          .update(schema.billingCheckoutAttempts)
          .set({ customerId, deleted: true })
          .where(eq(schema.billingCheckoutAttempts.id, row.id));
        await this.cleanup(tx, orgId, attempt.identity, "attempt", row.id);
        return null;
      }
      if (!this.validLease(row, attempt)) return null;
      const [updated] = await tx
        .update(schema.billingCheckoutAttempts)
        .set({ customerId, revision: row.revision + 1, updatedAt: this.now() })
        .where(eq(schema.billingCheckoutAttempts.id, row.id))
        .returning();
      return updated ? this.attemptView(updated, tx) : null;
    });
  }
  async complete(orgId: string, attempt: CheckoutAttempt, result: SessionResult): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const org = await this.organization(orgId, tx);
      if (org) {
        await tx.insert(schema.organizationBillingState).values({ orgId }).onConflictDoNothing();
        await tx
          .select()
          .from(schema.organizationBillingState)
          .where(eq(schema.organizationBillingState.orgId, orgId))
          .for("update");
      }
      const account = await this.account(orgId, tx);
      const [row] = await tx
        .select()
        .from(schema.billingCheckoutAttempts)
        .where(
          and(
            eq(schema.billingCheckoutAttempts.id, attempt.id),
            eq(schema.billingCheckoutAttempts.orgId, orgId),
          ),
        )
        .for("update");
      if (!row || !account) throw new BillingCoreError("invalid_attempt");
      if (row.checkoutId && row.checkoutId !== result.id)
        throw new BillingCoreError("identity_mismatch");
      if (!org || account.deleted || row.deleted) {
        await tx
          .update(schema.billingCheckoutAttempts)
          .set({ checkoutId: result.id, checkoutUrl: null, deleted: true })
          .where(eq(schema.billingCheckoutAttempts.id, row.id));
        await this.cleanup(tx, orgId, attempt.identity, "attempt", row.id);
        return false;
      }
      if (!this.validLease(row, attempt)) {
        // Retain known external facts without granting a stale caller ready state.
        await tx
          .update(schema.billingCheckoutAttempts)
          .set({ checkoutId: result.id, updatedAt: this.now() })
          .where(eq(schema.billingCheckoutAttempts.id, row.id));
        return false;
      }
      await tx
        .update(schema.billingCheckoutAttempts)
        .set({
          checkoutId: result.id,
          checkoutUrl: result.url,
          status: "ready",
          leaseToken: null,
          leaseExpiresAt: null,
          revision: row.revision + 1,
          updatedAt: this.now(),
        })
        .where(eq(schema.billingCheckoutAttempts.id, row.id));
      return true;
    });
  }
  async failed(orgId: string, attempt: CheckoutAttempt, code: string) {
    await this.db
      .update(schema.billingCheckoutAttempts)
      .set({
        leaseToken: null,
        leaseExpiresAt: null,
        errorCode: code,
        nextAttemptAt: new Date(this.now().getTime() + 30_000),
      })
      .where(
        and(
          eq(schema.billingCheckoutAttempts.orgId, orgId),
          eq(schema.billingCheckoutAttempts.id, attempt.id),
          eq(
            schema.billingCheckoutAttempts.leaseToken,
            attempt.leaseToken ?? "00000000-0000-0000-0000-000000000000",
          ),
        ),
      );
  }
  async receive(event: VerifiedEvent) {
    this.assertIdentity(event.identity);
    const [row] = await this.db
      .insert(schema.billingReceipts)
      .values({
        ...event.identity,
        eventId: event.eventId,
        kind: event.kind,
        resourceId: event.resourceId,
      })
      .onConflictDoNothing()
      .returning({ id: schema.billingReceipts.id });
    if (row) return row.id;
    const [existing] = await this.db
      .select({ id: schema.billingReceipts.id })
      .from(schema.billingReceipts)
      .where(
        and(
          identityWhere(schema.billingReceipts, this.identity),
          eq(schema.billingReceipts.eventId, event.eventId),
        ),
      );
    if (!existing) throw new BillingCoreError("retry_required");
    return existing.id;
  }
  async claim(id: string): Promise<ReceiptClaim | null> {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const [row] = await tx
        .select()
        .from(schema.billingReceipts)
        .where(
          and(
            eq(schema.billingReceipts.id, id),
            identityWhere(schema.billingReceipts, this.identity),
            inArray(schema.billingReceipts.status, ["pending", "processing", "retry"]),
            lte(schema.billingReceipts.nextAttemptAt, now),
            or(
              sql`${schema.billingReceipts.leaseExpiresAt} IS NULL`,
              lte(schema.billingReceipts.leaseExpiresAt, now),
            ),
          ),
        )
        .for("update", { skipLocked: true });
      if (!row) return null;
      const token = randomUUID();
      await tx
        .update(schema.billingReceipts)
        .set({
          status: "processing",
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          attempts: row.attempts + 1,
        })
        .where(eq(schema.billingReceipts.id, row.id));
      return {
        id: row.id,
        lease: token,
        event: {
          identity: this.identity,
          eventId: row.eventId,
          kind: row.kind as VerifiedEvent["kind"],
          resourceId: row.resourceId,
        },
      };
    });
  }
  async mapping(
    identity: BillingIdentity,
    customerId: string,
    _subscriptionId: string,
  ): Promise<BillingMapping | null> {
    this.assertIdentity(identity);
    const [row] = await this.db
      .select()
      .from(schema.billingAccounts)
      .where(
        and(
          identityWhere(schema.billingAccounts, identity),
          eq(schema.billingAccounts.customerId, customerId),
        ),
      );
    return row
      ? { identity, orgId: row.orgId, revision: row.revision, customerId, deleted: row.deleted }
      : null;
  }
  private receiptFence(claim: ReceiptClaim) {
    return and(
      eq(schema.billingReceipts.id, claim.id),
      eq(schema.billingReceipts.leaseToken, claim.lease),
      eq(schema.billingReceipts.status, "processing"),
      sql`${schema.billingReceipts.leaseExpiresAt} > ${this.now()}`,
    );
  }
  async apply(
    orgId: string,
    claim: ReceiptClaim,
    mapping: BillingMapping,
    snapshot: SubscriptionSnapshot,
    plan: CatalogPlan,
  ): Promise<"applied" | "conflict" | "deleted"> {
    return this.db.transaction(async (tx) => {
      const org = await this.organization(orgId, tx);
      let state: typeof schema.organizationBillingState.$inferSelect | undefined;
      if (org) {
        await tx.insert(schema.organizationBillingState).values({ orgId }).onConflictDoNothing();
        [state] = await tx
          .select()
          .from(schema.organizationBillingState)
          .where(eq(schema.organizationBillingState.orgId, orgId))
          .for("update");
      }
      const account = await this.account(orgId, tx);
      const [receipt] = await tx
        .select({ id: schema.billingReceipts.id })
        .from(schema.billingReceipts)
        .where(this.receiptFence(claim))
        .for("update");
      if (!receipt) return "conflict";
      if (!org || account?.deleted) {
        if (account)
          await this.cleanup(tx, orgId, snapshot.identity, "subscription", snapshot.subscriptionId);
        await tx
          .update(schema.billingReceipts)
          .set({ status: "ignored", errorCode: "deleted", leaseToken: null, leaseExpiresAt: null })
          .where(this.receiptFence(claim));
        return "deleted";
      }
      if (
        !account ||
        account.revision !== mapping.revision ||
        account.customerId !== snapshot.customerId
      )
        return "conflict";
      const storedPlan = await this.plan(tx, plan.id, plan.version);
      const [existing] = await tx
        .select()
        .from(schema.billingSubscriptions)
        .where(
          and(
            identityWhere(schema.billingSubscriptions, this.identity),
            eq(schema.billingSubscriptions.subscriptionId, snapshot.subscriptionId),
          ),
        )
        .for("update");
      if (existing && existing.orgId !== orgId) throw new BillingCoreError("identity_mismatch");
      const replacement = entitlementReplacement(
        state?.subscriptionId ?? null,
        snapshot.subscriptionId,
        !!existing,
        !!state?.access && !!state.accessUntil && state.accessUntil > this.now(),
      );
      if (replacement === "cancel_duplicate")
        await this.cleanup(tx, orgId, snapshot.identity, "subscription", snapshot.subscriptionId);
      const values = {
        orgId,
        ...snapshot.identity,
        customerId: snapshot.customerId,
        subscriptionId: snapshot.subscriptionId,
        status: snapshot.status,
        priceId: snapshot.priceId,
        planVersionId: storedPlan.id,
        periodStart: new Date(snapshot.periodStart * 1000),
        periodEnd: new Date(snapshot.periodEnd * 1000),
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        revision: (existing?.revision ?? -1) + 1,
        deleted: existing?.deleted ?? replacement === "cancel_duplicate",
        updatedAt: this.now(),
      };
      await tx
        .insert(schema.billingSubscriptions)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.billingSubscriptions.provider,
            schema.billingSubscriptions.environment,
            schema.billingSubscriptions.accountId,
            schema.billingSubscriptions.subscriptionId,
          ],
          set: values,
        });
      if (replacement === "promote")
        await tx
          .update(schema.organizationBillingState)
          .set({
            subscriptionId: snapshot.subscriptionId,
            planVersionId: storedPlan.id,
            accessUntil: values.periodEnd,
            access: subscriptionAccess(
              snapshot.status,
              values.periodEnd.getTime(),
              this.now().getTime(),
            ),
            revision: sql`${schema.organizationBillingState.revision}+1`,
            updatedAt: this.now(),
          })
          .where(eq(schema.organizationBillingState.orgId, orgId));
      await tx
        .update(schema.billingAccounts)
        .set({ revision: account.revision + 1 })
        .where(eq(schema.billingAccounts.orgId, orgId));
      await tx
        .update(schema.billingReceipts)
        .set({ status: "complete", leaseToken: null, leaseExpiresAt: null, errorCode: null })
        .where(this.receiptFence(claim));
      return "applied";
    });
  }
  async ignored(claim: ReceiptClaim, reason: "nonowned" | "deleted" | "pending_relationship") {
    await this.db
      .update(schema.billingReceipts)
      .set({
        status: reason === "pending_relationship" ? "retry" : "ignored",
        errorCode: reason,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(this.now().getTime() + 60_000),
      })
      .where(this.receiptFence(claim));
  }
  async retry(claim: ReceiptClaim, code: string) {
    await this.db
      .update(schema.billingReceipts)
      .set({
        status: "retry",
        errorCode: code,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(this.now().getTime() + 60_000),
      })
      .where(this.receiptFence(claim));
  }
  /** Root calls this inside the SAME transaction that removes organization.
   * It must acquire advisory -> org UPDATE before entering; no after-delete hook. */
  async tombstoneInTx(orgId: string, tx: BillingTransaction): Promise<void> {
    await tx
      .select()
      .from(schema.organizationBillingState)
      .where(eq(schema.organizationBillingState.orgId, orgId))
      .for("update");
    const account = await this.account(orgId, tx);
    if (!account) return;
    await tx
      .update(schema.billingAccounts)
      .set({ deleted: true, revision: account.revision + 1, updatedAt: this.now() })
      .where(eq(schema.billingAccounts.orgId, orgId));
    const attempts = await tx
      .select()
      .from(schema.billingCheckoutAttempts)
      .where(eq(schema.billingCheckoutAttempts.orgId, orgId))
      .orderBy(asc(schema.billingCheckoutAttempts.id))
      .for("update");
    for (const attempt of attempts) {
      await tx
        .update(schema.billingCheckoutAttempts)
        .set({ deleted: true, checkoutUrl: null })
        .where(eq(schema.billingCheckoutAttempts.id, attempt.id));
      await this.cleanup(
        tx,
        orgId,
        {
          provider: attempt.provider,
          environment: attempt.environment,
          accountId: attempt.accountId,
        } as BillingIdentity,
        "attempt",
        attempt.id,
      );
    }
    const subscriptions = await tx
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.orgId, orgId))
      .orderBy(asc(schema.billingSubscriptions.id))
      .for("update");
    for (const sub of subscriptions) {
      await tx
        .update(schema.billingSubscriptions)
        .set({ deleted: true })
        .where(eq(schema.billingSubscriptions.id, sub.id));
      await this.cleanup(
        tx,
        orgId,
        {
          provider: sub.provider,
          environment: sub.environment,
          accountId: sub.accountId,
        } as BillingIdentity,
        "subscription",
        sub.subscriptionId,
      );
    }
  }
  async cleanupCustomerDeadline(orgId: string) {
    const [row] = await this.db
      .select({ deadline: schema.billingAccounts.customerRecoveryDeadline })
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.orgId, orgId));
    return row?.deadline ?? null;
  }
  async deletedObligation(mapping: BillingMapping, subscriptionId: string) {
    await this.db.transaction(async (tx) => {
      const account = await this.account(mapping.orgId, tx);
      if (!account?.deleted) return;
      await this.cleanup(tx, mapping.orgId, mapping.identity, "subscription", subscriptionId);
    });
  }
  async authorizedCustomer(orgId: string, userId: string) {
    return this.db.transaction(async (tx) => {
      if (!(await this.organization(orgId, tx))) throw new BillingCoreError("invalid_attempt");
      const [member] = await tx
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
        .for("share");
      if (!member || !["owner", "admin"].includes(member.role))
        throw new BillingCoreError("invalid_attempt");
      const account = await this.account(orgId, tx);
      if (!account || account.deleted || !account.customerId)
        throw new BillingCoreError("invalid_attempt");
      return account.customerId;
    });
  }
  async view(orgId: string) {
    const [state] = await this.db
      .select()
      .from(schema.organizationBillingState)
      .where(eq(schema.organizationBillingState.orgId, orgId));
    return state
      ? {
          revision: state.revision,
          access: state.access && !!state.accessUntil && state.accessUntil > this.now(),
          accessUntil: state.accessUntil,
          configured: !!state.planVersionId,
        }
      : { revision: 0, access: false, accessUntil: null, configured: false };
  }
  async getCleanupAttempt(id: string) {
    const [row] = await this.db
      .select()
      .from(schema.billingCheckoutAttempts)
      .where(eq(schema.billingCheckoutAttempts.id, id));
    return row ?? null;
  }
  async recordCleanupCustomer(id: string, customerId: string) {
    return this.db.transaction(async (tx) => {
      const [hint] = await tx
        .select()
        .from(schema.billingCheckoutAttempts)
        .where(eq(schema.billingCheckoutAttempts.id, id));
      if (!hint) return;
      const account = await this.account(hint.orgId, tx);
      if (!account?.deleted) throw new BillingCoreError("invalid_attempt");
      if (account.customerId && account.customerId !== customerId)
        throw new BillingCoreError("identity_mismatch");
      await tx
        .update(schema.billingAccounts)
        .set({ customerId })
        .where(eq(schema.billingAccounts.orgId, hint.orgId));
      await tx
        .update(schema.billingCheckoutAttempts)
        .set({ customerId })
        .where(eq(schema.billingCheckoutAttempts.id, id));
    });
  }
  async recordCleanupCheckout(id: string, checkoutId: string) {
    await this.db
      .update(schema.billingCheckoutAttempts)
      .set({ checkoutId, checkoutUrl: null })
      .where(
        and(
          eq(schema.billingCheckoutAttempts.id, id),
          eq(schema.billingCheckoutAttempts.deleted, true),
        ),
      );
  }
  async claimCleanup(id: string) {
    return this.db.transaction(async (tx) => {
      const now = this.now();
      const [row] = await tx
        .select()
        .from(schema.billingCleanup)
        .where(
          and(
            eq(schema.billingCleanup.id, id),
            inArray(schema.billingCleanup.status, ["pending", "retry", "processing"]),
            lte(schema.billingCleanup.nextAttemptAt, now),
            or(
              sql`${schema.billingCleanup.leaseExpiresAt} IS NULL`,
              lte(schema.billingCleanup.leaseExpiresAt, now),
            ),
          ),
        )
        .for("update", { skipLocked: true });
      if (!row) return null;
      const token = randomUUID();
      await tx
        .update(schema.billingCleanup)
        .set({
          status: "processing",
          leaseToken: token,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          attempts: row.attempts + 1,
        })
        .where(eq(schema.billingCleanup.id, id));
      return { ...row, leaseToken: token };
    });
  }
  async finishCleanup(
    id: string,
    lease: string,
    status: "complete" | "retry" | "operator_action",
    code: string | null,
  ) {
    await this.db
      .update(schema.billingCleanup)
      .set({
        status,
        errorCode: code,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(this.now().getTime() + 60_000),
      })
      .where(
        and(
          eq(schema.billingCleanup.id, id),
          eq(schema.billingCleanup.leaseToken, lease),
          sql`${schema.billingCleanup.leaseExpiresAt} > ${this.now()}`,
        ),
      );
  }
  async periodicSubscriptionIds() {
    return this.db
      .select({
        subscriptionId: schema.billingSubscriptions.subscriptionId,
        revision: schema.billingSubscriptions.revision,
      })
      .from(schema.billingSubscriptions)
      .where(
        and(
          identityWhere(schema.billingSubscriptions, this.identity),
          eq(schema.billingSubscriptions.deleted, false),
        ),
      )
      .orderBy(asc(schema.billingSubscriptions.updatedAt))
      .limit(25);
  }
  async bumpAttempt(id: string, closed: boolean) {
    await this.db
      .update(schema.billingCheckoutAttempts)
      .set({
        ...(closed
          ? { status: "closed", checkoutUrl: null, leaseToken: null, leaseExpiresAt: null }
          : {}),
        nextAttemptAt: new Date(this.now().getTime() + 60_000),
      })
      .where(
        and(
          eq(schema.billingCheckoutAttempts.id, id),
          eq(schema.billingCheckoutAttempts.deleted, false),
        ),
      );
  }
  async due() {
    const now = this.now();
    const receipts = await this.db
      .select({ id: schema.billingReceipts.id })
      .from(schema.billingReceipts)
      .where(
        and(
          identityWhere(schema.billingReceipts, this.identity),
          inArray(schema.billingReceipts.status, ["pending", "retry", "processing"]),
          lte(schema.billingReceipts.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(schema.billingReceipts.nextAttemptAt))
      .limit(25);
    const attempts = await this.db
      .select({
        id: schema.billingCheckoutAttempts.id,
        status: schema.billingCheckoutAttempts.status,
        checkoutId: schema.billingCheckoutAttempts.checkoutId,
      })
      .from(schema.billingCheckoutAttempts)
      .where(
        and(
          identityWhere(schema.billingCheckoutAttempts, this.identity),
          eq(schema.billingCheckoutAttempts.deleted, false),
          inArray(schema.billingCheckoutAttempts.status, ["pending", "ready"]),
          lte(schema.billingCheckoutAttempts.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(schema.billingCheckoutAttempts.nextAttemptAt))
      .limit(25);
    const cleanup = await this.db
      .select({ id: schema.billingCleanup.id })
      .from(schema.billingCleanup)
      .where(
        and(
          inArray(schema.billingCleanup.status, ["pending", "retry", "processing"]),
          lte(schema.billingCleanup.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(schema.billingCleanup.nextAttemptAt))
      .limit(25);
    return { receipts, attempts, cleanup };
  }
}
