import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

/**
 * One collection endpoint, and everything this file needs to prove it is
 * tenant-scoped.
 *
 * `seed` creates ONE row of the collection for the caller and reports back both
 * the value that identifies it in the response and every URL that lists it —
 * query-parameter branches included. A filtered branch is a SECOND copy of the
 * tenancy predicate in the query builder, and a test that only ever sends the
 * bare path proves nothing about it: that is exactly how
 * `GET /api/channels?brandId=` came to have a correct org filter that no test
 * observed.
 */
type ListEndpoint = {
  /** The `@Controller("…")` path. The ratchet at the bottom matches on this. */
  controller: string;
  /** Pulls the identifying value out of one row of the response. */
  identify: (row: Record<string, unknown>) => string;
  seed: (agent: request.Agent) => Promise<Seeded>;
};

type Seeded = {
  /** What `identify` will return for the row this seed just created. */
  id: string;
  /** Every list URL that must contain it — one per branch of the query. */
  paths: string[];
};

/**
 * Endpoints that answer a bare `@Get()` and are NOT a tenant collection.
 * Keyed by controller path, valued by the reason, because "no test" and "no
 * test needed" have to look different to the next reader.
 */
const NOT_A_TENANT_LIST: Record<string, string> = {
  health: "anonymous liveness probe; returns a status and a version, never a row",
};

async function orgAgent(app: INestApplication): Promise<request.Agent> {
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
  return agent;
}

async function brandWithChannel(agent: request.Agent) {
  const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
  const channel = await agent
    .post("/api/channels")
    .send({
      brandId: brand.body.id,
      platform: "telegram",
      name: "Main",
      credentials: { botToken: "123:abc", chatId: "-1001234567890" },
    })
    .expect(201);
  return { brandId: brand.body.id as string, channelId: channel.body.id as string };
}

const id = (row: Record<string, unknown>) => row.id as string;

const LIST_ENDPOINTS: ListEndpoint[] = [
  {
    controller: "brands",
    identify: id,
    seed: async (agent) => {
      const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
      return { id: brand.body.id as string, paths: ["/api/brands"] };
    },
  },
  {
    controller: "channels",
    identify: id,
    seed: async (agent) => {
      const { brandId, channelId } = await brandWithChannel(agent);
      // Both branches. The brand-filtered one is the URL the channels screen
      // actually loads, and it carries an id the OTHER org can guess at.
      return { id: channelId, paths: ["/api/channels", `/api/channels?brandId=${brandId}`] };
    },
  },
  {
    controller: "content",
    identify: id,
    seed: async (agent) => {
      const { brandId, channelId } = await brandWithChannel(agent);
      const item = await agent
        .post("/api/content")
        .send({ brandId, body: "Mine.", channelIds: [channelId] })
        .expect(201);
      return { id: item.body.id as string, paths: ["/api/content", "/api/content?status=draft"] };
    },
  },
  {
    controller: "runs",
    identify: id,
    seed: async (agent) => {
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await agent
        .post("/api/runs")
        .send({ brandId, brief: "Write about our new release", channelIds: [channelId] })
        .expect(201);
      return { id: run.body.id as string, paths: ["/api/runs", "/api/runs?state=open"] };
    },
  },
  {
    controller: "ai-credentials",
    // `provider` is the resource's key and both orgs store the same one, so it
    // cannot tell two orgs' rows apart. `defaultModel` is free text and unique
    // per seed here, which is what makes "does not contain theirs" mean anything.
    identify: (row) => row.defaultModel as string,
    seed: async (agent) => {
      const model = `model-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      await agent
        .put("/api/ai-credentials")
        .send({ provider: "google", apiKey: "sk-test-key-0123456789", defaultModel: model })
        .expect(200);
      return { id: model, paths: ["/api/ai-credentials"] };
    },
  },
];

describe.skipIf(!url)("every list endpoint returns only this org's rows", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts.
    const { AppModule } = await import("./app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    // Listen for the whole file: supertest otherwise starts the server per
    // request and closes it when that request ends, killing any other request
    // in flight (see content.e2e.spec.ts for the measurement).
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  for (const endpoint of LIST_ENDPOINTS) {
    it(`${endpoint.controller}: mine on every branch, and never theirs`, async () => {
      const stranger = await orgAgent(app);
      const mine = await endpoint.seed(stranger);
      const owner = await orgAgent(app);
      const theirs = await endpoint.seed(owner);

      // Asserted POSITIVELY: the stranger has a row of its own on every branch,
      // so an endpoint that answered `[]` to everything — a broken query, a
      // filter on the wrong column — cannot pass for correct scoping.
      for (const path of mine.paths) {
        const listed = (await stranger.get(path).expect(200)).body as Record<string, unknown>[];
        expect(listed.map(endpoint.identify)).toEqual([mine.id]);
      }

      // And the same request the OWNER makes, made by the stranger. For a
      // parameterised branch this is a different URL carrying the owner's ids,
      // which is the only way to reach that branch's copy of the predicate: the
      // stranger asking with its OWN parameters would be filtered correctly by
      // the parameter alone and prove nothing.
      for (const path of theirs.paths) {
        const listed = (await stranger.get(path).expect(200)).body as Record<string, unknown>[];
        expect(listed.map(endpoint.identify)).not.toContain(theirs.id);
      }
    });
  }
});

/**
 * The ratchet, and the reason this file is a table rather than five tests
 * written out longhand.
 *
 * Every finding above was of one shape: a filter that was present, correct, and
 * observed by nothing. The tests answer today's instances; this answers the
 * next one, by making a collection endpoint that nobody scoped a FAILING BUILD
 * rather than a quiet omission. It runs without a database, so it fails in the
 * same second as a typo.
 */
describe("no collection endpoint ships without a scoping test", () => {
  const controllersRoot = join(process.cwd(), "src");

  function controllerFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return controllerFiles(path);
      return entry.endsWith(".controller.ts") ? [path] : [];
    });
  }

  it("finds the controllers at all — a scan that matches nothing is a green light for anything", () => {
    // Without this the whole ratchet degrades to `[] ⊆ registry` the first time
    // the layout or the working directory moves, and reports success forever.
    expect(controllerFiles(controllersRoot).length).toBeGreaterThanOrEqual(5);
  });

  it("has a table entry (or a written reason) for every bare @Get()", () => {
    const registered = new Set(LIST_ENDPOINTS.map((endpoint) => endpoint.controller));
    const unscoped: string[] = [];

    for (const file of controllerFiles(controllersRoot)) {
      const source = readFileSync(file, "utf8");
      // A bare `@Get()` is the collection route; `@Get(":id")` and `@Get("spend")`
      // address a single thing and are pinned by their own 404 tests.
      if (!/@Get\(\)/.test(source)) continue;
      const path = /@Controller\("([^"]+)"\)/.exec(source)?.[1];
      if (path === undefined) throw new Error(`${file} has a @Get() but no @Controller("…") path`);
      if (registered.has(path) || path in NOT_A_TENANT_LIST) continue;
      unscoped.push(path);
    }

    expect(
      unscoped,
      `These controllers list rows and no test proves the list is scoped to one org: ${unscoped.join(", ")}. ` +
        "Add an entry to LIST_ENDPOINTS in this file (a seed that creates one row and names every branch's URL), " +
        "or, if the endpoint returns nothing tenant-owned, say so in NOT_A_TENANT_LIST with a reason.",
    ).toEqual([]);
  });
});
