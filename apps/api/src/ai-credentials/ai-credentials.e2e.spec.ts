import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AiCredential, UsageRecord } from "@pubrick/ai";
import { createDb, schema } from "@pubrick/db";
import {
  type AiProviderId,
  type CostRow,
  type CostSummary,
  costTotals,
  encryptJson,
  MAX_TEST_CALLS_PER_HOUR,
  preferredCredential,
  summarizeCost,
} from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AiCredentialProbe, type ProbeOutcome } from "./ai-credentials.probe";

// Type-only: `ai-credentials.repository` reaches `../db`, which validates env at
// module load, and `beforeAll` is where DATABASE_URL is set. Same rule the app
// module below follows — the class is imported dynamically, after that.
type AiCredentialsRepositoryCtor =
  typeof import("./ai-credentials.repository").AiCredentialsRepository;

const url = process.env.TEST_DATABASE_URL;

/** The key every test stores. Nothing in any response body may contain it. */
const SECRET_KEY = "sk-live-never-leak-this-0123456789";

describe.skipIf(!url)("ai credentials e2e", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;
  let repo: InstanceType<AiCredentialsRepositoryCtor>;

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
    // Listen for the whole file: supertest otherwise starts the server per
    // request and closes it when that request ends, killing any other request
    // in flight (see content.e2e.spec.ts for the measurement).
    await app.listen(0);
    // The same module record `AppModule` already pulled in, so the class is the
    // identical DI token Nest registered.
    const { AiCredentialsRepository } = (await import("./ai-credentials.repository")) as {
      AiCredentialsRepository: AiCredentialsRepositoryCtor;
    };
    repo = app.get(AiCredentialsRepository);

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
      outcome: "completed",
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

    it("does not echo the path segment back in its 400", async () => {
      const { agent } = await orgAgent();
      // A key pasted one field too far, or a mis-built client URL. Reflecting it
      // puts the secret in the response body, and from there into every access
      // log and error tracker between here and the browser.
      const rejected = await agent
        .post(`/api/ai-credentials/${encodeURIComponent(SECRET_KEY)}/test`)
        .expect(400);

      expect(JSON.stringify(rejected.body)).not.toContain(SECRET_KEY);
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

    it("touches only the asking org's runs — another org's queue is not collateral", async () => {
      // The `org_id` predicate on that UPDATE is the whole of this feature's
      // blast radius. Without it, one org removing its key fails EVERY org's
      // queued work, and nothing else in the suite would notice.
      const victim = await orgAgent();
      const victimBrand = await victim.agent.post("/api/brands").send({ name: "V" }).expect(201);
      const victimRun = await direct.db
        .insert(schema.pipelineRuns)
        .values({
          orgId: victim.orgId,
          brandId: victimBrand.body.id,
          input: { kind: "brief", text: "not yours", channelIds: [] },
        })
        .returning({ id: schema.pipelineRuns.id });

      const remover = await orgAgent();
      await save(remover.agent).expect(200);
      const removerBrand = await remover.agent.post("/api/brands").send({ name: "R" }).expect(201);
      await direct.db.insert(schema.pipelineRuns).values({
        orgId: remover.orgId,
        brandId: removerBrand.body.id,
        input: { kind: "brief", text: "mine", channelIds: [] },
      });

      const removed = await remover.agent.delete("/api/ai-credentials/google").expect(200);
      expect(removed.body.failedRuns).toBe(1);

      const untouched = await direct.db
        .select({ status: schema.pipelineRuns.status })
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.id, victimRun[0]?.id as string));
      expect(untouched[0]?.status).toBe("queued");
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
      probeOutcome = { ok: false, reason: "invalid_key", records: [] };

      const result = await agent.post("/api/ai-credentials/google/test").expect(200);

      expect(result.body).toEqual({ ok: false, reason: "invalid_key" });
    });

    it("bills the ledger for a call that failed after the provider counted tokens", async () => {
      const { agent } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = {
        ok: false,
        reason: "no_structured_output",
        records: [usage({ status: "errored", costUsd: 0.000044, costSource: "provider_reported" })],
      };

      await agent.post("/api/ai-credentials/google/test").expect(200);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0.000044,
      });
    });

    it("404s when the org has no key for that provider, and names the refusal", async () => {
      const { agent } = await orgAgent();

      const refused = await agent.post("/api/ai-credentials/google/test").expect(404);
      // Reachable from the settings screen the moment a second tab removes the
      // key, so it is a refusal a person provokes rather than a developer's
      // 404: it carries a code the web renders in four languages, beside the
      // English sentence a network tab and an API consumer still get.
      expect(refused.body.code).toBe("ai_credential_not_found");
      expect(refused.body.message).toBe("No API key stored for this provider");
      expect(probeCalls).toHaveLength(0);
    });

    it("files the ledger row under the test step, with no run to attribute it to", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = { ok: true, modelId: "gemini-3.7-flash", records: [usage()] };

      await agent.post("/api/ai-credentials/google/test").expect(200);

      const rows = await direct.db
        .select({ step: schema.usageLedger.step, runId: schema.usageLedger.runId })
        .from(schema.usageLedger)
        .where(eq(schema.usageLedger.orgId, orgId));
      expect(rows).toEqual([{ step: "test", runId: null }]);
    });

    it("stores what became of the Test call, so a lost one cannot read as free", async () => {
      // A Test that was dispatched and then lost — the button's own path to the
      // same defect. The row carries no tokens and no cost, exactly like the
      // 429 a rate-limited Test writes; `outcome` is the only thing that stops
      // the org's total treating it as a free call, and the writer has to carry
      // it from the record rather than stamping a value of its own.
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = {
        ok: false,
        reason: "refused",
        records: [
          usage({
            status: "errored",
            costUsd: null,
            costSource: "unknown",
            inputTokens: 0,
            outputTokens: 0,
            outcome: "unknown",
          }),
        ],
      };

      await agent.post("/api/ai-credentials/google/test").expect(200);

      const rows = await direct.db
        .select({ outcome: schema.usageLedger.outcome })
        .from(schema.usageLedger)
        .where(eq(schema.usageLedger.orgId, orgId));
      expect(rows).toEqual([{ outcome: "unknown" }]);
      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "atLeast",
        usd: 0,
        unpricedCalls: 1,
      });
    });

    it("stores a refused Test call as refused, which is free and known to be", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = {
        ok: false,
        reason: "rate_limited",
        records: [
          usage({
            status: "errored",
            costUsd: null,
            costSource: "unknown",
            inputTokens: 0,
            outputTokens: 0,
            outcome: "refused",
          }),
        ],
      };

      await agent.post("/api/ai-credentials/google/test").expect(200);

      const rows = await direct.db
        .select({ outcome: schema.usageLedger.outcome })
        .from(schema.usageLedger)
        .where(eq(schema.usageLedger.orgId, orgId));
      expect(rows).toEqual([{ outcome: "refused" }]);
      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0,
      });
    });

    it("stores a sub-micro-dollar reported cost instead of rounding it away to zero", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      // OpenRouter reports real costs this small, and it never passes through
      // `estimateCostUsd`'s floor. Rounded to six decimals it would be
      // 0.000000 — a billed call, recorded as free, and the Test line would say
      // $0.000001 while the org total said $0.00.
      probeOutcome = {
        ok: true,
        modelId: "some/cheap-model",
        records: [usage({ costUsd: 0.0000004, costSource: "provider_reported" })],
      };

      await agent.post("/api/ai-credentials/google/test").expect(200);

      const rows = await direct.db
        .select({ costUsd: schema.usageLedger.costUsd })
        .from(schema.usageLedger)
        .where(eq(schema.usageLedger.orgId, orgId));
      expect(rows[0]?.costUsd).toBe("0.000001");
      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0.000001,
      });
    });

    it("is a result, not a 500, when the stored key cannot be decrypted", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      // What a rotated APP_ENCRYPTION_KEY (or a tampered row) looks like. The
      // old behaviour was a 500 with a crypto stack trace, on a screen that
      // went on listing the key as if it were fine.
      await direct.db
        .update(schema.aiCredentials)
        .set({ credentialsEncrypted: "bm90LWEtcmVhbC1ibG9i" })
        .where(eq(schema.aiCredentials.orgId, orgId));

      const result = await agent.post("/api/ai-credentials/google/test").expect(200);

      expect(result.body).toEqual({ ok: false, reason: "unreadable_key" });
      expect(probeCalls).toHaveLength(0);
    });

    it("still answers when the ledger write fails — the call was already paid for", async () => {
      const { agent } = await orgAgent();
      await save(agent).expect(200);
      // Beyond int4: the insert throws. Losing the record of a call is bad;
      // throwing away the answer we already paid for as well is strictly worse,
      // and a 500 here would do both.
      probeOutcome = {
        ok: true,
        modelId: "gemini-3.7-flash",
        records: [usage({ inputTokens: 3_000_000_000 })],
      };

      const result = await agent.post("/api/ai-credentials/google/test").expect(200);

      expect(result.body.ok).toBe(true);
      expect(result.body.modelId).toBe("gemini-3.7-flash");
    });
  });

  /**
   * The only route in this api that spends money on demand, and until now the
   * only thing above it was membership: no role, no limit, and no throttler
   * anywhere in the app. Every press is a live model call on the org's own key —
   * two when the repair retry fires — so a member with a loop could spend on
   * the order of $140 an hour of somebody else's money.
   *
   * What is counted is CALLS, from the ledger the calls themselves wrote: one
   * number for the whole deployment rather than one per replica, surviving a
   * restart, and consuming nothing for a Test that spent nothing.
   */
  describe("the hourly cap on what Test can spend", () => {
    /** Rows exactly as the Test button writes them, without spending anything. */
    async function seedTestCalls(orgId: string, count: number, step = "test") {
      if (count === 0) return;
      await direct.db.insert(schema.usageLedger).values(
        Array.from({ length: count }, () => ({
          orgId,
          step,
          provider: "google" as const,
          modelId: "gemini-3.7-flash",
          costUsd: "0.000400",
          costSource: "price_table" as const,
          status: "ok" as const,
          outcome: "completed" as const,
        })),
      );
    }

    it("refuses once the org has used its allowance, without reaching a provider", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      await seedTestCalls(orgId, MAX_TEST_CALLS_PER_HOUR);

      const result = await agent.post("/api/ai-credentials/google/test").expect(200);

      expect(result.body).toEqual({ ok: false, reason: "too_many_tests" });
      // The refusal is worth nothing if the call still happened. It is made
      // before the decrypt and before the probe, so nothing is spent and the
      // key is not even read.
      expect(probeCalls).toHaveLength(0);
    });

    it("refuses ON the limit and not one call before it", async () => {
      // The count is of calls ALREADY MADE, so a count that has reached the
      // limit means the allowance is spent. Off by one here is either a member
      // refused while they still had a call left, or a limit that is not the
      // number the screen tells them.
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      await seedTestCalls(orgId, MAX_TEST_CALLS_PER_HOUR - 1);
      // A press that really writes its row, because the row is what closes the
      // budget: the ledger is the counter.
      probeOutcome = { ok: true, modelId: "gemini-3.7-flash", records: [usage()] };

      expect((await agent.post("/api/ai-credentials/google/test").expect(200)).body.ok).toBe(true);
      expect(probeCalls).toHaveLength(1);

      // That press wrote its own row, which is the one that closes the budget.
      expect((await agent.post("/api/ai-credentials/google/test").expect(200)).body).toEqual({
        ok: false,
        reason: "too_many_tests",
      });
    });

    it("does not make an honest user wait: a second press goes straight through", async () => {
      // A limit that bites a person who pressed Test twice is worse than the
      // problem it solves. Two presses in a row, both real, both answered.
      const { agent } = await orgAgent();
      await save(agent).expect(200);
      probeOutcome = { ok: true, modelId: "gemini-3.7-flash", records: [usage()] };

      const first = await agent.post("/api/ai-credentials/google/test").expect(200);
      const second = await agent.post("/api/ai-credentials/google/test").expect(200);

      expect(first.body.ok).toBe(true);
      expect(second.body.ok).toBe(true);
      expect(probeCalls).toHaveLength(2);
    });

    it("counts only this org's calls", async () => {
      // The limit is per organisation and the ledger is global. A count that
      // forgot to scope would let any busy tenant lock out every other one.
      const { orgId: neighbour } = await orgAgent();
      await seedTestCalls(neighbour, MAX_TEST_CALLS_PER_HOUR * 2);
      const { agent } = await orgAgent();
      await save(agent).expect(200);

      expect((await agent.post("/api/ai-credentials/google/test").expect(200)).body.ok).toBe(true);
    });

    it("counts only test calls — a run's spend does not lock the button", async () => {
      // A generation run writes far more rows than this button ever will. If
      // they counted, an org that generated anything could no longer check
      // whether its key still works — which is when it most needs to.
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      await seedTestCalls(orgId, MAX_TEST_CALLS_PER_HOUR * 2, "writer");

      expect((await agent.post("/api/ai-credentials/google/test").expect(200)).body.ok).toBe(true);
    });

    it("forgets calls older than the window", async () => {
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      await seedTestCalls(orgId, MAX_TEST_CALLS_PER_HOUR);
      // Backdated by the DATABASE's clock, never a JavaScript `Date`:
      // `created_at` is `timestamp` without time zone and is compared against
      // `now()`, so a value serialised with the test process's own offset would
      // move the window by that offset instead of by two hours.
      await direct.db.execute(
        sql`update usage_ledger set created_at = now() - interval '2 hours' where org_id = ${orgId}`,
      );

      expect((await agent.post("/api/ai-credentials/google/test").expect(200)).body.ok).toBe(true);
    });

    it("still counts a refused call, which cost a round trip even at zero tokens", async () => {
      // A 429 the provider refused writes a zero-token, unpriced row. It is
      // still a request made on the org's key, and a limit that skipped it
      // would be no limit at all against a key the provider is already
      // throttling.
      const { agent, orgId } = await orgAgent();
      await save(agent).expect(200);
      await direct.db.insert(schema.usageLedger).values(
        Array.from({ length: MAX_TEST_CALLS_PER_HOUR }, () => ({
          orgId,
          step: "test",
          provider: "google" as const,
          modelId: "gemini-3.7-flash",
          costUsd: null,
          costSource: "unknown" as const,
          status: "errored" as const,
          outcome: "refused" as const,
        })),
      );

      expect((await agent.post("/api/ai-credentials/google/test").expect(200)).body).toEqual({
        ok: false,
        reason: "too_many_tests",
      });
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
          inputTokens: 900,
          outputTokens: 120,
          status: "ok",
        },
      ]);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "atLeast",
        usd: 0.002,
        unpricedCalls: 1,
      });
    });

    it("renders a lone price-table row as approximate — rule 2, through the SQL path", async () => {
      const { agent, orgId } = await orgAgent();
      await direct.db.insert(schema.usageLedger).values({
        orgId,
        step: "writer",
        provider: "google",
        modelId: "gemini-3.7-flash",
        costUsd: "0.002000",
        costSource: "price_table",
        inputTokens: 900,
        outputTokens: 120,
        status: "ok",
      });

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "approximate",
        usd: 0.002,
      });
    });

    it("ignores a round trip that was rejected before any tokens were counted", async () => {
      const { agent, orgId } = await orgAgent();
      await direct.db.insert(schema.usageLedger).values([
        {
          orgId,
          step: "writer",
          provider: "google",
          modelId: "gemini-3.7-flash",
          costUsd: "1.230000",
          costSource: "provider_reported",
          inputTokens: 900,
          outputTokens: 120,
          status: "ok",
        },
        {
          // A 429. No tokens counted, so its cost is known to be zero — and the
          // ledger is lifetime, so letting one blip stamp "≥" on the total would
          // stamp it forever.
          orgId,
          step: "writer",
          provider: "google",
          modelId: "gemini-3.7-flash",
          costUsd: null,
          costSource: "unknown",
          inputTokens: 0,
          outputTokens: 0,
          status: "errored",
        },
      ]);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 1.23,
      });
    });

    it("does not sum a row marked unknown even when it carries a figure", async () => {
      // The SQL aggregate and `costTotals()` answer one question and must not
      // disagree: this row is $0 + one unpriced call in both.
      const { agent, orgId } = await orgAgent();
      await direct.db.insert(schema.usageLedger).values({
        orgId,
        step: "writer",
        provider: "google",
        modelId: "gemini-3.7-flash",
        costUsd: "5.000000",
        costSource: "unknown",
        inputTokens: 900,
        outputTokens: 120,
        status: "ok",
      });

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "atLeast",
        usd: 0,
        unpricedCalls: 1,
      });
    });

    /**
     * The measured case from the review, end to end through the SQL reader.
     *
     * One call the price table could name, and three that were dispatched and
     * lost — a timeout, a reset, a body that would not parse. Every one of the
     * three may have been billed in full. Before `outcome` existed all three
     * were zero-token rows indistinguishable from a 429, so this org's screen
     * read "≈ $0.007875": a quarter of the bill, under a symbol meaning
     * "estimate" rather than "at least".
     */
    it("says at least, not approximately, when three calls were lost after dispatch", async () => {
      const { agent, orgId } = await orgAgent();
      const priced = {
        orgId,
        step: "writer",
        provider: "google" as const,
        modelId: "gemini-3.7-flash",
        // 3000 in + 1500 out at $0.75 / $3.75 per 1M.
        costUsd: "0.007875",
        costSource: "price_table" as const,
        inputTokens: 3000,
        outputTokens: 1500,
        status: "ok" as const,
        outcome: "completed" as const,
      };
      const lost = {
        orgId,
        step: "writer",
        provider: "google" as const,
        modelId: "gemini-3.7-flash",
        costUsd: null,
        costSource: "unknown" as const,
        inputTokens: 0,
        outputTokens: 0,
        status: "errored" as const,
        outcome: "unknown" as const,
      };
      await direct.db.insert(schema.usageLedger).values([priced, lost, lost, lost]);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "atLeast",
        usd: 0.007875,
        unpricedCalls: 3,
      });
    });

    it("still ignores a refusal, so a bad hour cannot stamp ≥ on a lifetime total", async () => {
      // The other half of the same column, and the reason it is three-valued
      // rather than a boolean "did it fail": a 429 or a 500 is a verdict the
      // provider delivered instead of work, and the ledger is lifetime.
      const { agent, orgId } = await orgAgent();
      await direct.db.insert(schema.usageLedger).values([
        {
          orgId,
          step: "writer",
          provider: "google",
          modelId: "gemini-3.7-flash",
          costUsd: "1.230000",
          costSource: "provider_reported",
          inputTokens: 900,
          outputTokens: 120,
          status: "ok",
          outcome: "completed",
        },
        {
          orgId,
          step: "writer",
          provider: "google",
          modelId: "gemini-3.7-flash",
          costUsd: null,
          costSource: "unknown",
          inputTokens: 0,
          outputTokens: 0,
          status: "errored",
          outcome: "refused",
        },
      ]);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 1.23,
      });
    });

    it("reads a row written before the outcome column as one that came back", async () => {
      // NULL means "nobody recorded this", not "unknown outcome". `NULL =
      // 'unknown'` is NULL rather than false, which happens to fall out right
      // where the predicate sits today — inside an OR under an AND — and would
      // stop doing so the moment it were negated or moved. `is not distinct
      // from` is two-valued wherever it stands; this test pins the answer, not
      // the spelling.
      const { agent, orgId } = await orgAgent();
      await direct.db.insert(schema.usageLedger).values([
        {
          orgId,
          step: "writer",
          provider: "google",
          modelId: "gemini-3.7-flash",
          costUsd: "1.230000",
          costSource: "provider_reported",
          inputTokens: 900,
          outputTokens: 120,
          status: "ok",
          outcome: null,
        },
        {
          orgId,
          step: "writer",
          provider: "google",
          modelId: "gemini-3.7-flash",
          costUsd: null,
          costSource: "unknown",
          inputTokens: 0,
          outputTokens: 0,
          status: "errored",
          outcome: null,
        },
      ]);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 1.23,
      });
    });

    /**
     * The seam this finding came from, closed by comparison rather than by
     * discipline.
     *
     * `costTotals()` and this SQL aggregate implement one rule twice. The rule
     * that was missing from BOTH was added to both; nothing but a test that
     * runs the same rows through each of them can say they still agree.
     */
    it("gives the same answer as costTotals() over the same rows", async () => {
      const { agent, orgId } = await orgAgent();
      const rows: CostRow[] = [
        {
          costUsd: 0.002,
          costSource: "price_table",
          inputTokens: 900,
          outputTokens: 120,
          outcome: "completed",
        },
        {
          costUsd: 0.5,
          costSource: "provider_reported",
          inputTokens: 10,
          outputTokens: 2,
          outcome: "completed",
        },
        {
          costUsd: null,
          costSource: "unknown",
          inputTokens: 700,
          outputTokens: 0,
          outcome: "completed",
        },
        {
          costUsd: null,
          costSource: "unknown",
          inputTokens: 0,
          outputTokens: 0,
          outcome: "unknown",
        },
        {
          costUsd: null,
          costSource: "unknown",
          inputTokens: 0,
          outputTokens: 0,
          outcome: "refused",
        },
        { costUsd: null, costSource: "unknown", inputTokens: 0, outputTokens: 0, outcome: null },
      ];
      await direct.db.insert(schema.usageLedger).values(
        rows.map((row, index) => ({
          orgId,
          step: `step-${index}`,
          provider: "google" as const,
          modelId: "gemini-3.7-flash",
          costUsd: row.costUsd === null ? null : row.costUsd.toFixed(6),
          costSource: row.costSource,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          status: "ok" as const,
          outcome: row.outcome,
        })),
      );

      const fromSql = (await agent.get("/api/ai-credentials/spend").expect(200)).body;

      expect(fromSql).toEqual(summarizeCost(costTotals(rows)));
      // Named too, so a day when both readers are wrong in the same way still
      // fails: two unpriced calls — the one that burned tokens and the one we
      // lost — and the refusal and the legacy NULL counted by neither.
      expect(fromSql).toEqual({ kind: "atLeast", usd: 0.502, unpricedCalls: 2 });
    });

    it("refuses an outcome outside the value set, in the database", async () => {
      // The CHECK from migration 0012. A misspelled value would read as
      // `completed` to both readers — silently free — and every set operation
      // in the product is written against the enum.
      const { orgId } = await orgAgent();

      await expect(
        direct.db.execute(
          sql`insert into usage_ledger (org_id, step, provider, model_id, cost_source, status, outcome)
              values (${orgId}, 'writer', 'google', 'gemini-3.7-flash', 'unknown', 'errored', 'unkown')`,
        ),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
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

  /**
   * The CHOICE, which is the half that must not diverge from the worker.
   *
   * `GenerateRepository.credential` answers the same question in the other Nest
   * process, and the only thing keeping the two answers equal is that both sort
   * with `preferredCredential` (`@pubrick/shared`). So the oracle below is that
   * comparator, run over the rows Postgres actually holds — a hardcoded
   * "expect openrouter" would stay green for a repository that had stopped
   * consulting the ordering entirely and simply returned whichever row came
   * back first.
   */
  describe("the credential a provider-less call reaches", () => {
    /** The key stored for `provider`, so a wrong CHOICE cannot look right. */
    function keyFor(provider: AiProviderId) {
      return `${SECRET_KEY}-${provider}`;
    }

    async function storeKey(orgId: string, provider: AiProviderId, createdAt: Date) {
      await direct.db.insert(schema.aiCredentials).values({
        orgId,
        provider,
        credentialsEncrypted: encryptJson(
          { apiKey: keyFor(provider) },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
        defaultModel: `${provider}-default`,
        createdAt,
      });
    }

    /**
     * What the shared rule says about the rows this org has, read back from the DB.
     *
     * Also asserts the answer does not depend on the ORDER the rows arrive in.
     * Neither repository orders its select — an org has at most two rows — so
     * Postgres is free to return them either way (an index scan on
     * `(org_id, provider)` yields provider order; a seq scan yields heap order),
     * and it does not have to make the same choice for both apps. A rule that
     * leaned on row order would leave the api and the worker agreeing by query
     * plan, which is not agreement at all.
     */
    async function ruleSays(orgId: string) {
      const rows = await direct.db
        .select({
          provider: schema.aiCredentials.provider,
          createdAt: schema.aiCredentials.createdAt,
        })
        .from(schema.aiCredentials)
        .where(eq(schema.aiCredentials.orgId, orgId));
      const picked = preferredCredential(rows);
      expect(preferredCredential([...rows].reverse())).toBe(picked);
      return picked;
    }

    it("returns the key the comparator picks — the oldest, not the newest", async () => {
      const { orgId } = await orgAgent();
      // Stored newest-first, so "returns the last row inserted" is a distinct
      // wrong answer from "returns the oldest".
      await storeKey(orgId, "google", new Date("2026-06-01T10:00:00.000Z"));
      await storeKey(orgId, "openrouter", new Date("2026-01-01T10:00:00.000Z"));

      const picked = await ruleSays(orgId);
      expect(picked?.provider).toBe("openrouter");

      const credential = await repo.credential(orgId);
      expect(credential?.provider).toBe(picked?.provider);
      // The chosen ROW was decrypted, not merely its provider name reported.
      expect(credential?.apiKey).toBe(keyFor("openrouter"));
      expect(credential?.defaultModel).toBe("openrouter-default");
    });

    it("breaks a tie exactly where the comparator does", async () => {
      const { orgId } = await orgAgent();
      // One instant for both rows: only the provider tie-break can decide, and
      // it is the branch a `created_at`-only ordering would leave to the planner.
      const sameInstant = new Date("2026-03-03T12:00:00.000Z");
      await storeKey(orgId, "openrouter", sameInstant);
      await storeKey(orgId, "google", sameInstant);

      const picked = await ruleSays(orgId);
      expect(picked?.provider).toBe("google");

      const credential = await repo.credential(orgId);
      expect(credential?.provider).toBe(picked?.provider);
      expect(credential?.apiKey).toBe(keyFor("google"));
    });

    it("yields undefined for an org with no key, rather than a 404", async () => {
      const { orgId } = await orgAgent();
      expect(await ruleSays(orgId)).toBeUndefined();
      // The worker's contract: "this org has no key" is an answer the caller
      // renders, not an exception. `getDecrypted` still throws for a NAMED
      // provider, because that is a request for a resource that is not there.
      await expect(repo.credential(orgId)).resolves.toBeUndefined();
      await expect(repo.getDecrypted(orgId, "google")).rejects.toThrow();
    });

    it("never reaches another org's key", async () => {
      const a = await orgAgent();
      const b = await orgAgent();
      await storeKey(a.orgId, "google", new Date("2026-01-01T10:00:00.000Z"));
      await storeKey(b.orgId, "openrouter", new Date("2025-01-01T10:00:00.000Z"));

      // b's key is older than a's; an unscoped select would hand a the wrong org's.
      expect((await repo.credential(a.orgId))?.apiKey).toBe(keyFor("google"));
      expect((await repo.credential(b.orgId))?.apiKey).toBe(keyFor("openrouter"));
    });
  });
});
