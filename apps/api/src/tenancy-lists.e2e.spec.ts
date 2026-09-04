import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import ts from "typescript";
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
 *
 * Below sits a SECOND, broader property over the same controllers: not just
 * "does the list have a scoping test", but "does every route — list, get-one,
 * write, whatever verb — actually carry the guard that makes org scoping
 * possible at all". They share one AST walk (`parseController`) rather than
 * each re-deriving "what is a route" from the source text in its own way —
 * that duplication is exactly how a scanner drifts from what it claims to
 * cover. The two properties stay separate assertions because they check
 * different things: the first is about the QUERY (does the filter exist and
 * get exercised), the second is about the GUARD (does `orgId` even reach the
 * request in the first place, which is the precondition for the first
 * property meaning anything).
 */

const controllersRoot = join(process.cwd(), "src");

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return entry.endsWith(".controller.ts") ? [path] : [];
  });
}

/** HTTP-verb decorators that mark a class method as a route handler. */
const HTTP_VERBS = new Set(["Get", "Post", "Put", "Patch", "Delete", "All", "Options", "Head"]);

type DecoratorInfo = { name: string; args: readonly ts.Expression[] };

/** A decorator's name and call arguments — `@Foo` and `@Foo()` both resolve, with
 *  an empty argument list for the bare form. Anything more exotic (a decorator
 *  expression that isn't a plain identifier, called or not) resolves to null and
 *  is refused by the caller rather than silently skipped. */
function decoratorInfo(decorator: ts.Decorator): DecoratorInfo | null {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return { name: expression.expression.text, args: expression.arguments };
  }
  if (ts.isIdentifier(expression)) return { name: expression.text, args: [] };
  return null;
}

/** Every decorator on a class or method declaration, resolved via decoratorInfo.
 *  `null` entries (an unresolvable decorator expression) are kept as nulls so a
 *  caller that needs to notice them can, rather than the list just being shorter. */
function decorators(node: ts.ClassDeclaration | ts.MethodDeclaration): (DecoratorInfo | null)[] {
  const list = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  return (list ?? []).map(decoratorInfo);
}

function hasGuard(infos: (DecoratorInfo | null)[], guardName: string): boolean {
  return infos.some(
    (d) =>
      d?.name === "UseGuards" &&
      d.args.some((arg) => ts.isIdentifier(arg) && arg.text === guardName),
  );
}

function has(infos: (DecoratorInfo | null)[], name: string): boolean {
  return infos.some((d) => d?.name === name);
}

/** The literal string argument of the first decorator named `name`, if there is
 *  exactly one such argument and it is a plain string literal. `undefined` means
 *  the decorator is absent; `null` means it is present but not in that shape
 *  (a computed path, no argument where one is required) — the two are kept
 *  distinct so a caller can refuse the second instead of reading it as the first. */
function literalArg(infos: (DecoratorInfo | null)[], name: string): string | null | undefined {
  const found = infos.find((d): d is DecoratorInfo => d !== null && d.name === name);
  if (found === undefined) return undefined;
  if (found.args.length === 0) return null;
  const [arg] = found.args;
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

type Route = {
  methodName: string;
  verb: string;
  /** `@Get()` with no argument — the collection route, per LIST_ENDPOINTS above. */
  bare: boolean;
  guarded: boolean;
  anonymous: boolean;
};

type ParsedController = {
  file: string;
  path: string;
  classGuarded: boolean;
  classAnonymous: boolean;
  /** Set by `@NotOrgScoped("reason")`; null when the decorator is absent. */
  notOrgScopedReason: string | null;
  routes: Route[];
};

type ControllerProblem = { file: string; reason: string };

/** Parses one `*.controller.ts` file into its route shape, or explains why it
 *  couldn't — fail-closed, same reason as db-tier.guard.spec.ts: a file this
 *  cannot read is a failure here, not a silent absence from either scan below. */
function parseController(
  file: string,
):
  | { controller: ParsedController; problem?: undefined }
  | { controller?: undefined; problem: ControllerProblem } {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseErrors =
    (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseErrors[0]) {
    return { problem: { file, reason: "does not parse, so nothing about it can be checked" } };
  }

  // A controller file may also export a helper class alongside the controller
  // (ai-credentials.controller.ts's ParseAiProviderPipe, for one) — the class
  // that carries `@Controller(...)` is the one this scan is about, not "the
  // only class in the file".
  const candidates = source.statements
    .filter(ts.isClassDeclaration)
    .map((candidate) => ({ candidate, infos: decorators(candidate) }))
    .filter(({ infos }) => literalArg(infos, "Controller") !== undefined);
  const only = candidates[0];
  if (!only || candidates.length !== 1) {
    return {
      problem: {
        file,
        reason: `expected exactly one class carrying @Controller(...), found ${candidates.length}`,
      },
    };
  }
  const { candidate: cls, infos: classInfos } = only;
  const path = literalArg(classInfos, "Controller");
  if (path === null || path === undefined) {
    return { problem: { file, reason: "@Controller(...) argument is not a plain string literal" } };
  }

  const notOrgScoped = classInfos.find((d) => d?.name === "NotOrgScoped");
  let notOrgScopedReason: string | null = null;
  if (notOrgScoped) {
    const [arg] = notOrgScoped.args;
    if (!arg || !ts.isStringLiteralLike(arg) || arg.text.trim().length === 0) {
      return {
        problem: { file, reason: "@NotOrgScoped(...) needs a non-empty string literal reason" },
      };
    }
    notOrgScopedReason = arg.text;
  }

  const routes: Route[] = [];
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    const methodInfos = decorators(member);
    const verbInfo = methodInfos.find((d) => d !== null && HTTP_VERBS.has(d.name));
    if (!verbInfo) continue; // not a route handler — a private helper method, most likely
    routes.push({
      methodName: member.name.getText(source),
      verb: verbInfo.name,
      bare: verbInfo.args.length === 0,
      guarded: hasGuard(methodInfos, "ActiveOrgGuard"),
      anonymous: has(methodInfos, "AllowAnonymous"),
    });
  }

  return {
    controller: {
      file,
      path,
      classGuarded: hasGuard(classInfos, "ActiveOrgGuard"),
      classAnonymous: has(classInfos, "AllowAnonymous"),
      notOrgScopedReason,
      routes,
    },
  };
}

