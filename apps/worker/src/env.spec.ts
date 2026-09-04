import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * BOOT, as an observable event — the worker's half.
 *
 * The worker decrypts the same rows the api does, so it validates the same key
 * RING at start-up for the same reason: a typo in the second key must be a
 * refusal to start, not a credential that silently cannot be read months later,
 * on the day a pre-rotation row is finally published. That promise was made
 * only by the docstring. Replacing the refinement's body with `return true`
 * survived this package's whole suite.
 *
 * The seam is the import: `env.ts`'s contract IS its module evaluation, so
 * `vi.resetModules()` plus a dynamic `import("./env")` against an environment
 * this file controls is a process start, minus the process. Unlike the api,
 * nothing downstream re-splits the value, so a surviving mutant boots silently —
 * which is exactly what the assertions below say cannot happen.
 */

const FRESH_KEYS = [0x11, 0x22].map((byte) => Buffer.alloc(32, byte).toString("base64"));
const RING_REFUSAL = /APP_ENCRYPTION_KEY: APP_ENCRYPTION_KEY must be one or more comma-separated/;

const saved = { ...process.env };

async function boot(ring: string): Promise<Error | null> {
  process.env.DATABASE_URL = "postgres://boot:boot@localhost:5432/boot";
  process.env.APP_ENCRYPTION_KEY = ring;
  vi.resetModules();
  try {
    await import("./env");
    return null;
  } catch (error) {
    return error as Error;
  }
}

const refusal = (error: Error | null): string =>
  error?.message ?? "(the worker booted, raising nothing)";

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
  vi.resetModules();
});

describe("the worker validates the key ring at boot", () => {
  it("starts on a single key, and on a rotated ring", async () => {
    expect(await boot(FRESH_KEYS[0] as string)).toBeNull();
    expect(await boot(`${FRESH_KEYS[0]},${FRESH_KEYS[1]}`)).toBeNull();
  });

  it("refuses to start when the SECOND key is a typo, naming that variable", async () => {
    const error = await boot(`${FRESH_KEYS[0]},dG9vLXNob3J0`);
    expect(refusal(error)).toMatch(/^Invalid environment:/);
    expect(refusal(error)).toMatch(RING_REFUSAL);
    expect(refusal(error)).not.toMatch(/DATABASE_URL|TELEGRAM_API_BASE_URL/);
  });

  it("refuses every shape parseKeyRing refuses", async () => {
    for (const ring of [
      "",
      "   ",
      "dG9vLXNob3J0",
      `dG9vLXNob3J0,${FRESH_KEYS[0]}`,
      `${FRESH_KEYS[0]},${FRESH_KEYS[0]}`,
    ]) {
      const error = await boot(ring);
      expect(refusal(error), `ring ${JSON.stringify(ring)}`).toMatch(/^Invalid environment:/);
      expect(refusal(error), `ring ${JSON.stringify(ring)}`).toMatch(RING_REFUSAL);
    }
  });
});
