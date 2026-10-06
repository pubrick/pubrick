import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const key = process.env.APP_ENCRYPTION_KEY ?? "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
const credentials = {
  accessToken: "fixture-token",
  authorUrn: "urn:li:person:fixture_writer",
  scopes: "openid profile w_member_social",
  expiresAt: "2099-01-01T00:00:00Z",
};
describe.skipIf(!url)("LinkedIn final connection/send claim fence (real database)", () => {
  let direct: ReturnType<typeof createDb>;
  let repo: import("./publish.repository").PublishRepository;
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.APP_ENCRYPTION_KEY ??= key;
    const { PublishRepository } = await import("./publish.repository");
    repo = new PublishRepository();
    direct = createDb(url as string);
  });
  afterAll(async () => {
    if (direct) await direct.pool.end();
  });
  async function fixture() {
    const orgId = randomUUID();
    await direct.db
      .insert(schema.organization)
      .values({ id: orgId, name: "LinkedIn worker", slug: orgId });
    const [brand] = await direct.db
      .insert(schema.brands)
      .values({ orgId, name: "Personal" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("fixture brand missing");
    const [channel] = await direct.db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "Personal",
        platform: "linkedin",
        connectionTarget: credentials.authorUrn,
        connectionGeneration: 3,
        connectionExpiresAt: new Date(credentials.expiresAt),
        credentialsEncrypted: encryptJson(credentials, key),
      })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("fixture channel missing");
    const [item] = await direct.db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId: brand.id,
        origin: "human",
        body: "Reviewed text",
        status: "approved",
      })
      .returning({ id: schema.contentItems.id });
    if (!item) throw new Error("fixture content missing");
    const [adaptation] = await direct.db
      .insert(schema.adaptations)
      .values({
        orgId,
        contentItemId: item.id,
        channelId: channel.id,
        status: "queued",
      })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("fixture adaptation missing");
    const attempt = await repo.markPublishing(orgId, adaptation.id, null);
    if (attempt === null) throw new Error("fixture attempt missing");
    const claim = await repo.claimSend(orgId, adaptation.id, attempt);
    if (!claim) throw new Error("fixture send claim missing");
    return { orgId, channelId: channel.id, adaptationId: adaptation.id, claim };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const current = (row: Fixture) =>
    repo.linkedInSendCurrent(
      row.orgId,
      row.channelId,
      3,
      credentials.authorUrn,
      row.adaptationId,
      row.claim,
    );
  it("reads the exact encrypted bag and generation together and accepts the active matching send", async () => {
    const row = await fixture();
    expect(await repo.managedCredentialSnapshot(row.orgId, row.channelId)).toEqual({
      credentials,
      generation: 3,
      target: credentials.authorUrn,
    });
    expect(await current(row)).toBe(true);
  });
  it.each(["disconnect", "generation", "expiration", "destination", "attempt", "claim"] as const)(
    "refuses %s changed after preflight with other predicates intact",
    async (change) => {
      const row = await fixture();
      expect(await current(row)).toBe(true);
      if (change === "disconnect")
        await direct.db
          .update(schema.channels)
          .set({ credentialsEncrypted: null })
          .where(eq(schema.channels.id, row.channelId));
      if (change === "generation")
        await direct.db
          .update(schema.channels)
          .set({ connectionGeneration: 4 })
          .where(eq(schema.channels.id, row.channelId));
      if (change === "expiration")
        await direct.db
          .update(schema.channels)
          .set({ connectionExpiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.channels.id, row.channelId));
      if (change === "destination")
        await direct.db
          .update(schema.channels)
          .set({ connectionTarget: "urn:li:person:other_writer" })
          .where(eq(schema.channels.id, row.channelId));
      if (change === "attempt")
        await direct.db
          .update(schema.adaptations)
          .set({ attemptCount: 2 })
          .where(eq(schema.adaptations.id, row.adaptationId));
      if (change === "claim")
        await direct.db
          .delete(schema.publications)
          .where(
            and(eq(schema.publications.orgId, row.orgId), eq(schema.publications.id, row.claim.id)),
          );
      expect(await current(row)).toBe(false);
    },
  );
  it("never loads another organization's credentials or permits its send claim", async () => {
    const row = await fixture();
    const otherOrg = randomUUID();
    await expect(repo.managedCredentialSnapshot(otherOrg, row.channelId)).rejects.toThrow(
      "no longer exists",
    );
    expect(
      await repo.linkedInSendCurrent(
        otherOrg,
        row.channelId,
        3,
        credentials.authorUrn,
        row.adaptationId,
        row.claim,
      ),
    ).toBe(false);
  });
  it("does not read locally disconnected credentials", async () => {
    const row = await fixture();
    await direct.db
      .update(schema.channels)
      .set({ credentialsEncrypted: null })
      .where(eq(schema.channels.id, row.channelId));
    await expect(repo.managedCredentialSnapshot(row.orgId, row.channelId)).rejects.toThrow(
      "disconnected",
    );
  });
});
