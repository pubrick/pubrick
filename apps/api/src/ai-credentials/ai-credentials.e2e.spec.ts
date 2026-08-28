import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AiCredential, UsageRecord } from "@pubrick/ai";
import { createDb, schema } from "@pubrick/db";
import type { CostSummary } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiCredentialProbe, type ProbeOutcome } from "./ai-credentials.probe";

const url = process.env.TEST_DATABASE_URL;

/** The key every test stores. Nothing in any response body may contain it. */
const SECRET_KEY = "sk-live-never-leak-this-0123456789";

describe.skipIf(!url)("ai credentials e2e", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;

  /**
   * The one seam that would otherwise call Google or OpenRouter for real. §8 of
   * the design forbids any test touching a provider, so the probe — which owns
   * every network line of this feature and nothing else — is replaced here, and
   * the rest of the endpoint (guard, org scoping, decrypt, ledger write, cost
   * rules, response shape) runs for real against a real database.
   */
  const probeCalls: AiCredential[] = [];
  let probeOutcome: ProbeOutcome = { ok: true, modelId: "gemini-3.7-flash", records: [] };

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts — see the
    // comment there. Do NOT add a runMigrations() call here.
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AiCredentialProbe)
      .useValue({
        run: async (credential: AiCredential): Promise<ProbeOutcome> => {
          probeCalls.push(credential);
          return probeOutcome;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();

    direct = createDb(url as string);
  });

  afterAll(async () => {
    await app.close();
    await direct.pool.end();
  });

  beforeEach(() => {
    probeCalls.length = 0;
    probeOutcome = { ok: true, modelId: "gemini-3.7-flash", records: [] };
  });

  async function orgAgent(): Promise<{ agent: request.Agent; orgId: string }> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `u${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return { agent, orgId: created.body.id as string };
  }

  function save(agent: request.Agent, body: Record<string, unknown> = {}) {
    return agent
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: SECRET_KEY, ...body });
  }

  function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
    return {
      provider: "google",
      modelId: "gemini-3.7-flash",
      attempt: 1,
      inputTokens: 12,
      outputTokens: 3,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.00002,
      costSource: "price_table",
      responseMs: 210,
      status: "ok",
      ...overrides,
    };
  }

  describe("secrecy", () => {
    it("never returns the stored key from ANY endpoint", async () => {
      const { agent } = await orgAgent();
      probeOutcome = { ok: true, modelId: "gemini-3.7-flash", records: [usage()] };

      // Every response this module can produce, checked against the WHOLE JSON
      // body rather than a named field: a repository that widened its column
      // allowlist would sail past a field-by-field assertion.
      const bodies = [
        (await save(agent, { defaultModel: "gemini-3.7-flash" }).expect(200)).body,
        (await agent.get("/api/ai-credentials").expect(200)).body,
        (await agent.get("/api/ai-credentials/spend").expect(200)).body,
        (await agent.post("/api/ai-credentials/google/test").expect(200)).body,
        (await agent.delete("/api/ai-credentials/google").expect(200)).body,
      ];

      for (const body of bodies) {
        const json = JSON.stringify(body);
        expect(json).not.toContain(SECRET_KEY);
        expect(json).not.toContain("apiKey");
        expect(json).not.toContain("credentialsEncrypted");
      }
    });

    it("returns exactly provider, defaultModel and updatedAt — nothing else", async () => {
      const { agent } = await orgAgent();
      const saved = await save(agent, { defaultModel: "gemini-3.7-flash" }).expect(200);

      expect(Object.keys(saved.body).sort()).toEqual(["defaultModel", "provider", "updatedAt"]);
      expect(saved.body.provider).toBe("google");
      expect(saved.body.defaultModel).toBe("gemini-3.7-flash");
    });

    it("stores the key encrypted at rest", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);

      const rows = await direct.db
        .select({ blob: schema.aiCredentials.credentialsEncrypted })
        .from(schema.aiCredentials)
        .where(eq(schema.aiCredentials.orgId, orgId));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.blob).not.toContain(SECRET_KEY);
    });
  });

  describe("saving", () => {
    it("omitting defaultModel stores null, so the provider's own default applies", async () => {
      const { agent } = await orgAgent();
      const saved = await save(agent).expect(200);

      expect(saved.body.defaultModel).toBeNull();
    });

    it("a second save replaces the key in place and re-dates the row", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent, { defaultModel: "gemini-3.7-flash" }).expect(200);
      // Backdate through raw SQL so the assertion below cannot pass by two saves
      // landing in the same millisecond. `$onUpdate` does NOT fire for an
      // upsert's conflict branch, so a hand-written updatedAt is the only thing
      // that moves this date — and a stale date misdates the key on screen.
      await direct.db.execute(
        sql`update ai_credentials set updated_at = timestamp '2020-01-01 00:00:00' where org_id = ${orgId}`,
      );

      const second = await save(agent, {
        apiKey: "sk-live-the-replacement-key-99",
        defaultModel: "gemini-3.7-pro",
      }).expect(200);

      const list = await agent.get("/api/ai-credentials").expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].defaultModel).toBe("gemini-3.7-pro");
      expect(new Date(second.body.updatedAt).getUTCFullYear()).toBeGreaterThan(2020);
    });

    it("rejects a key too short to be one", async () => {
      const { agent } = await orgAgent();
      await agent
        .put("/api/ai-credentials")
        .send({ provider: "google", apiKey: "short" })
        .expect(400);
    });

    it("rejects a provider nothing can build a model for", async () => {
      const { agent } = await orgAgent();
      await agent
        .put("/api/ai-credentials")
        .send({ provider: "acme-ai", apiKey: SECRET_KEY })
        .expect(400);

      const rejected = await agent.post("/api/ai-credentials/acme-ai/test").expect(400);
      expect(String(rejected.body.message)).toContain("google");
    });
  });

  describe("org scoping", () => {
    it("one org cannot read, test or delete another org's key", async () => {
      const a = await orgAgent();
      const b = await orgAgent();
      await save(a.agent).expect(200);

      expect((await b.agent.get("/api/ai-credentials").expect(200)).body).toEqual([]);
      await b.agent.post("/api/ai-credentials/google/test").expect(404);
      await b.agent.delete("/api/ai-credentials/google").expect(404);

      // ...and the first org's key survived the other org's delete.
      expect((await a.agent.get("/api/ai-credentials").expect(200)).body).toHaveLength(1);
    });
  });

  describe("removal", () => {
    it("removes the key, and a second removal is a 404", async () => {
      const { agent } = await orgAgent();
      await save(agent).expect(200);

      const removed = await agent.delete("/api/ai-credentials/google").expect(200);
      expect(removed.body).toEqual({ deleted: true, failedRuns: 0 });
      expect((await agent.get("/api/ai-credentials").expect(200)).body).toEqual([]);
      await agent.delete("/api/ai-credentials/google").expect(404);
    });

    it("fails the org's queued runs with a message naming the missing key", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
      const inserted = await direct.db
        .insert(schema.pipelineRuns)
        .values({
          orgId,
          brandId: brand.body.id,
          input: { kind: "brief", text: "a brief", channelIds: [] },
        })
        .returning({ id: schema.pipelineRuns.id });
      const runId = inserted[0]?.id as string;

      const removed = await agent.delete("/api/ai-credentials/google").expect(200);
      expect(removed.body.failedRuns).toBe(1);

      const runs = await direct.db
        .select({ status: schema.pipelineRuns.status, error: schema.pipelineRuns.error })
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.id, runId));

      expect(runs[0]?.status).toBe("failed");
      // Names the missing key, so the user reads a cause they created rather
      // than a provider 401 they cannot interpret.
      expect(runs[0]?.error).toContain("google");
      expect(runs[0]?.error).toContain("removed");
    });
  });

  describe("the Test action", () => {
    it("reports which model answered and what it cost", async () => {
      const { agent } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = {
        ok: true,
        modelId: "gemini-3.7-flash-8b",
        records: [usage({ costSource: "provider_reported", costUsd: 0.000031 })],
      };

      const result = await agent.post("/api/ai-credentials/google/test").expect(200);

      expect(result.body.ok).toBe(true);
      expect(result.body.modelId).toBe("gemini-3.7-flash-8b");
      expect(result.body.cost).toEqual({ kind: "exact", usd: 0.000031 });
    });

    it("says the cost is unknown rather than reporting a billed call as free", async () => {
      const { agent } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = {
        ok: true,
        modelId: "some/unlisted-model",
        records: [usage({ costUsd: null, costSource: "unknown" })],
      };

      const result = await agent.post("/api/ai-credentials/google/test").expect(200);

      const cost = result.body.cost as CostSummary;
      expect(cost).toEqual({ kind: "atLeast", usd: 0, unpricedCalls: 1 });
    });

    it("hands the probe the decrypted key and calls it EVERY time — never a cached verdict", async () => {
      const { agent } = await orgAgent();
      await save(agent, { defaultModel: "gemini-3.7-flash" }).expect(200);

      await agent.post("/api/ai-credentials/google/test").expect(200);
      await agent.post("/api/ai-credentials/google/test").expect(200);

      expect(probeCalls).toHaveLength(2);
      expect(probeCalls[0]).toEqual({
        provider: "google",
        apiKey: SECRET_KEY,
        defaultModel: "gemini-3.7-flash",
      });
    });

    it("is a result, not a 500, when the provider rejects the key", async () => {
      const { agent } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = { ok: false, reason: "API key not valid.", records: [] };

      const result = await agent.post("/api/ai-credentials/google/test").expect(200);

      expect(result.body).toEqual({ ok: false, reason: "API key not valid." });
    });

    it("bills the ledger for a call that failed after the provider counted tokens", async () => {
      const { agent } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = {
        ok: false,
        reason: "the model returned output that does not match the required schema, twice",
        records: [usage({ status: "errored", costUsd: 0.000044, costSource: "provider_reported" })],
      };

      await agent.post("/api/ai-credentials/google/test").expect(200);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0.000044,
      });
    });

    it("404s when the org has no key for that provider", async () => {
      const { agent } = await orgAgent();

      await agent.post("/api/ai-credentials/google/test").expect(404);
      expect(probeCalls).toHaveLength(0);
    });
  });

  describe("spend to date", () => {
    it("is exactly $0 for an org that has spent nothing", async () => {
      const { agent } = await orgAgent();

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0,
      });
    });

    it("keeps counting a call whose run was deleted — it sums by org_id alone", async () => {
      const { agent, orgId } = await orgAgent();
      const brand = await agent.post("/api/brands").send({ name: "Doomed" }).expect(201);
      const inserted = await direct.db
        .insert(schema.pipelineRuns)
        .values({
          orgId,
          brandId: brand.body.id,
          input: { kind: "brief", text: "a brief", channelIds: [] },
        })
        .returning({ id: schema.pipelineRuns.id });
      await direct.db.insert(schema.usageLedger).values({
        orgId,
        runId: inserted[0]?.id,
        step: "writer",
        provider: "google",
        modelId: "gemini-3.7-flash",
        costUsd: "0.005000",
        costSource: "provider_reported",
        status: "ok",
      });

      // Deleting the brand cascades to the run, and the ledger's run_id is
      // ON DELETE SET NULL. A total joined through run_id would drop this row
      // and quietly shrink the org's spend every time it tidied up.
      await agent.delete(`/api/brands/${brand.body.id}`).expect(200);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0.005,
      });
    });

    it("reports a floor with the unpriced count as soon as one call cannot be priced", async () => {
      const { agent, orgId } = await orgAgent();
      await direct.db.insert(schema.usageLedger).values([
        {
          orgId,
          step: "writer",
          provider: "google",
          modelId: "gemini-3.7-flash",
          costUsd: "0.002000",
          costSource: "price_table",
          status: "ok",
        },
        {
          orgId,
          step: "editor",
          provider: "openrouter",
          modelId: "some/unlisted-model",
          costUsd: null,
          costSource: "unknown",
          status: "ok",
        },
      ]);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "atLeast",
        usd: 0.002,
        unpricedCalls: 1,
      });
    });

    it("counts only the asking org's rows", async () => {
      const a = await orgAgent();
      const b = await orgAgent();
      await direct.db.insert(schema.usageLedger).values({
        orgId: a.orgId,
        step: "writer",
        provider: "google",
        modelId: "gemini-3.7-flash",
        costUsd: "1.000000",
        costSource: "provider_reported",
        status: "ok",
      });

      expect((await b.agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0,
      });
      expect((await a.agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 1,
      });
    });
  });
});
