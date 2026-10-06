import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { linkedinPublisher } from "@pubrick/integrations";
import { encryptJson } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const key = process.env.APP_ENCRYPTION_KEY ?? "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
const application = { clientId: "fixture-client", clientSecret: "fixture-application-secret" };
const credentials = {
  accessToken: "fixture-token",
  authorUrn: "urn:li:person:fixture",
  scopes: "openid profile w_member_social",
  expiresAt: "2099-01-01T00:00:00Z",
};
describe.skipIf(!url)("LinkedIn health uses the server application", () => {
  let direct: ReturnType<typeof createDb>;
  let service: import("./channel-health.service").ChannelHealthService;
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.APP_ENCRYPTION_KEY ??= key;
    vi.stubEnv("LINKEDIN_CLIENT_ID", application.clientId);
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", application.clientSecret);
    const { ChannelHealthService } = await import("./channel-health.service");
    service = new ChannelHealthService();
    direct = createDb(url as string);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (direct) await direct.pool.end();
    vi.unstubAllEnvs();
  });
  async function fixture() {
    const orgId = randomUUID();
    await direct.db
      .insert(schema.organization)
      .values({ id: orgId, name: "LinkedIn health", slug: orgId });
    const [brand] = await direct.db
      .insert(schema.brands)
      .values({ orgId, name: "Personal" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("brand missing");
    const [channel] = await direct.db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "LinkedIn",
        platform: "linkedin",
        credentialsEncrypted: encryptJson(credentials, key),
        connectionTarget: credentials.authorUrn,
        connectionExpiresAt: new Date(credentials.expiresAt),
      })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("channel missing");
    return { orgId, id: channel.id };
  }
  it("passes confidential application credentials to the grant proof, without returning them", async () => {
    const row = await fixture();
    const verify = vi
      .spyOn(linkedinPublisher, "verify")
      .mockResolvedValue({ ok: true, account: "Fixture Writer", target: credentials.authorUrn });
    expect(await service.scan(row.orgId)).toBe(1);
    expect(verify).toHaveBeenCalledWith(credentials, { baseUrl: undefined, linkedin: application });
    const [saved] = await direct.db
      .select({ ok: schema.channels.healthOk })
      .from(schema.channels)
      .where(eq(schema.channels.id, row.id));
    expect(saved?.ok).toBe(true);
  });
  it("does not restore a verdict after disconnect during provider wait", async () => {
    const row = await fixture();
    vi.spyOn(linkedinPublisher, "verify").mockImplementation(async () => {
      await direct.db
        .update(schema.channels)
        .set({
          credentialsEncrypted: null,
          connectionGeneration: 1,
          healthOk: null,
          healthCheckedAt: null,
        })
        .where(eq(schema.channels.id, row.id));
      return { ok: true, account: "Fixture Writer", target: credentials.authorUrn };
    });
    expect(await service.scan(row.orgId)).toBe(1);
    const [saved] = await direct.db
      .select({ ok: schema.channels.healthOk, checkedAt: schema.channels.healthCheckedAt })
      .from(schema.channels)
      .where(eq(schema.channels.id, row.id));
    expect(saved).toEqual({ ok: null, checkedAt: null });
  });
});
