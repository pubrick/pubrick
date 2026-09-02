import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

/**
 * The auth posture of the SHIPPED artefact, exercised outside test mode.
 *
 * Every other spec in this package runs under `NODE_ENV=test`, and better-auth reads
 * that: `skipOriginCheck` becomes true and `rateLimit.enabled` defaults to false. So
 * the suite was structurally unable to see either the missing origin check or the
 * missing limiter — the security review found the second by hand, by running
 * `node dist/main.js` with compose's environment and counting statuses.
 *
 * This file automates exactly that. It builds the api, boots the compiled entry point
 * in a child process with `NODE_ENV=production`, and asserts against the running
 * binary. It is the only place where a change to `advanced.disableOriginCheck`, to
 * `rateLimit.enabled`, or to the trusted-proxy wiring can be caught, because it is the
 * only place those settings are in their production state.
 */

const API_DIR = path.resolve(process.cwd());

/** A distinct, freshly generated pair — the api refuses published values in production. */
const SECRETS = {
  BETTER_AUTH_SECRET: "compiled-spec-secret-4f2a9c1d8e7b6a5f",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Api = {
  /** Where to send requests (127.0.0.1, so no DNS is involved). */
  origin: string;
  /** The origin the api trusts — deliberately NOT the one above, so a request that
   *  forgets to send it is refused rather than silently accepted. */
  trustedOrigin: string;
  stop: () => void;
  output: () => string;
};

/**
 * Boots `dist/main.js` with compose's environment. `env` is the COMPLETE environment
 * (plus PATH/HOME), so a variable the test does not name is genuinely unset — which is
 * the point: the defaults under test are the ones an operator gets.
 *
 * NODE_ENV is deliberately left unset unless a test asks for it. That is the exact
 * shape the review measured — `node dist/main.js` with compose's env and nothing
 * else — and it is what makes these assertions a test of the auth config rather than
 * of the Dockerfile line that now also sets NODE_ENV. (`auth-deployment.spec.ts` pins
 * that line separately.) Unset is still outside test mode, so better-auth's origin
 * check is live here.
 */
async function bootApi(
  extra: Record<string, string> = {},
  options: { expectExit?: boolean; attempt?: number } = {},
): Promise<Api & { exited: boolean; exitCode: number | null }> {
  const { expectExit = false, attempt = 1 } = options;
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["dist/main.js"], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: url as string,
      API_PORT: String(port),
      BETTER_AUTH_URL: `http://localhost:${port}`,
      WEB_ORIGIN: `http://localhost:${port}`,
      ...SECRETS,
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  // "close", not "exit": close fires once the stdio streams are drained too, so a test
  // that reads `output()` after this loop sees the child's whole message. Waiting on
  // "exit" raced the last stderr chunk and made the refusal assertion flaky.
  let exited = false;
  let exitCode: number | null = null;
  child.on("close", (code) => {
    exited = true;
    exitCode = code;
  });
  let healthy = false;
  while (Date.now() < deadline && !exited) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        healthy = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // A boot that never answered is retried on a fresh port before it is reported: the
  // port is picked by binding, closing and handing the number to a child, so under a
  // loaded machine another process can take it in between and the child dies on
  // EADDRINUSE. Reporting instead of retrying turned that into six unrelated-looking
  // ECONNREFUSED failures with the child's own explanation thrown away.
  if (!healthy && !expectExit) {
    child.kill("SIGKILL");
    if (attempt < 3) return bootApi(extra, { expectExit, attempt: attempt + 1 });
    throw new Error(
      `Compiled api did not come up on ${origin} after ${attempt} attempts (exit ${exitCode}):\n${output}`,
    );
  }

  return {
    origin,
    trustedOrigin: `http://localhost:${port}`,
    exited,
    exitCode,
    stop: () => child.kill("SIGKILL"),
    output: () => output,
  };
}

/** Fires `count` POSTs at one auth path and returns the statuses, in order. */
async function fire(
  api: Api,
  pathname: string,
  count: number,
  headers: (index: number) => Record<string, string> = () => ({}),
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const response = await fetch(`${api.origin}/api/auth${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: api.trustedOrigin,
        ...headers(i),
      },
      body: JSON.stringify({
        email: "nobody-compiled-spec@example.com",
        password: "wrong-password-1234",
        newPassword: "wrong-password-5678",
      }),
    });
    statuses.push(response.status);
  }
  return statuses;
}

const tally = (statuses: number[]): Record<number, number> =>
  statuses.reduce<Record<number, number>>((acc, status) => {
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

describe.skipIf(!url)("compiled api, outside test mode", () => {
  // `turbo run test` only builds this package's DEPENDENCIES (`dependsOn: ["^build"]`),
  // and a dist left over from an earlier checkout would make every assertion below a
  // statement about code that is no longer in src. Always rebuild.
  beforeAll(() => {
    execFileSync("pnpm", ["exec", "nest", "build"], { cwd: API_DIR, stdio: "pipe" });
  }, 300_000);

  describe("shipped defaults", () => {
    let api: Api;

    beforeAll(async () => {
      // No SIGNUP_MODE, no TRUSTED_PROXIES, no AUTH_RATE_LIMIT_ENABLED: exactly what
      // an operator gets from `docker compose up` with only the required variables set.
      api = await bootApi();
    }, 120_000);

    afterAll(() => api?.stop());

    // The review's own probe, with the environment it used: twelve 401s and no 429
    // before, because better-auth defaults `rateLimit.enabled` to `isProduction` and
    // nothing set NODE_ENV. Now three attempts pass (better-auth's built-in 3-per-10s
    // rule for sign-in) and the remaining nine are refused — with NODE_ENV STILL unset,
    // which is what "stated in the config, not inherited from the environment" means.
    it("rate limits twelve consecutive wrong-password sign-ins", async () => {
      const statuses = await fire(api, "/sign-in/email", 12);
      expect(tally(statuses)).toEqual({ 401: 3, 429: 9 });
    });

    // With no TRUSTED_PROXIES declared, X-Forwarded-For is not read at all, so rotating
    // it cannot mint a fresh bucket per request. Believing it by default is what made
    // the limiter free to bypass: twelve forged addresses, zero 429s.
    it("does not let a forged X-Forwarded-For escape the limit", async () => {
      const statuses = await fire(api, "/change-password", 12, (i) => ({
        "x-forwarded-for": `203.0.113.${i + 1}`,
      }));
      expect(tally(statuses)[429]).toBeGreaterThan(0);
    });
  });

  // Its own boot: the origin check is asserted on /sign-in/email, and a request that
  // shares that path with the twelve-sign-in probe would also share its rate-limit
  // bucket. (Sign-up would be the more natural subject, but `hooks.before` runs ahead
  // of the origin check, so on an instance with accounts the registration gate answers
  // first — a refusal either way, but not the one under test here.)
  describe("origin check", () => {
    let api: Api;

    beforeAll(async () => {
      api = await bootApi();
    }, 120_000);

    afterAll(() => api?.stop());

    // Under NODE_ENV=test better-auth sets skipOriginCheck, so no other spec in this
    // package can observe this at all. If someone sets `advanced.disableOriginCheck` —
    // or the process starts identifying as test again — this is the check that notices.
    it("refuses an auth POST from a foreign origin", async () => {
      const response = await fetch(`${api.origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ email: "foreign@example.com", password: "password1234" }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "INVALID_ORIGIN" });
    });

    it("accepts the same POST from the origin it was configured with", async () => {
      const response = await fetch(`${api.origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: api.trustedOrigin },
        body: JSON.stringify({ email: "foreign@example.com", password: "password1234" }),
      });
      // Wrong credentials, but it got past the origin check — which is the point.
      expect(response.status).toBe(401);
    });
  });

  describe("with a trusted proxy declared", () => {
    let api: Api;
    const PROXY = "10.1.2.3";

    beforeAll(async () => {
      api = await bootApi({ TRUSTED_PROXIES: PROXY });
    }, 120_000);

    afterAll(() => api?.stop());

    // The chain is walked from the right past the declared hop, so each real client
    // gets its own bucket. Drop `trustedProxies` from the config and a two-entry header
    // resolves to no IP at all, collapsing these twelve into one shared bucket — which
    // is what makes this a test of the wiring and not just of the header name.
    it("keys twelve different clients behind the proxy separately", async () => {
      const statuses = await fire(api, "/sign-in/email", 12, (i) => ({
        "x-forwarded-for": `203.0.113.${i + 1}, ${PROXY}`,
      }));
      expect(tally(statuses)).toEqual({ 401: 12 });
    });

    it("still limits one client behind the proxy", async () => {
      const statuses = await fire(api, "/sign-in/email", 12, () => ({
        "x-forwarded-for": `198.51.100.7, ${PROXY}`,
      }));
      expect(tally(statuses)).toEqual({ 401: 3, 429: 9 });
    });
  });

  // The guard in env.ts, at its call site rather than as a unit test of the predicate.
  // This is the one test that needs NODE_ENV=production: the refusal is scoped to it,
  // because dev and the suite legitimately run on known values.
  it("refuses to start in production on a secret published in this repository", async () => {
    const api = await bootApi(
      { NODE_ENV: "production", BETTER_AUTH_SECRET: "dev-only-secret-change-me" },
      { expectExit: true },
    );
    try {
      expect(api.exited).toBe(true);
      expect(api.exitCode).not.toBe(0);
      expect(api.output()).toContain("Refusing to start: BETTER_AUTH_SECRET");
    } finally {
      api.stop();
    }
  }, 120_000);
});