function parseAllControllers(): { controllers: ParsedController[]; problems: ControllerProblem[] } {
  const controllers: ParsedController[] = [];
  const problems: ControllerProblem[] = [];
  for (const file of controllerFiles(controllersRoot)) {
    const result = parseController(file);
    if (result.problem) problems.push(result.problem);
    else controllers.push(result.controller);
  }
  return { controllers, problems };
}

describe("no collection endpoint ships without a scoping test", () => {
  it("finds the controllers at all — a scan that matches nothing is a green light for anything", () => {
    // Without this the whole ratchet degrades to `[] ⊆ registry` the first time
    // the layout or the working directory moves, and reports success forever.
    expect(controllerFiles(controllersRoot).length).toBeGreaterThanOrEqual(5);
  });

  it("parses every controller file", () => {
    const { problems } = parseAllControllers();
    expect(
      problems.map((p) => `${p.file}: ${p.reason}`),
      "A controller file this scan cannot parse reads identically to one with nothing to " +
        "report, which is the failure this file exists to remove:",
    ).toEqual([]);
  });

  it("has a table entry (or a written reason) for every bare @Get()", () => {
    const registered = new Set(LIST_ENDPOINTS.map((endpoint) => endpoint.controller));
    const { controllers } = parseAllControllers();
    const unscoped = new Set<string>();

    for (const controller of controllers) {
      // A bare `@Get()` is the collection route; `@Get(":id")` and `@Get("spend")`
      // address a single thing and are pinned by their own 404 tests.
      const hasBareGet = controller.routes.some((route) => route.verb === "Get" && route.bare);
      if (!hasBareGet) continue;
      if (registered.has(controller.path) || controller.path in NOT_A_TENANT_LIST) continue;
      unscoped.add(controller.path);
    }

    expect(
      [...unscoped],
      `These controllers list rows and no test proves the list is scoped to one org: ${[...unscoped].join(", ")}. ` +
        "Add an entry to LIST_ENDPOINTS in this file (a seed that creates one row and names every branch's URL), " +
        "or, if the endpoint returns nothing tenant-owned, say so in NOT_A_TENANT_LIST with a reason.",
    ).toEqual([]);
  });
});

/**
 * The broader property: org isolation does not depend on a developer
 * remembering `@UseGuards(ActiveOrgGuard)` on each new controller. `@OrgId()`
 * already throws loudly when used on an unguarded route (see org-id.decorator.ts)
 * — but only on a route actually exercised, and only if it reads orgId through
 * that decorator at all. A controller that reads orgId some other way, or a
 * write-only controller nobody wrote a request against yet, is caught by
 * nothing at runtime. This is the fail-closed backstop: every route in every
 * controller must be ActiveOrgGuard-protected, explicitly anonymous (no
 * session, so no organization to be active in — `health`, for instance), or
 * carry `@NotOrgScoped("reason")` (`invitations`, for instance — a pre-org
 * state where the concept does not apply). A route with none of the three
 * fails here, by name, rather than by however it happens to misbehave in
 * production.
 */
describe("every org-scoped controller route is protected by the guard", () => {
  it("finds routes to guard — a scan that matches nothing proves nothing below it", () => {
    const { controllers } = parseAllControllers();
    const routeCount = controllers.reduce((total, c) => total + c.routes.length, 0);
    expect(routeCount).toBeGreaterThanOrEqual(10);
  });

  it("guards, excuses anonymously, or excuses by name — every route, no fourth option", () => {
    const { controllers } = parseAllControllers();
    const unprotected: string[] = [];

    for (const controller of controllers) {
      for (const route of controller.routes) {
        const anonymous = controller.classAnonymous || route.anonymous;
        const guarded = controller.classGuarded || route.guarded;
        if (anonymous || guarded || controller.notOrgScopedReason !== null) continue;
        unprotected.push(`${controller.path} ${route.verb.toUpperCase()} ${route.methodName}()`);
      }
    }

    expect(
      unprotected,
      "These routes are reachable by an authenticated caller with no proof that they are " +
        "scoped to an organization: nothing binds them to ActiveOrgGuard, and nothing says " +
        `they legitimately run outside org scope: ${unprotected.join(", ")}. ` +
        "Add `@UseGuards(ActiveOrgGuard)` (class-level, unless only one route needs it), or " +
        "`@AllowAnonymous()` if the route genuinely runs with no session, or " +
        '`@NotOrgScoped("reason")` on the controller if the organization concept does not ' +
        "apply here — see org/not-org-scoped.decorator.ts.",
    ).toEqual([]);
  });
});
