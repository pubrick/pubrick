import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLISHED_DEVELOPMENT_SECRETS } from "./auth-policy";

/**
 * The deployment posture that lives in files no test can import.
 *
 * The security review's first finding was invisible to the suite by construction: the
 * limiter was off in the shipped image because `docker/api.Dockerfile` never said
 * `NODE_ENV=production`, and a Dockerfile has no runtime this suite can question. The
 * only assertion available is to read the file, so that is what this does — for the
 * two images, the compose file, `init.sh` and `.env.example`.
 *
 * `auth.compiled.e2e.spec.ts` covers the other half: the behaviour of the compiled
 * binary under those settings.
 */

/** Vitest's cwd is the package root under both `pnpm --filter …` and turbo. */
function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "turbo.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No turbo.json above ${process.cwd()}`);
    dir = parent;
  }
  return dir;
}

const ROOT = repoRoot();
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

/** The stages of a multi-stage Dockerfile, in order. */
function stages(dockerfile: string): string[] {
  const parts = dockerfile.split(/^FROM /m);
  return parts.slice(1).map((part) => `FROM ${part}`);
}

const NODE_ENV_PRODUCTION = /^ENV\s+NODE_ENV=production\s*$/m;

describe.each(["docker/api.Dockerfile", "docker/worker.Dockerfile"])("%s", (file) => {
  const dockerfile = read(file);

  // Better Auth enables its rate limiter on `NODE_ENV === "production"` and nothing
  // else did: the image ran `node dist/main.js` with NODE_ENV unset, and twelve
  // consecutive wrong-password sign-ins against it returned twelve 401s and no 429.
  // The auth config now states `rateLimit.enabled` outright, but every other library
  // in the image reads this variable too, so the image still has to declare it.
  it("runs the shipped process in production mode", () => {
    const runtime = stages(dockerfile).at(-1) ?? "";
    expect(runtime).toMatch(NODE_ENV_PRODUCTION);
  });

  // In a build stage this would make `pnpm install --frozen-lockfile` skip
  // devDependencies, and the image would fail to build rather than fail quietly —
  // but it would take a rebuild to find out. Pin it instead.
  it("does not set production mode in a build stage", () => {
    for (const stage of stages(dockerfile).slice(0, -1)) {
      expect(stage).not.toMatch(NODE_ENV_PRODUCTION);
    }
  });
});

describe("docker-compose.yml", () => {
  const compose = read("docker-compose.yml");

  // `${VAR:-fallback}` starts; `${VAR:?message}` refuses. The three variables that
  // decide whether an install is safe must all be in the second group: an unset
  // PUBLIC_ORIGIN used to fall back to localhost, which serves cookies without
  // `Secure` and rejects the real origin with a 403 instead of naming the problem.
  it.each(["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "PUBLIC_ORIGIN"])(
    "requires %s rather than defaulting it",
    (name) => {
      const interpolations = [...compose.matchAll(new RegExp(`\\$\\{${name}([:}][^}]*)?\\}`, "g"))];
      expect(interpolations.length).toBeGreaterThan(0);
      for (const [interpolation] of interpolations) {
        expect(interpolation).toMatch(new RegExp(`^\\$\\{${name}:\\?`));
      }
    },
  );

  it("gives the api the same public origin for its base URL and its trusted origin", () => {
    for (const key of ["BETTER_AUTH_URL", "WEB_ORIGIN"]) {
      expect(compose).toMatch(new RegExp(`^\\s*${key}: "\\$\\{PUBLIC_ORIGIN:\\?`, "m"));
    }
  });

  it("passes the registration and rate-limit posture through to the api", () => {
    for (const key of ["SIGNUP_MODE", "TRUSTED_PROXIES", "AUTH_RATE_LIMIT_ENABLED"]) {
      expect(compose).toMatch(new RegExp(`^\\s*${key}:`, "m"));
    }
  });

  // Off by accident is the failure this whole finding was about; only an explicit
  // `AUTH_RATE_LIMIT_ENABLED=false` in someone's .env may disable it.
  it("leaves auth rate limiting on unless the operator says otherwise", () => {
    expect(compose).toMatch(/AUTH_RATE_LIMIT_ENABLED: \$\{AUTH_RATE_LIMIT_ENABLED:-true\}/);
  });
});

describe("init.sh", () => {
  // Comment lines are dropped: the file explains the fallback it used to have, and a
  // guard that cannot tell an explanation from an export would forbid saying so.
  const init = read("init.sh")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  // It used to `export BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-dev-only-secret-change-me}`.
  // Compose refused that value; this script, which starts the same apps outside compose,
  // did not.
  it.each(["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY"])(
    "has no published fallback for %s",
    (name) => {
      expect(init).not.toMatch(new RegExp(`\\$\\{${name}:-`));
    },
  );

  it.each(["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY"])(
    "never assigns %s a literal value",
    (name) => {
      // `ensure_env NAME "$(openssl rand -base64 32)"` is the only supported form.
      const assignments = [...init.matchAll(new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`, "gm"))];
      for (const [, value] of assignments) {
        expect(value).toMatch(/\$\(/);
      }
    },
  );

  // The script refuses to run on a .env still holding a placeholder. Every literal it
  // names there has to be one the api also refuses, or the two guards disagree about
  // which values are burnt.
  it("only names placeholders the api itself refuses", () => {
    const block = /case\s+"\$\{!name\}"\s+in([\s\S]*?)esac/.exec(init);
    expect(block, "expected init.sh to keep refusing published placeholders").not.toBeNull();
    const patterns = ((block?.[1] ?? "").split(")")[0] ?? "")
      .split("|")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(PUBLISHED_DEVELOPMENT_SECRETS).toContain(pattern);
    }
  });
});

describe(".env.example", () => {
  const example = read(".env.example");

  /** The value on the first uncommented `NAME=` line, if any. */
  function assigned(name: string): string | undefined {
    return new RegExp(`^${name}=(.*)$`, "m").exec(example)?.[1];
  }

  // Someone will copy this file and fill in only one of the two. The placeholder left
  // behind has to be on the refusal list, or that install boots on a value printed in
  // the repository.
  it.each(["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY"])(
    "ships a placeholder for %s that the api refuses",
    (name) => {
      const value = assigned(name);
      expect(value).toBeDefined();
      expect(PUBLISHED_DEVELOPMENT_SECRETS).toContain(value);
    },
  );

  it("ships PUBLIC_ORIGIN uncommented, since compose now requires it", () => {
    expect(assigned("PUBLIC_ORIGIN")).toBe("http://localhost:3000");
  });

  it("documents the registration posture and the proxy setting", () => {
    for (const name of ["SIGNUP_MODE", "TRUSTED_PROXIES", "AUTH_RATE_LIMIT_ENABLED"]) {
      expect(example).toContain(name);
    }
  });
});
