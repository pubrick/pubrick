import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * BOOT, as an observable event.
 *
 * `env.ts` is a module whose whole contract is a side effect of being imported:
 * it validates `APP_ENCRYPTION_KEY` as a key RING and it refuses to start a
 * production instance on a secret this repository publishes. Both promises were
 * made only by prose. Replacing the ring refinement's body with `return true`,
 * and slicing the ring to its first member before `assertNoPublishedSecrets`,
 * each survived the whole suite — `auth-policy.spec.ts` exercises the predicate
 * with a record it builds itself, so the mapping in `env.ts` was reached by
 * nothing at all.
 *
 * The seam is the import. `vi.resetModules()` plus a dynamic `import("./env")`
 * evaluates the module afresh against an environment this file controls, which
 * is exactly what a process start does — no compiled binary, no child process,
 * no database. (`auth.compiled.e2e.spec.ts` boots `dist/main.js` for the things
 * that are only true of the shipped artefact outside test mode; the two
 * refusals here are decided before Nest is ever constructed, so they do not
 * need it.)
 *
 * Every assertion names the SENTENCE it expects, never merely "it threw". A bad
 * ring throws either way once the refinement is gone — `assertNoPublishedSecrets`
 * re-splits the value a line later and `parseKeyRing` fails there instead — so a
 * bare `.rejects.toThrow()` here would be satisfied by the neighbouring cause
 * and would pin nothing.
 */

/** Not published anywhere; distinct per position so a message can be attributed. */
const FRESH_KEYS = [0x11, 0x22, 0x33].map((byte) => Buffer.alloc(32, byte).toString("base64"));
/** In `PUBLISHED_DEVELOPMENT_SECRETS`: init.sh's historical dev fallback. */
const PUBLISHED_KEY = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
const FRESH_SECRET = "env-spec-secret-8c1d4a7f2b9e";

/** The message `env.ts` attaches to a ring it will not boot on. */
const RING_REFUSAL = /APP_ENCRYPTION_KEY: APP_ENCRYPTION_KEY must be one or more comma-separated/;

const saved = { ...process.env };

/**
 * Evaluates `env.ts` against exactly this environment and reports what boot did.
 *
 * `undefined` in `overrides` means the variable is genuinely unset, which is how
 * an operator's environment is shaped and how `NODE_ENV` has to be expressed:
 * vitest sets it to `test`, and the published-secret guard only fires on
 * `production`.
 */
