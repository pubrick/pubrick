import {
  PUBLISH_ABANDONED_AFTER_SECONDS,
  PUBLISH_QUEUE_OPTIONS,
  worstCaseSelfInflictedSeconds,
} from "@pubrick/shared";
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

async function boot(ring: string, lateness?: string): Promise<Error | null> {
  process.env.DATABASE_URL = "postgres://boot:boot@localhost:5432/boot";
  process.env.APP_ENCRYPTION_KEY = ring;
  if (lateness === undefined) delete process.env.PUBLISH_MAX_LATENESS_HOURS;
  else process.env.PUBLISH_MAX_LATENESS_HOURS = lateness;
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
  it("validates the optional Google forward proxy without exposing its credential", async () => {
    process.env.GOOGLE_API_PROXY = "http://user:pass@proxy.example:8080";
    expect(await boot(FRESH_KEYS[0] as string)).toBeNull();
    process.env.GOOGLE_API_PROXY = "http://user:secret@proxy.example:8080/path";
    const error = await boot(FRESH_KEYS[0] as string);
    expect(refusal(error)).toContain("GOOGLE_API_PROXY must be an http(s) proxy URL");
    expect(refusal(error)).not.toContain("secret");
  });

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

/**
 * THE FLOOR UNDER `PUBLISH_MAX_LATENESS_HOURS`, at the one place an operator
 * can break it.
 *
 * `packages/shared/src/jobs.test.ts` asserts the floor against the DEFAULT, so
 * a queue tuned past the bound is a red test. It cannot say anything about the
 * value a deployment actually sets, and that is the door the injury walks back
 * in through: at `PUBLISH_MAX_LATENESS_HOURS=0.5` a post that merely exhausted
 * the queue's retry chain — which the same test asserts can legitimately burn
 * 1.95 h — is recorded `schedule_missed`, having sent nothing. So the floor is
 * checked HERE too, against the same exported constants, and the refusal is a
 * boot failure exactly like the key ring's above.
 */
const FLOOR_SECONDS =
  worstCaseSelfInflictedSeconds(PUBLISH_QUEUE_OPTIONS) + PUBLISH_ABANDONED_AFTER_SECONDS;
const FLOOR_HOURS = FLOOR_SECONDS / 3600;
/**
 * Derived from the same constants the schema reads, not from the 1.95 they
 * happen to sum to today — a literal here would go red on the queue tuning that
 * `jobs.test.ts` already governs. What pins the arithmetic itself is that file.
 */
const FLOOR_REFUSAL = new RegExp(
  `PUBLISH_MAX_LATENESS_HOURS: .*${FLOOR_HOURS.toFixed(2).replace(".", "\\.")} h`,
);

describe("the worker refuses a staleness bound its own retries can reach", () => {
  it("starts on the default, and on any value clear of the floor", async () => {
    expect(await boot(FRESH_KEYS[0] as string)).toBeNull();
    expect(await boot(FRESH_KEYS[0] as string, "6")).toBeNull();
    expect(await boot(FRESH_KEYS[0] as string, String(FLOOR_HOURS + 0.01))).toBeNull();
    expect(await boot(FRESH_KEYS[0] as string, "8760")).toBeNull();
  });

  it("refuses the value the documents used to invite, naming the floor in hours", async () => {
    const error = await boot(FRESH_KEYS[0] as string, "0.5");
    expect(refusal(error)).toMatch(/^Invalid environment:/);
    expect(refusal(error)).toMatch(FLOOR_REFUSAL);
    expect(refusal(error)).not.toMatch(/APP_ENCRYPTION_KEY|DATABASE_URL/);
  });

  /**
   * The bound is the number a post is compared against, so a bound EQUAL to the
   * worst case is already too low: `>` is inclusive of the bound at
   * `publish.service.ts`, and a chain that spends exactly the worst case would
   * survive only by a rounding accident.
   */
  it("refuses the floor itself, and admits the first value above it", async () => {
    expect(refusal(await boot(FRESH_KEYS[0] as string, String(FLOOR_HOURS)))).toMatch(
      FLOOR_REFUSAL,
    );
    expect(await boot(FRESH_KEYS[0] as string, String(FLOOR_HOURS + 1e-6))).toBeNull();
  });

  it("refuses every fail-open spelling of no bound at all", async () => {
    for (const value of ["0", "-1", "0.25", "1.9"]) {
      const error = await boot(FRESH_KEYS[0] as string, value);
      expect(refusal(error), `bound ${value}`).toMatch(FLOOR_REFUSAL);
    }
  });
});
