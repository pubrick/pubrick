import { createHash, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { linkedinPublisher } from "@pubrick/integrations";
import { decryptJson, linkedinConnectionSchema } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  LinkedInOAuthClient,
  LinkedInOAuthClientError,
  type LinkedInOAuthConnection,
} from "./linkedin-oauth-client";

// Only the operator callback origin is a fixture. The pure configuration tests
// prove the production HTTPS constraint; auth here keeps ordinary local cookies.
vi.mock("./linkedin-runtime-config", () => ({
  linkedinRuntimeConfiguration: (application: unknown) =>
    application
      ? { application, redirectUri: "https://pubrick.example.com/en/connections/linkedin" }
      : undefined,
}));
const url = process.env.TEST_DATABASE_URL;
const key = process.env.APP_ENCRYPTION_KEY ?? "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
const application = { clientId: "fixture-linked-app", clientSecret: "fixture-linked-secret" };
const authorUrn = "urn:li:person:fixture_writer";
function grant(token = "fixture-access-token", target = authorUrn): LinkedInOAuthConnection {
  return {
    credentials: {
      accessToken: token,
      refreshToken: "fixture-refresh-token",
      authorUrn: target,
      scopes: "openid profile w_member_social",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshExpiresAt: "2099-01-01T00:00:00Z",
    },
    account: "Fixture Writer",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!url)("LinkedIn connection lifecycle (real database, fixture provider)", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;
  let exchange: MockInstance<LinkedInOAuthClient["exchange"]>;
  let verify: MockInstance<typeof linkedinPublisher.verify>;
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= key;
    vi.stubEnv("LINKEDIN_CLIENT_ID", application.clientId);
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", application.clientSecret);
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    direct = createDb(url as string);
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    // Spies stop at the external provider boundary, never a repository or guard.
    exchange = vi.spyOn(LinkedInOAuthClient.prototype, "exchange").mockResolvedValue(grant());
    verify = vi.spyOn(linkedinPublisher, "verify").mockImplementation(async (credentials) => ({
      ok: true,
      account: "Fixture Writer",
      target: credentials.authorUrn,
    }));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
    if (direct) await direct.pool.end();
    vi.unstubAllEnvs();
  });
  async function owner() {
    const agent = request.agent(app.getHttpServer());
    const uniq = randomUUID();
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `linkedin-${uniq}@example.com`, password: "password1234", name: "Writer" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "LinkedIn fixture", slug: `linkedin-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Writing" }).expect(201);
    return {
      agent,
      orgId: org.body.id as string,
      userId: signup.body.user.id as string,
      brandId: brand.body.id as string,
    };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;
  async function begin(row: Owner, channelId?: string, generation?: number) {
    const body = {
      brandId: row.brandId,
      name: "Personal writing",
      locale: "ru",
      ...(channelId ? { channelId, expectedGeneration: generation } : {}),
    };
    const result = await row.agent.post("/api/channels/linkedin/authorize").send(body).expect(200);
    const provider = new URL(result.body.authorizationUrl);
    const state = provider.searchParams.get("state");
    const nonce = provider.searchParams.get("nonce");
    if (!state || !nonce) throw new Error("fixture authorization missing state/nonce");
    return { state, nonce, parameters: `state=${state}&code=fixture-code`, result };
  }
  async function complete(row: Owner, started: { parameters: string }, status = 200) {
    return row.agent
      .post("/api/channels/linkedin/complete")
      .send({ parameters: started.parameters })
      .expect(status);
  }
  async function connected() {
    const row = await owner();
    const started = await begin(row);
    const result = await complete(row, started);
    return { ...row, channelId: result.body.channelId as string };
  }
  async function stored(row: Owner, channelId: string) {
    const [channel] = await direct.db
      .select({
        ciphertext: schema.channels.credentialsEncrypted,
        generation: schema.channels.connectionGeneration,
        target: schema.channels.connectionTarget,
        disconnectedAt: schema.channels.connectionDisconnectedAt,
      })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, row.orgId), eq(schema.channels.id, channelId)));
    if (!channel) throw new Error("fixture channel missing");
    return channel;
  }
  async function channels(row: Owner) {
    return (await row.agent.get(`/api/channels?brandId=${row.brandId}`).expect(200)).body;
  }

  it("reports configuration without exposing application secrets and refuses pasted token creation", async () => {
    const row = await owner();
    const config = await row.agent
      .get(`/api/channels/linkedin/configuration?brandId=${row.brandId}`)
      .expect(200);
    expect(config.body).toEqual({ available: true });
    await row.agent
      .post("/api/channels")
      .send({
        brandId: row.brandId,
        name: "Forged",
        platform: "linkedin",
        credentials: grant().credentials,
      })
      .expect(400);
    expect(await channels(row)).toEqual([]);
    expect(exchange).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
  it("persists hashed state and encrypted nonce before redirect, then encrypts the complete proven token bag", async () => {
    const row = await owner();
    const started = await begin(row);
    expect(Object.keys(started.result.body)).toEqual(["authorizationUrl"]);
    const [state] = await direct.db
      .select({
        hash: schema.linkedinAuthorizationRequests.stateHash,
        nonce: schema.linkedinAuthorizationRequests.nonceEncrypted,
        userId: schema.linkedinAuthorizationRequests.userId,
        expiresAt: schema.linkedinAuthorizationRequests.expiresAt,
        createdAt: schema.linkedinAuthorizationRequests.createdAt,
      })
      .from(schema.linkedinAuthorizationRequests)
      .where(eq(schema.linkedinAuthorizationRequests.orgId, row.orgId));
    expect(state?.hash).toBe(createHash("sha256").update(started.state).digest("hex"));
    expect(state?.hash).not.toBe(started.state);
    expect(state?.nonce).not.toContain(started.nonce);
    expect(decryptJson(state?.nonce as string, key)).toEqual({ nonce: started.nonce });
    expect(state?.userId).toBe(row.userId);
    expect((state?.expiresAt.getTime() as number) - (state?.createdAt.getTime() as number)).toBe(
      600_000,
    );
    expect(await channels(row)).toEqual([]);
    const result = await complete(row, started);
    expect(result.body).toEqual({
      brandId: row.brandId,
      channelId: expect.any(String),
      locale: "ru",
    });
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedState: started.state,
        expectedNonce: started.nonce,
        redirectUri: "https://pubrick.example.com/en/connections/linkedin",
      }),
    );
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "fixture-access-token",
        refreshToken: "fixture-refresh-token",
        authorUrn,
      }),
      { linkedin: application },
    );
    const saved = await stored(row, result.body.channelId);
    expect(saved.target).toBe(authorUrn);
    expect(saved.generation).toBe(1);
    const bag = decryptJson(saved.ciphertext as string, key);
    expect(bag).toMatchObject({
      accessToken: "fixture-access-token",
      refreshToken: "fixture-refresh-token",
      authorUrn,
      scopes: "openid profile w_member_social",
    });
    const list = await channels(row);
    expect(linkedinConnectionSchema.parse(list[0].connection)).toMatchObject({
      state: "connected",
      generation: 1,
      account: "Fixture Writer",
    });
    const serialized = JSON.stringify(list);
    for (const secret of [
      "fixture-access-token",
      "fixture-refresh-token",
      application.clientSecret,
      started.state,
      started.nonce,
    ])
      expect(serialized).not.toContain(secret);
    expect(
      await direct.db
        .select({ id: schema.linkedinAuthorizationRequests.id })
        .from(schema.linkedinAuthorizationRequests)
        .where(eq(schema.linkedinAuthorizationRequests.orgId, row.orgId)),
    ).toEqual([]);
  });
  it("passes duplicate code values intact to the library but refuses duplicate state before consumption", async () => {
    const row = await owner();
    const started = await begin(row);
    const doubled = `${started.parameters}&state=${started.state}`;
    const refused = await complete(row, { parameters: doubled }, 409);
    expect(refused.body.code).toBe("linkedin_authorization_invalid");
    expect(exchange).not.toHaveBeenCalled();
    await complete(row, { parameters: `${started.parameters}&code=second` });
    expect(exchange.mock.calls[0]?.[0].parameters.getAll("code")).toEqual([
      "fixture-code",
      "second",
    ]);
  });
  it("consumes a request before exchange and refuses replay after successful completion", async () => {
    const row = await owner();
    const started = await begin(row);
    exchange.mockImplementationOnce(async () => {
      const [state] = await direct.db
        .select({ consumedAt: schema.linkedinAuthorizationRequests.consumedAt })
        .from(schema.linkedinAuthorizationRequests)
        .where(eq(schema.linkedinAuthorizationRequests.orgId, row.orgId));
      expect(state?.consumedAt).toBeInstanceOf(Date);
      return grant();
    });
    await complete(row, started);
    const replay = await complete(row, started, 409);
    expect(replay.body.code).toBe("linkedin_authorization_invalid");
    expect(exchange).toHaveBeenCalledOnce();
    expect(await channels(row)).toHaveLength(1);
  });
  it("does not replay a code after an interrupted exchange", async () => {
    const row = await owner();
    const started = await begin(row);
    exchange.mockRejectedValueOnce(new LinkedInOAuthClientError("unavailable"));
    const first = await complete(row, started, 503);
    expect(first.body.code).toBe("linkedin_authorization_unavailable");
    await complete(row, started, 409);
    expect(exchange).toHaveBeenCalledOnce();
    expect(await channels(row)).toEqual([]);
  });
  it.each([
    { ok: false, reason: "publishing grant absent" } as const,
    { ok: true, account: "Other Writer", target: "urn:li:person:other_writer" } as const,
  ])("does not retain an identity without matching publishing proof %j", async (proof) => {
    const row = await owner();
    const started = await begin(row);
    verify.mockResolvedValueOnce(proof);
    const result = await complete(row, started, 400);
    expect(result.body.code).toBe("linkedin_authorization_failed");
    expect(await channels(row)).toEqual([]);
  });
  it("reports indeterminate permission without retaining a healthy connection", async () => {
    const row = await owner();
    const started = await begin(row);
    verify.mockResolvedValueOnce({
      ok: false,
      indeterminate: true,
      reason: "fixture provider unavailable",
    });
    const result = await complete(row, started, 503);
    expect(result.body.code).toBe("linkedin_authorization_unavailable");
    expect(await channels(row)).toEqual([]);
  });
  it("binds state to the organization and rejects an unexpired foreign state before exchange", async () => {
    const row = await owner();
    const started = await begin(row);
    const other = await owner();
    const result = await complete(other, started, 409);
    expect(result.body.code).toBe("linkedin_authorization_invalid");
    expect(exchange).not.toHaveBeenCalled();
    await complete(row, started);
    expect(exchange).toHaveBeenCalledOnce();
  });
  it("binds otherwise valid state to the exact acting session", async () => {
    const row = await owner();
    const started = await begin(row);
    const alternate = request.agent(app.getHttpServer());
    const [user] = await direct.db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, row.userId));
    if (!user) throw new Error("fixture user missing");
    await alternate
      .post("/api/auth/sign-in/email")
      .send({ email: user.email, password: "password1234" })
      .expect(200);
    await alternate
      .post("/api/auth/organization/set-active")
      .send({ organizationId: row.orgId })
      .expect(200);
    const result = await alternate
      .post("/api/channels/linkedin/complete")
      .send({ parameters: started.parameters })
      .expect(409);
    expect(result.body.code).toBe("linkedin_authorization_invalid");
    expect(exchange).not.toHaveBeenCalled();
    await complete(row, started);
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("refuses expired state with all other bindings still valid", async () => {
    const row = await owner();
    const started = await begin(row);
    const clock = Date.now();
    await direct.db
      .update(schema.linkedinAuthorizationRequests)
      .set({ createdAt: new Date(clock - 700_000), expiresAt: new Date(clock - 100_000) })
      .where(eq(schema.linkedinAuthorizationRequests.orgId, row.orgId));
    const result = await complete(row, started, 409);
    expect(result.body.code).toBe("linkedin_authorization_invalid");
    expect(exchange).not.toHaveBeenCalled();
  });
  it.each(["role", "session", "active-organization"] as const)(
    "rechecks %s after provider wait before retaining credentials",
    async (change) => {
      const row = await owner();
      const started = await begin(row);
      const entered = deferred<void>();
      const response = deferred<LinkedInOAuthConnection>();
      exchange.mockImplementationOnce(() => {
        entered.resolve();
        return response.promise;
      });
      const pending = row.agent
        .post("/api/channels/linkedin/complete")
        .send({ parameters: started.parameters })
        .then((value) => value);
      await entered.promise;
      if (change === "role")
        await direct.db
          .update(schema.member)
          .set({ role: "member" })
          .where(
            and(eq(schema.member.organizationId, row.orgId), eq(schema.member.userId, row.userId)),
          );
      if (change === "session")
        await direct.db
          .update(schema.session)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(
            and(
              eq(schema.session.userId, row.userId),
              eq(schema.session.activeOrganizationId, row.orgId),
            ),
          );
      if (change === "active-organization")
        await direct.db
          .update(schema.session)
          .set({ activeOrganizationId: null })
          .where(
            and(
              eq(schema.session.userId, row.userId),
              eq(schema.session.activeOrganizationId, row.orgId),
            ),
          );
      response.resolve(grant());
      const result = await pending;
      expect(result.status).toBe(403);
      expect(result.body.code).toBe("linkedin_authority_changed");
      const saved = await direct.db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.orgId, row.orgId));
      expect(saved).toEqual([]);
    },
  );
  it("does not change a reconnect destination to another personal account", async () => {
    const row = await connected();
    const before = await stored(row, row.channelId);
    const started = await begin(row, row.channelId, 1);
    exchange.mockResolvedValueOnce(grant("fixture-other-token", "urn:li:person:other_writer"));
    const result = await complete(row, started, 409);
    expect(result.body.code).toBe("channel_target_changed");
    expect(await stored(row, row.channelId)).toEqual(before);
  });
  it("does not let an earlier callback overwrite a disconnect performed during exchange", async () => {
    const row = await connected();
    const started = await begin(row, row.channelId, 1);
    const entered = deferred<void>();
    const response = deferred<LinkedInOAuthConnection>();
    exchange.mockImplementationOnce(() => {
      entered.resolve();
      return response.promise;
    });
    const pending = row.agent
      .post("/api/channels/linkedin/complete")
      .send({ parameters: started.parameters })
      .then((value) => value);
    await entered.promise;
    await row.agent
      .post(`/api/channels/linkedin/${row.channelId}/disconnect`)
      .send({ expectedGeneration: 1 })
      .expect(204);
    response.resolve(grant("fixture-new-token"));
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("linkedin_connection_changed");
    expect(await stored(row, row.channelId)).toMatchObject({
      ciphertext: null,
      generation: 2,
      target: authorUrn,
    });
    expect((await channels(row))[0].connection.state).toBe("disconnected");
  });
  it("preserves scheduled work and receipts when reconnecting and disconnecting", async () => {
    const row = await connected();
    const content = await row.agent
      .post("/api/content")
      .send({
        brandId: row.brandId,
        body: "Reviewed writing to publish later.",
        title: "Writing",
        channelIds: [row.channelId],
      })
      .expect(201);
    await row.agent
      .post(`/api/content/${content.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })
      .expect(200);
    const adaptationId = content.body.adaptations[0].id as string;
    const [historicalItem] = await direct.db
      .insert(schema.contentItems)
      .values({
        orgId: row.orgId,
        brandId: row.brandId,
        body: "Previously published text",
        status: "published",
        origin: "human",
      })
      .returning({ id: schema.contentItems.id });
    if (!historicalItem) throw new Error("fixture historical item missing");
    const [historicalAdaptation] = await direct.db
      .insert(schema.adaptations)
      .values({
        orgId: row.orgId,
        contentItemId: historicalItem.id,
        channelId: row.channelId,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!historicalAdaptation) throw new Error("fixture historical adaptation missing");
    const [historicalReceipt] = await direct.db
      .insert(schema.publications)
      .values({
        orgId: row.orgId,
        adaptationId: historicalAdaptation.id,
        channelId: row.channelId,
        status: "published",
        externalId: "urn:li:share:123456789",
        externalUrl: "https://www.linkedin.com/feed/update/urn:li:share:123456789/",
      })
      .returning({ id: schema.publications.id });
    if (!historicalReceipt) throw new Error("fixture historical receipt missing");
    const receiptsBefore = await direct.db.execute(
      sql`select id, status, external_id, external_url, adaptation_id, channel_id from publications where org_id = ${row.orgId} and id = ${historicalReceipt.id}`,
    );
    const before = await direct.db.execute(
      sql`select id, status, scheduled_at from adaptations where org_id = ${row.orgId} and id = ${adaptationId}`,
    );
    const jobsBefore = await direct.db.execute(
      sql`select id, state, start_after from pgboss.job where name = 'publish' and data->>'orgId' = ${row.orgId} and data->>'adaptationId' = ${adaptationId}`,
    );
    expect(jobsBefore.rows).toHaveLength(1);
    const started = await begin(row, row.channelId, 1);
    exchange.mockResolvedValueOnce(grant("fixture-renewed-token"));
    await complete(row, started);
    const renewed = await stored(row, row.channelId);
    expect(renewed.generation).toBe(2);
    expect(decryptJson<Record<string, string>>(renewed.ciphertext as string, key).accessToken).toBe(
      "fixture-renewed-token",
    );
    await row.agent
      .post(`/api/channels/linkedin/${row.channelId}/disconnect`)
      .send({ expectedGeneration: 2 })
      .expect(204);
    const after = await direct.db.execute(
      sql`select id, status, scheduled_at from adaptations where org_id = ${row.orgId} and id = ${adaptationId}`,
    );
    const jobsAfter = await direct.db.execute(
      sql`select id, state, start_after from pgboss.job where name = 'publish' and data->>'orgId' = ${row.orgId} and data->>'adaptationId' = ${adaptationId}`,
    );
    expect(after.rows).toEqual(before.rows);
    expect(jobsAfter.rows).toEqual(jobsBefore.rows);
    const receiptsAfter = await direct.db.execute(
      sql`select id, status, external_id, external_url, adaptation_id, channel_id from publications where org_id = ${row.orgId} and id = ${historicalReceipt.id}`,
    );
    expect(receiptsAfter.rows).toEqual(receiptsBefore.rows);
    const verifyResult = await row.agent.post(`/api/channels/${row.channelId}/test`).expect(409);
    expect(verifyResult.body.code).toBe("linkedin_reconnect_required");
  });
  it("rejects direct credential rotation while allowing a name change", async () => {
    const row = await connected();
    const before = await stored(row, row.channelId);
    const result = await row.agent
      .patch(`/api/channels/${row.channelId}`)
      .send({ credentials: grant("fixture-forged-token").credentials })
      .expect(409);
    expect(result.body.code).toBe("linkedin_oauth_required");
    await row.agent.patch(`/api/channels/${row.channelId}`).send({ name: "New name" }).expect(200);
    expect(await stored(row, row.channelId)).toEqual(before);
  });
  it("reports expired access using database time and refuses verification", async () => {
    const row = await connected();
    await direct.db
      .update(schema.channels)
      .set({ connectionExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.channels.id, row.channelId));
    expect((await channels(row))[0].connection.state).toBe("expired");
    const before = verify.mock.calls.length;
    const result = await row.agent.post(`/api/channels/${row.channelId}/test`).expect(409);
    expect(result.body.code).toBe("linkedin_reconnect_required");
    expect(verify).toHaveBeenCalledTimes(before);
  });
});