async function boot(overrides: Record<string, string | undefined>): Promise<Error | null> {
  const applied: Record<string, string | undefined> = {
    DATABASE_URL: "postgres://boot:boot@localhost:5432/boot",
    BETTER_AUTH_SECRET: FRESH_SECRET,
    APP_ENCRYPTION_KEY: FRESH_KEYS[0],
    ...overrides,
  };
  for (const [name, value] of Object.entries(applied)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
  try {
    await import("./env");
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** What boot said, or a sentence saying it said nothing — so a mutant that BOOTS
 *  fails with "(the api booted...)" rather than an assertion-shape complaint. */
const refusal = (error: Error | null): string =>
  error?.message ?? "(the api booted, raising nothing)";

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  vi.resetModules();
});

describe("the key ring is validated at boot", () => {
  it("starts on a single key — every value that has ever been deployed", async () => {
    expect(await boot({ APP_ENCRYPTION_KEY: FRESH_KEYS[0] })).toBeNull();
  });

  it("starts on a rotated ring", async () => {
    expect(await boot({ APP_ENCRYPTION_KEY: `${FRESH_KEYS[0]},${FRESH_KEYS[1]}` })).toBeNull();
  });

  it("refuses to start when the SECOND key is a typo, naming that variable", async () => {
    // The promise the docstring makes: "a typo in the second key is a refusal to
    // start rather than a credential that silently cannot be read months later".
    // The first key is valid and the instance would run perfectly on it — until
    // the day a pre-rotation row is read, which is the day it must not.
    const error = await boot({ APP_ENCRYPTION_KEY: `${FRESH_KEYS[0]},dG9vLXNob3J0` });
    expect(refusal(error)).toMatch(/^Invalid environment:/);
    expect(refusal(error)).toMatch(RING_REFUSAL);
    // Attribution: this variable and no other. A refusal that named DATABASE_URL
    // would satisfy "it threw" and tell the operator to look in the wrong place.
    expect(refusal(error)).not.toMatch(/DATABASE_URL|BETTER_AUTH_SECRET/);
  });

  it("refuses every shape parseKeyRing refuses, at boot rather than at first read", async () => {
    for (const ring of [
      "", // no key at all
      "   ", // whitespace only
      "dG9vLXNob3J0", // one key, not 32 bytes
      `dG9vLXNob3J0,${FRESH_KEYS[0]}`, // the FIRST key is the typo
      `${FRESH_KEYS[0]},${FRESH_KEYS[1]},dG9vLXNob3J0`, // the third
      `${FRESH_KEYS[0]},${FRESH_KEYS[0]}`, // a copy-paste: same key twice
    ]) {
      const error = await boot({ APP_ENCRYPTION_KEY: ring });
      expect(refusal(error), `ring ${JSON.stringify(ring)}`).toMatch(/^Invalid environment:/);
      expect(refusal(error), `ring ${JSON.stringify(ring)}`).toMatch(RING_REFUSAL);
    }
  });
});

describe("a published secret is refused in EVERY ring position", () => {
  // NODE_ENV=production is what the shipped images set and what scopes this
  // guard; dev and this suite legitimately run on known values.
  const production = { NODE_ENV: "production" };

  it("starts in production on fresh values", async () => {
    expect(
      await boot({ ...production, APP_ENCRYPTION_KEY: `${FRESH_KEYS[0]},${FRESH_KEYS[1]}` }),
    ).toBeNull();
  });

  it("refuses the published key in FIRST place", async () => {
    const error = await boot({ ...production, APP_ENCRYPTION_KEY: PUBLISHED_KEY });
    expect(refusal(error)).toContain("Refusing to start: APP_ENCRYPTION_KEY is set to a value");
  });

  it("refuses the published key smuggled into SECOND place by a rotation", async () => {
    // The hole this pins. A rotation puts the new key in front; the value that
    // moves behind it is still exactly as published, and still decrypts every
    // row that has not moved off it yet. Checking the ring's first member — or
    // the raw comma-separated string — sees a fresh key and boots.
    const error = await boot({
      ...production,
      APP_ENCRYPTION_KEY: `${FRESH_KEYS[0]},${PUBLISHED_KEY}`,
    });
    expect(refusal(error)).toContain(
      "Refusing to start: APP_ENCRYPTION_KEY (previous key 1) is set to a value",
    );
    // The refusal is about the ring, not about the other secret in the record.
    expect(refusal(error)).not.toContain("BETTER_AUTH_SECRET");
  });

  it("refuses it in third place too, and names the position", async () => {
    const error = await boot({
      ...production,
      APP_ENCRYPTION_KEY: `${FRESH_KEYS[0]},${FRESH_KEYS[1]},${PUBLISHED_KEY}`,
    });
    expect(refusal(error)).toContain("APP_ENCRYPTION_KEY (previous key 2)");
  });

  it("still names BETTER_AUTH_SECRET, and both at once", async () => {
    const error = await boot({
      ...production,
      BETTER_AUTH_SECRET: "dev-only-secret-change-me",
      APP_ENCRYPTION_KEY: `${FRESH_KEYS[0]},${PUBLISHED_KEY}`,
    });
    expect(refusal(error)).toContain(
      "Refusing to start: BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY (previous key 1) are set",
    );
  });

  it("says nothing outside production, where known values are legitimate", async () => {
    expect(await boot({ NODE_ENV: undefined, APP_ENCRYPTION_KEY: PUBLISHED_KEY })).toBeNull();
    expect(await boot({ NODE_ENV: "test", APP_ENCRYPTION_KEY: PUBLISHED_KEY })).toBeNull();
  });
});
