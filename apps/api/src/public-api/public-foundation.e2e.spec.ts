import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
import { RateLimiterPostgres } from "rate-limiter-flexible";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("public foundation native contracts", () => {
  let connection: ReturnType<typeof createDb>;
  const orgId = `public-foundation-${randomUUID()}`;
  let brandId: string, channelId: string, keyId: string;
  beforeAll(async () => {
    if (!url) throw new Error("Native fixture requires TEST_DATABASE_URL");
    connection = createDb(url);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Fixture", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Fixture" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing fixture brand");
    brandId = brand.id;
    const [channel] = await connection.db
      .insert(schema.channels)
      .values({ orgId, brandId, platform: "t_j", name: "Fixture", credentialsEncrypted: null })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing fixture channel");
    channelId = channel.id;
    const [key] = await connection.db
      .insert(schema.organizationApiKeys)
      .values({
        orgId,
        name: "Write",
        prefix: randomUUID(),
        keyHash: randomUUID(),
        scope: "content:create",
      })
      .returning({ id: schema.organizationApiKeys.id });
    if (!key) throw new Error("Missing fixture key");
    keyId = key.id;
  });
  afterAll(async () => {
    await connection?.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await connection?.pool.end();
  });
  it("uses the maintained PostgreSQL adapter against the migration-owned three-column table", async () => {
    const limiter = new RateLimiterPostgres({
      storeClient: connection.pool,
      storeType: "pool",
      tableName: "api_request_limits",
      tableCreated: true,
      clearExpiredByTimeout: false,
      points: 2,
      duration: 60,
      keyPrefix: orgId,
    });
    expect((await limiter.consume("fixture")).remainingPoints).toBe(1);
    expect((await limiter.consume("fixture")).remainingPoints).toBe(0);
    await expect(limiter.consume("fixture")).rejects.toMatchObject({ remainingPoints: 0 });
    await limiter.delete("fixture");
  });
  it("requires exact server operation and tenant-owned targets even with a valid write key", async () => {
    const actor = {
      kind: "api-key",
      orgId,
      keyId,
      scope: "content:create",
      operation: "content:create",
    } as const;
    const expected = { operation: "content:create", brandId, channelIds: [channelId] } as const;
    const check = (target?: Parameters<typeof authorizeRequestActor>[2]) =>
      runWithRequestAuthority(actor, () =>
        connection.db.transaction(async (tx) => authorizeRequestActor(tx, orgId, target)),
      );
    expect(await check()).toBe(false);
    expect(await check({ ...expected, operation: "generation:create" })).toBe(false);
    expect(await check({ ...expected, channelIds: [randomUUID()] })).toBe(false);
    expect(await check(expected)).toBe(true);
    await connection.db
      .update(schema.organizationApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.organizationApiKeys.id, keyId));
    expect(await check(expected)).toBe(false);
  });
  it("retains replay audit IDs after key/result removal and rejects absent paid consent", async () => {
    const data = {
      orgId,
      operation: "generation:create" as const,
      keyId,
      idempotencyKey: "fixture.replay-1",
      requestHash: "a".repeat(64),
      hashVersion: "parsed-dto-v1",
      resultId: randomUUID(),
    };
    await expect(
      connection.db.insert(schema.publicApiOperations).values(data),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "public_api_operations_consent_check" },
    });
    await connection.db
      .insert(schema.publicApiOperations)
      .values({ ...data, consentVersion: "byok-paid-generation-v1" });
    await connection.db
      .delete(schema.organizationApiKeys)
      .where(eq(schema.organizationApiKeys.id, keyId));
    const [audit] = await connection.db
      .select({
        keyId: schema.publicApiOperations.keyId,
        resultId: schema.publicApiOperations.resultId,
      })
      .from(schema.publicApiOperations)
      .where(eq(schema.publicApiOperations.orgId, orgId));
    expect(audit).toEqual({ keyId, resultId: data.resultId });
    await expect(
      connection.db
        .update(schema.publicApiOperations)
        .set({ resultId: randomUUID() })
        .where(eq(schema.publicApiOperations.orgId, orgId)),
    ).rejects.toThrow();
  });
  it("preserves the imported opening obligation across origin changes", async () => {
    const [item] = await connection.db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId,
        body: "Imported",
        origin: "external",
        requiresImportedReview: true,
      })
      .returning({ id: schema.contentItems.id });
    if (!item) throw new Error("Missing imported fixture");
    await connection.db
      .update(schema.contentItems)
      .set({ origin: "human" })
      .where(eq(schema.contentItems.id, item.id));
    await expect(
      connection.db
        .update(schema.contentItems)
        .set({ requiresImportedReview: false })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, item.id))),
    ).rejects.toThrow();
    await expect(
      connection.db
        .insert(schema.contentItems)
        .values({ orgId, brandId, body: "Imported", origin: "external" }),
    ).rejects.toThrow();
  });
});
