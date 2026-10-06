import { createHash, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  facebookPagePublisher,
  instagramNativeStagedPublisher,
  threadsStagedPublisher,
} from "@pubrick/integrations";
import {
  decryptJson,
  META_CONNECTION_PROVIDERS,
  type MetaApplicationCredentials,
  type MetaConnectionProvider,
  metaAuthorizationCompletedSchema,
} from "@pubrick/shared";
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
import { runWithRequestAuthority } from "../request-authority";
import {
  MetaAccountClient,
  type MetaAccountConnection,
  type MetaPageDiscovery,
} from "./meta-account-client";
import type { MetaConnectionsRepository as RepositoryConstructor } from "./meta-connections.repository";
import { MetaOAuthClient, MetaOAuthClientError } from "./meta-oauth-client";

const operator = vi.hoisted(() => ({ origin: "https://pubrick.example.com" }));
// Only callback routing is a fixture. Runtime-configuration unit tests own the production HTTPS rules.
vi.mock("./meta-runtime-config", () => ({
  metaRuntimeConfiguration: (provider: string, application: unknown) =>
    application
      ? { provider, application, redirectUri: `${operator.origin}/en/connections/meta/${provider}` }
      : undefined,
}));
const url = process.env.TEST_DATABASE_URL;
const applicationName = `meta-connections-${randomUUID()}`;
const key = process.env.APP_ENCRYPTION_KEY ?? "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
const applications: Record<MetaConnectionProvider, MetaApplicationCredentials> = {
  threads: { clientId: "123456", clientSecret: "synthetic-threads-application-secret" },
  instagram_native: { clientId: "123457", clientSecret: "synthetic-instagram-application-secret" },
  facebook_page: { clientId: "123458", clientSecret: "synthetic-facebook-application-secret" },
};
function grant(
  provider: MetaConnectionProvider = "threads",
  token = "synthetic-long-token",
  id = "654321",
): MetaAccountConnection {
  const prefix =
    provider === "facebook_page"
      ? "facebook-page"
      : provider === "instagram_native"
        ? "instagram"
        : "threads";
  return {
    credentials: {
      accessToken: token,
      ...(provider === "facebook_page"
        ? { pageId: id, userAccessToken: "synthetic-user-token" }
        : { accountId: id }),
      scopes:
        provider === "facebook_page"
          ? "pages_manage_posts pages_read_engagement pages_show_list"
          : provider === "instagram_native"
            ? "instagram_business_basic instagram_business_content_publish"
            : "threads_basic threads_content_publish",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    account: `Studio ${id}`,
    target: `${prefix}:${id}`,
    applicationId: applications[provider].clientId,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function row<T>(value: T | undefined): T {
  if (!value) throw new Error("Expected retained fixture row");
  return value;
}

describe.skipIf(!url)("Meta managed connections (real database, fixture provider)", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;
  let connections: InstanceType<typeof RepositoryConstructor>;
  let activeApplications: Record<MetaConnectionProvider, MetaApplicationCredentials | undefined>;
  let exchange: MockInstance<MetaOAuthClient["exchange"]>;
  let connect: MockInstance<MetaAccountClient["connect"]>;
  let threadsVerify: MockInstance<typeof threadsStagedPublisher.verify>;
  let instagramVerify: MockInstance<typeof instagramNativeStagedPublisher.verify>;
  let facebookVerify: MockInstance<typeof facebookPagePublisher.verify>;
  beforeAll(async () => {
    const scopedUrl = new URL(url as string);
    scopedUrl.searchParams.set("application_name", applicationName);
    process.env.DATABASE_URL = scopedUrl.toString();
    process.env.APP_ENCRYPTION_KEY ??= key;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    for (const [prefix, provider] of [
      ["THREADS", "threads"],
      ["INSTAGRAM", "instagram_native"],
      ["FACEBOOK", "facebook_page"],
    ] as const) {
      vi.stubEnv(`${prefix}_CLIENT_ID`, applications[provider].clientId);
      vi.stubEnv(`${prefix}_CLIENT_SECRET`, applications[provider].clientSecret);
    }
    const [{ AppModule }, { metaApplications }] = await Promise.all([
      import("../app.module"),
      import("../env"),
    ]);
    activeApplications = metaApplications;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    const { MetaConnectionsRepository } = await import("./meta-connections.repository");
    connections = app.get(MetaConnectionsRepository);
    direct = createDb(url as string);
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    operator.origin = "https://pubrick.example.com";
    for (const provider of META_CONNECTION_PROVIDERS)
      activeApplications[provider] = { ...applications[provider] };
    // Fixtures stop only at external provider exchange/identity/verification, never repositories or permission guards.
    exchange = vi
      .spyOn(MetaOAuthClient.prototype, "exchange")
      .mockResolvedValue({ accessToken: "synthetic-short-token", scopes: "" });
    connect = vi.spyOn(MetaAccountClient.prototype, "connect").mockResolvedValue(grant());
    threadsVerify = vi
      .spyOn(threadsStagedPublisher, "verify")
      .mockImplementation(async (credentials) => ({
        ok: true,
        account: "Studio",
        target: `threads:${credentials.accountId}`,
      }));
    instagramVerify = vi
      .spyOn(instagramNativeStagedPublisher, "verify")
      .mockImplementation(async (credentials) => ({
        ok: true,
        account: "Studio",
        target: `instagram:${credentials.accountId}`,
      }));
    facebookVerify = vi
      .spyOn(facebookPagePublisher, "verify")
      .mockImplementation(async (credentials) => ({
        ok: true,
        account: `Studio ${credentials.pageId}`,
        target: `facebook-page:${credentials.pageId}`,
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
      .send({ email: `meta-${uniq}@example.com`, password: "password1234", name: "Writer" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Meta fixture", slug: `meta-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Studio" }).expect(201);
    return {
      agent,
      orgId: org.body.id as string,
      userId: signup.body.user.id as string,
      brandId: brand.body.id as string,
    };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;
  async function begin(
    value: Owner,
    provider: MetaConnectionProvider = "threads",
    channelId?: string,
    expectedGeneration?: number,
  ) {
    const response = await value.agent
      .post("/api/channels/meta/authorize")
      .send({
        provider,
        brandId: value.brandId,
        name: "Studio connection",
        locale: "ru",
        ...(channelId ? { channelId, expectedGeneration } : {}),
      })
      .expect(200);
    const authorization = new URL(response.body.authorizationUrl);
    const state = authorization.searchParams.get("state");
    if (!state) throw new Error("Fixture authorization missing state");
    return { state, provider, parameters: `state=${state}&code=synthetic-code`, response };
  }
  async function complete(
    value: Owner,
    started: { provider: MetaConnectionProvider; parameters: string },
    status = 200,
  ) {
    return value.agent
      .post("/api/channels/meta/complete")
      .send({ provider: started.provider, parameters: started.parameters })
      .expect(status);
  }
  async function connected(provider: MetaConnectionProvider = "threads") {
    const value = await owner();
    const proved = grant(provider);
    connect.mockResolvedValueOnce(proved);
    const response = await complete(value, await begin(value, provider));
    return { ...value, channelId: response.body.channelId as string };
  }
  async function stored(value: Owner, channelId: string) {
    const [channel] = await direct.db
      .select({
        ciphertext: schema.channels.credentialsEncrypted,
        generation: schema.channels.connectionGeneration,
        target: schema.channels.connectionTarget,
        applicationId: schema.channels.connectionApplicationId,
        account: schema.channels.connectionAccount,
        scopes: schema.channels.connectionScopes,
        disconnectedAt: schema.channels.connectionDisconnectedAt,
      })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, value.orgId), eq(schema.channels.id, channelId)));
    return row(channel);
  }
  async function channels(value: Owner) {
    return (await value.agent.get(`/api/channels?brandId=${value.brandId}`).expect(200)).body;
  }
  async function pendingPages(value: Owner) {
    const started = await begin(value, "facebook_page");
    connect.mockResolvedValueOnce({
      pages: [
        grant("facebook_page", "synthetic-page-one-token", "111"),
        grant("facebook_page", "synthetic-page-two-token", "222"),
      ],
    });
    const choices = await complete(value, started);
    return { started, choices, requestId: choices.body.requestId as string };
  }
  async function select(value: Owner, requestId: string, pageId = "222", status = 200) {
    return value.agent
      .post("/api/channels/meta/select-page")
      .send({ requestId, pageId })
      .expect(status);
  }

  it("reports availability without application secrets and refuses caller credential/callback injection", async () => {
    const value = await owner();
    const configuration = await value.agent
      .get(`/api/channels/meta/configuration?brandId=${value.brandId}`)
      .expect(200);
    expect(configuration.body).toEqual({
      providers: META_CONNECTION_PROVIDERS.map((provider) => ({ provider, available: true })),
    });
    const serialized = JSON.stringify(configuration.body);
    for (const application of Object.values(applications))
      expect(serialized).not.toContain(application.clientSecret);
    await value.agent
      .post("/api/channels/meta/authorize")
      .send({
        provider: "threads",
        brandId: value.brandId,
        name: "Injected",
        locale: "en",
        redirectUri: "https://other.example",
        credentials: grant().credentials,
      })
      .expect(400);
    expect(await channels(value)).toEqual([]);
    expect(exchange).not.toHaveBeenCalled();
  });
  it.each(["threads", "instagram_native"] as const)(
    "persists hashed scoped intent and finishes exact fresh %s proof",
    async (provider) => {
      const value = await owner();
      const started = await begin(value, provider);
      expect(Object.keys(started.response.body).sort()).toEqual(["authorizationUrl", "provider"]);
      const [state] = await direct.db
        .select({
          hash: schema.metaAuthorizationRequests.stateHash,
          applicationId: schema.metaAuthorizationRequests.applicationId,
          redirectUri: schema.metaAuthorizationRequests.redirectUri,
          userId: schema.metaAuthorizationRequests.userId,
          createdAt: schema.metaAuthorizationRequests.createdAt,
          expiresAt: schema.metaAuthorizationRequests.expiresAt,
        })
        .from(schema.metaAuthorizationRequests)
        .where(eq(schema.metaAuthorizationRequests.orgId, value.orgId));
      expect(state).toMatchObject({
        hash: createHash("sha256").update(started.state).digest("hex"),
        applicationId: applications[provider].clientId,
        userId: value.userId,
        redirectUri: `https://pubrick.example.com/en/connections/meta/${provider}`,
      });
      expect(row(state).expiresAt.getTime() - row(state).createdAt.getTime()).toBe(600_000);
      const proved = grant(provider);
      connect.mockResolvedValueOnce(proved);
      const result = await complete(value, started);
      expect(provider === "threads" ? threadsVerify : instagramVerify).toHaveBeenCalledOnce();
      expect(metaAuthorizationCompletedSchema.parse(result.body)).toEqual({
        status: "connected",
        brandId: value.brandId,
        channelId: expect.any(String),
        locale: "ru",
      });
      const saved = await stored(value, result.body.channelId);
      expect(saved).toMatchObject({
        target: proved.target,
        applicationId: applications[provider].clientId,
        generation: 1,
      });
      expect(saved.ciphertext).not.toContain("synthetic-long-token");
      expect(decryptJson(saved.ciphertext as string, key)).toMatchObject(proved.credentials);
      const serialized = JSON.stringify(await channels(value));
      for (const secret of [
        "synthetic-long-token",
        "synthetic-short-token",
        applications[provider].clientSecret,
        started.state,
      ])
        expect(serialized).not.toContain(secret);
      expect(
        await direct.db
          .select({ id: schema.metaAuthorizationRequests.id })
          .from(schema.metaAuthorizationRequests)
          .where(eq(schema.metaAuthorizationRequests.orgId, value.orgId)),
      ).toEqual([]);
    },
  );
  it("consumes before exchange, preserves duplicate code for the maintained validator and refuses state replay", async () => {
    const value = await owner();
    const started = await begin(value);
    await complete(
      value,
      { ...started, parameters: `${started.parameters}&state=${started.state}` },
      409,
    );
    expect(exchange).not.toHaveBeenCalled();
    exchange.mockImplementationOnce(async (input) => {
      expect(input.parameters.getAll("code")).toEqual(["synthetic-code", "second"]);
      const [saved] = await direct.db
        .select({ consumedAt: schema.metaAuthorizationRequests.consumedAt })
        .from(schema.metaAuthorizationRequests)
        .where(eq(schema.metaAuthorizationRequests.orgId, value.orgId));
      expect(saved?.consumedAt).toBeInstanceOf(Date);
      return { accessToken: "synthetic-short-token", scopes: "" };
    });
    await complete(value, { ...started, parameters: `${started.parameters}&code=second` });
    await complete(value, started, 409);
    expect(exchange).toHaveBeenCalledOnce();
  });
  it("requires a new authorization after an interrupted provider exchange", async () => {
    const value = await owner();
    const started = await begin(value);
    exchange.mockRejectedValueOnce(new MetaOAuthClientError("unavailable"));
    expect((await complete(value, started, 503)).body.code).toBe("meta_authorization_unavailable");
    await complete(value, started, 409);
    expect(exchange).toHaveBeenCalledOnce();
    expect(await channels(value)).toEqual([]);
  });
  it("refuses cross-tenant, cross-provider and another session state before any exchange", async () => {
    const value = await owner();
    const started = await begin(value);
    await complete(await owner(), started, 409);
    await complete(value, { ...started, provider: "instagram_native" }, 409);
    const [savedUser] = await direct.db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, value.userId));
    const alternate = request.agent(app.getHttpServer());
    await alternate
      .post("/api/auth/sign-in/email")
      .send({ email: row(savedUser).email, password: "password1234" })
      .expect(200);
    await alternate
      .post("/api/auth/organization/set-active")
      .send({ organizationId: value.orgId })
      .expect(200);
    await alternate
      .post("/api/channels/meta/complete")
      .send({ provider: "threads", parameters: started.parameters })
      .expect(409);
    expect(exchange).not.toHaveBeenCalled();
    await complete(value, started);
  });
  it.each(["application", "callback"] as const)(
    "refuses changed server %s lineage before consuming a valid state",
    async (change) => {
      const value = await owner();
      const started = await begin(value);
      if (change === "application")
        activeApplications.threads = { ...applications.threads, clientId: "9999" };
      else operator.origin = "https://changed.example.com";
      await complete(value, started, 409);
      expect(exchange).not.toHaveBeenCalled();
      const [saved] = await direct.db
        .select({ consumedAt: schema.metaAuthorizationRequests.consumedAt })
        .from(schema.metaAuthorizationRequests)
        .where(eq(schema.metaAuthorizationRequests.orgId, value.orgId));
      expect(saved?.consumedAt).toBeNull();
    },
  );
  it("refuses expired state before exchange and bounds outstanding requests", async () => {
    const value = await owner();
    await begin(value);
    const [saved] = await direct.db
      .select({
        userId: schema.metaAuthorizationRequests.userId,
        sessionId: schema.metaAuthorizationRequests.sessionId,
      })
      .from(schema.metaAuthorizationRequests)
      .where(eq(schema.metaAuthorizationRequests.orgId, value.orgId));
    const createdAt = new Date();
    await direct.db.insert(schema.metaAuthorizationRequests).values(
      Array.from({ length: 99 }, () => ({
        orgId: value.orgId,
        brandId: value.brandId,
        provider: "threads" as const,
        applicationId: applications.threads.clientId,
        redirectUri: "https://pubrick.example.com/en/connections/meta/threads",
        userId: row(saved).userId,
        sessionId: row(saved).sessionId,
        stateHash: createHash("sha256").update(randomUUID()).digest("hex"),
        name: "Pending",
        locale: "en" as const,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 600_000),
      })),
    );
    const capacity = await value.agent
      .post("/api/channels/meta/authorize")
      .send({ provider: "threads", brandId: value.brandId, name: "Overflow", locale: "en" })
      .expect(409);
    expect(capacity.body.code).toBe("meta_authorization_capacity");
    // A separate owner/intent is independently expired, preserving all other bindings.
    const other = await owner();
    const expired = await begin(other);
    const now = Date.now();
    await direct.db
      .update(schema.metaAuthorizationRequests)
      .set({ createdAt: new Date(now - 700_000), expiresAt: new Date(now - 100_000) })
      .where(eq(schema.metaAuthorizationRequests.orgId, other.orgId));
    await complete(other, expired, 409);
    expect(exchange).not.toHaveBeenCalled();
  });
  it.each(["state", "session"] as const)(
    "refuses natural %s expiry after waiting to consume the state, before exchanging the code",
    async (expiry) => {
      const value = await owner();
      const started = await begin(value);
      const [saved] = await direct.db
        .select({
          id: schema.metaAuthorizationRequests.id,
          sessionId: schema.metaAuthorizationRequests.sessionId,
        })
        .from(schema.metaAuthorizationRequests)
        .where(eq(schema.metaAuthorizationRequests.orgId, value.orgId));
      const intent = row(saved);
      if (expiry === "state")
        await direct.db
          .update(schema.metaAuthorizationRequests)
          .set({ expiresAt: sql`clock_timestamp() + interval '2 seconds'` })
          .where(eq(schema.metaAuthorizationRequests.id, intent.id));
      else
        await direct.db
          .update(schema.session)
          .set({ expiresAt: sql`clock_timestamp() + interval '2 seconds'` })
          .where(eq(schema.session.id, intent.sessionId));

      const holder = await direct.pool.connect();
      let pending: Promise<request.Response> | undefined;
      let released = false;
      try {
        await holder.query("begin");
        await holder.query(
          "select id from meta_authorization_requests where org_id=$1 and id=$2 for update",
          [value.orgId, intent.id],
        );
        const pid = row(
          (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0],
        ).pid;
        pending = value.agent
          .post("/api/channels/meta/complete")
          .send({ provider: started.provider, parameters: started.parameters })
          .then((response) => response);
        // A separate connection avoids the lock holder's cached statistics snapshot.
        await vi.waitFor(
          async () => {
            const waiting = await direct.pool.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and $2::int=any(pg_blocking_pids(pid)) and query ilike '%update%meta_authorization_requests%'",
              [applicationName, pid],
            );
            expect(row(waiting.rows[0]).n).toBe(1);
          },
          { timeout: 5000, interval: 20 },
        );
        await vi.waitFor(
          async () => {
            const expired =
              expiry === "state"
                ? await direct.pool.query<{ expired: boolean }>(
                    "select clock_timestamp() >= expires_at as expired from meta_authorization_requests where id=$1",
                    [intent.id],
                  )
                : await direct.pool.query<{ expired: boolean }>(
                    "select clock_timestamp() >= expires_at as expired from session where id=$1",
                    [intent.sessionId],
                  );
            expect(row(expired.rows[0]).expired).toBe(true);
          },
          { timeout: 5000, interval: 20 },
        );
        // No row change: qualification before a row-lock wait must not stand in for a fresh clock.
        await holder.query("commit");
        released = true;
        const refused = await pending;
        expect(refused.status).toBe(expiry === "state" ? 409 : 403);
        expect(refused.body.code).toBe(
          expiry === "state" ? "meta_authorization_invalid" : "meta_authority_changed",
        );
        expect(exchange).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect(threadsVerify).not.toHaveBeenCalled();
        const [retained] = await direct.db
          .select({ consumedAt: schema.metaAuthorizationRequests.consumedAt })
          .from(schema.metaAuthorizationRequests)
          .where(eq(schema.metaAuthorizationRequests.id, intent.id));
        expect(row(retained).consumedAt).toBeNull();
        expect(
          await direct.db
            .select({ id: schema.channels.id })
            .from(schema.channels)
            .where(eq(schema.channels.orgId, value.orgId)),
        ).toEqual([]);
      } finally {
        if (!released) await holder.query("rollback");
        holder.release();
        await pending;
      }
    },
  );
  it.each(["role", "session", "application", "callback", "state-expiry"] as const)(
    "rechecks %s after provider proof awaits without persisting credentials",
    async (change) => {
      const value = await owner();
      const started = await begin(value);
      const entered = deferred<void>();
      const response = deferred<MetaAccountConnection | MetaPageDiscovery>();
      connect.mockImplementationOnce(() => {
        entered.resolve();
        return response.promise;
      });
      const pending = value.agent
        .post("/api/channels/meta/complete")
        .send({ provider: "threads", parameters: started.parameters })
        .then((result) => result);
      await entered.promise;
      if (change === "role")
        await direct.db
          .update(schema.member)
          .set({ role: "member" })
          .where(
            and(
              eq(schema.member.organizationId, value.orgId),
              eq(schema.member.userId, value.userId),
            ),
          );
      if (change === "session")
        await direct.db
          .update(schema.session)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.session.userId, value.userId));
      if (change === "application")
        activeApplications.threads = { ...applications.threads, clientId: "9999" };
      if (change === "callback") operator.origin = "https://changed.example.com";
      if (change === "state-expiry") {
        const now = Date.now();
        await direct.db
          .update(schema.metaAuthorizationRequests)
          .set({ createdAt: new Date(now - 700_000), expiresAt: new Date(now - 100_000) })
          .where(eq(schema.metaAuthorizationRequests.orgId, value.orgId));
      }
      response.resolve(grant());
      const result = await pending;
      expect(result.status).toBe(change === "role" || change === "session" ? 403 : 409);
      expect(
        await direct.db
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(eq(schema.channels.orgId, value.orgId)),
      ).toEqual([]);
    },
  );
  it("never stores a failed, inconclusive or mismatched fresh publishing proof", async () => {
    const value = await owner();
    threadsVerify.mockResolvedValueOnce({
      ok: false,
      indeterminate: true,
      reason: "synthetic-long-token secret",
    });
    expect((await complete(value, await begin(value), 503)).body.code).toBe(
      "meta_authorization_unavailable",
    );
    threadsVerify.mockResolvedValueOnce({ ok: true, target: "threads:9999", account: "Other" });
    expect((await complete(value, await begin(value), 400)).body.code).toBe(
      "meta_authorization_failed",
    );
    threadsVerify.mockRejectedValueOnce(new Error("synthetic-long-token transport secret"));
    const response = await complete(value, await begin(value), 503);
    expect(JSON.stringify(response.body)).not.toContain("synthetic-long-token");
    expect(await channels(value)).toEqual([]);
  });
  it("rejects an expired final token and extra credential fields instead of calling them healthy", async () => {
    const value = await owner();
    const expired = grant();
    expired.credentials.expiresAt = new Date(Date.now() - 1000).toISOString();
    connect.mockResolvedValueOnce(expired);
    expect((await complete(value, await begin(value), 409)).body.code).toBe(
      "meta_reconnect_required",
    );
    const injected = grant();
    injected.credentials.unexpectedSecret = "synthetic-secret";
    connect.mockResolvedValueOnce(injected);
    expect((await complete(value, await begin(value), 400)).body.code).toBe(
      "meta_authorization_failed",
    );
    expect(await channels(value)).toEqual([]);
  });
  it.each(["extra-field", "invalid-expiry", "oversized-scopes"] as const)(
    "independently refuses %s at the repository write boundary",
    async (invalid) => {
      const value = await owner();
      const started = await begin(value);
      exchange.mockRejectedValueOnce(new MetaOAuthClientError("unavailable"));
      await complete(value, started, 503);
      const [saved] = await direct.db
        .select({
          id: schema.metaAuthorizationRequests.id,
          sessionId: schema.metaAuthorizationRequests.sessionId,
        })
        .from(schema.metaAuthorizationRequests)
        .where(eq(schema.metaAuthorizationRequests.orgId, value.orgId));
      const proof = grant();
      if (invalid === "extra-field") proof.credentials.unexpectedSecret = "synthetic-secret";
      if (invalid === "invalid-expiry") proof.credentials.expiresAt = "tomorrow";
      if (invalid === "oversized-scopes") proof.credentials.scopes = "a".repeat(2049);
      // Bypass the service's earlier parser using the actual persisted actor/session.
      // Removing only the repository boundary must fail this case, rather than the service masking it.
      await expect(
        runWithRequestAuthority(
          {
            kind: "session",
            orgId: value.orgId,
            userId: value.userId,
            sessionId: row(saved).sessionId,
            scope: { kind: "org", roles: "manager" },
            mutation: true,
            capability: undefined,
            brandId: undefined,
            resourceId: undefined,
          },
          () =>
            connections.finish(
              value.orgId,
              row(saved).id,
              {
                provider: "threads",
                application: applications.threads,
                redirectUri: "https://pubrick.example.com/en/connections/meta/threads",
              },
              proof,
            ),
        ),
      ).rejects.toMatchObject({ response: { code: "meta_authorization_failed" }, status: 400 });
      expect(await channels(value)).toEqual([]);
      expect(
        await direct.db
          .select({ id: schema.metaAuthorizationRequests.id })
          .from(schema.metaAuthorizationRequests)
          .where(eq(schema.metaAuthorizationRequests.id, row(saved).id)),
      ).toEqual([{ id: row(saved).id }]);
    },
  );
  it("encrypts explicit Page choices and never auto-selects or exposes tokens", async () => {
    const value = await owner();
    const pending = await pendingPages(value);
    expect(metaAuthorizationCompletedSchema.parse(pending.choices.body)).toMatchObject({
      status: "choose_page",
      brandId: value.brandId,
      pages: [
        { id: "111", name: "Studio 111" },
        { id: "222", name: "Studio 222" },
      ],
    });
    expect(await channels(value)).toEqual([]);
    expect(facebookVerify).not.toHaveBeenCalled();
    const [saved] = await direct.db
      .select({ encrypted: schema.metaAuthorizationRequests.pageSelectionEncrypted })
      .from(schema.metaAuthorizationRequests)
      .where(eq(schema.metaAuthorizationRequests.id, pending.requestId));
    for (const secret of [
      "synthetic-user-token",
      "synthetic-page-one-token",
      "synthetic-page-two-token",
      applications.facebook_page.clientSecret,
    ]) {
      expect(JSON.stringify(pending.choices.body)).not.toContain(secret);
      expect(saved?.encrypted).not.toContain(secret);
    }
    expect(
      decryptJson<{ pages: MetaAccountConnection[] }>(row(saved).encrypted as string, key).pages,
    ).toHaveLength(2);
    facebookVerify.mockImplementationOnce(async (credentials) => {
      const [state] = await direct.db
        .select({
          encrypted: schema.metaAuthorizationRequests.pageSelectionEncrypted,
          consumed: schema.metaAuthorizationRequests.pageSelectionConsumedAt,
        })
        .from(schema.metaAuthorizationRequests)
        .where(eq(schema.metaAuthorizationRequests.id, pending.requestId));
      expect(state).toMatchObject({ encrypted: null, consumed: expect.any(Date) });
      expect(credentials.pageId).toBe("222");
      expect(credentials.accessToken).toBe("synthetic-page-two-token");
      return { ok: true, target: "facebook-page:222", account: "Selected Studio" };
    });
    const completed = await select(value, pending.requestId);
    expect(await stored(value, completed.body.channelId)).toMatchObject({
      target: "facebook-page:222",
      applicationId: applications.facebook_page.clientId,
      account: "Selected Studio",
    });
    await select(value, pending.requestId, "111", 409);
    expect(facebookVerify).toHaveBeenCalledOnce();
  });
  it("refuses unknown, foreign and another-session Page choices before new network reads", async () => {
    const value = await owner();
    const pending = await pendingPages(value);
    await select(value, pending.requestId, "9999", 409);
    await select(await owner(), pending.requestId, "222", 409);
    const [user] = await direct.db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, value.userId));
    const alternate = request.agent(app.getHttpServer());
    await alternate
      .post("/api/auth/sign-in/email")
      .send({ email: row(user).email, password: "password1234" })
      .expect(200);
    await alternate
      .post("/api/auth/organization/set-active")
      .send({ organizationId: value.orgId })
      .expect(200);
    await alternate
      .post("/api/channels/meta/select-page")
      .send({ requestId: pending.requestId, pageId: "222" })
      .expect(409);
    expect(facebookVerify).not.toHaveBeenCalled();
    await select(value, pending.requestId);
  });
  it("burns the selected Page before failed verification and forbids choosing another Page afterwards", async () => {
    const value = await owner();
    const pending = await pendingPages(value);
    facebookVerify.mockResolvedValueOnce({
      ok: false,
      indeterminate: true,
      reason: "Provider unavailable",
    });
    await select(value, pending.requestId, "222", 503);
    await select(value, pending.requestId, "222", 409);
    await select(value, pending.requestId, "111", 409);
    await complete(value, pending.started, 409);
    expect(facebookVerify).toHaveBeenCalledOnce();
    expect(await channels(value)).toEqual([]);
  });
  it("refuses concurrent Page selection without a second proof or channel", async () => {
    const value = await owner();
    const pending = await pendingPages(value);
    const entered = deferred<void>();
    const proof = deferred<Awaited<ReturnType<typeof facebookPagePublisher.verify>>>();
    facebookVerify.mockImplementationOnce(() => {
      entered.resolve();
      return proof.promise;
    });
    const first = value.agent
      .post("/api/channels/meta/select-page")
      .send({ requestId: pending.requestId, pageId: "222" })
      .then((result) => result);
    await entered.promise;
    await select(value, pending.requestId, "111", 409);
    proof.resolve({ ok: true, target: "facebook-page:222", account: "Studio" });
    expect((await first).status).toBe(200);
    expect(facebookVerify).toHaveBeenCalledOnce();
    expect(await channels(value)).toHaveLength(1);
  });
  it("preserves one immutable reconnect destination and refuses a disconnect race", async () => {
    const value = await connected();
    const before = await stored(value, value.channelId);
    const started = await begin(value, "threads", value.channelId, 1);
    connect.mockResolvedValueOnce(grant("threads", "synthetic-other-token", "9999"));
    expect((await complete(value, started, 409)).body.code).toBe("channel_target_changed");
    expect(await stored(value, value.channelId)).toEqual(before);
    const next = await begin(value, "threads", value.channelId, 1);
    const entered = deferred<void>();
    const proof = deferred<MetaAccountConnection>();
    connect.mockImplementationOnce(() => {
      entered.resolve();
      return proof.promise;
    });
    const pending = value.agent
      .post("/api/channels/meta/complete")
      .send({ provider: "threads", parameters: next.parameters })
      .then((result) => result);
    await entered.promise;
    await value.agent
      .post(`/api/channels/meta/${value.channelId}/disconnect`)
      .send({ expectedGeneration: 1 })
      .expect(204);
    proof.resolve(grant("threads", "synthetic-new-token"));
    expect((await pending).status).toBe(409);
    expect(await stored(value, value.channelId)).toMatchObject({
      ciphertext: null,
      generation: 2,
      target: before.target,
    });
  });
  it("reconnects and disconnects without rewriting scheduled jobs or retained publication receipts", async () => {
    const value = await connected();
    const queued = await value.agent
      .post("/api/content")
      .send({
        brandId: value.brandId,
        body: "Reviewed writing to publish later.",
        title: "Writing",
        channelIds: [value.channelId],
      })
      .expect(201);
    await value.agent
      .post(`/api/content/${queued.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })
      .expect(200);
    const queuedAdaptationId = queued.body.adaptations[0].id as string;
    const [item] = await direct.db
      .insert(schema.contentItems)
      .values({
        orgId: value.orgId,
        brandId: value.brandId,
        body: "Retained publication",
        origin: "human",
        status: "published",
      })
      .returning({ id: schema.contentItems.id });
    const [adaptation] = await direct.db
      .insert(schema.adaptations)
      .values({
        orgId: value.orgId,
        contentItemId: row(item).id,
        channelId: value.channelId,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    await direct.db.insert(schema.publications).values({
      orgId: value.orgId,
      adaptationId: row(adaptation).id,
      channelId: value.channelId,
      status: "published",
      externalId: "7777",
      externalUrl: "https://www.threads.com/@studio/post/fixture",
    });
    const before = await direct.db.execute(
      sql`select id,status,channel_id,adaptation_id,external_id,external_url from publications where org_id=${value.orgId}`,
    );
    const adaptations = await direct.db.execute(
      sql`select id,status,attempt_count,scheduled_at from adaptations where org_id=${value.orgId} order by id`,
    );
    const jobs = await direct.db.execute(
      sql`select id,state,start_after,data from pgboss.job where name='publish' and data->>'orgId'=${value.orgId} and data->>'adaptationId'=${queuedAdaptationId}`,
    );
    expect(jobs.rows).toHaveLength(1);
    const started = await begin(value, "threads", value.channelId, 1);
    connect.mockResolvedValueOnce(grant("threads", "synthetic-renewed-token"));
    await complete(value, started);
    expect(await stored(value, value.channelId)).toMatchObject({
      generation: 2,
      target: "threads:654321",
    });
    await value.agent
      .post(`/api/channels/meta/${value.channelId}/disconnect`)
      .send({ expectedGeneration: 2 })
      .expect(204);
    await value.agent
      .post(`/api/channels/meta/${value.channelId}/disconnect`)
      .send({ expectedGeneration: 2 })
      .expect(409);
    expect(
      (
        await direct.db.execute(
          sql`select id,status,channel_id,adaptation_id,external_id,external_url from publications where org_id=${value.orgId}`,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await direct.db.execute(
          sql`select id,status,attempt_count,scheduled_at from adaptations where org_id=${value.orgId} order by id`,
        )
      ).rows,
    ).toEqual(adaptations.rows);
    expect(
      (
        await direct.db.execute(
          sql`select id,state,start_after,data from pgboss.job where name='publish' and data->>'orgId'=${value.orgId} and data->>'adaptationId'=${queuedAdaptationId}`,
        )
      ).rows,
    ).toEqual(jobs.rows);
  });
});
