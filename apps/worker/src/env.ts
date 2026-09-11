import { PUBLISH_MAX_LATENESS_HOURS_DEFAULT, parseEnv, parseKeyRing } from "@pubrick/shared";
import { z } from "zod";

export const env = parseEnv({
  DATABASE_URL: z.string().min(1),
  /**
   * The credential key ring, active key first — the api's variable, validated
   * the same way here because the worker decrypts the same rows. Fail at boot,
   * not at the first publish; see `apps/api/src/env.ts` for the ring's shape.
   */
  APP_ENCRYPTION_KEY: z.string().refine((v) => {
    try {
      parseKeyRing(v);
      return true;
    } catch {
      return false;
    }
  }, "APP_ENCRYPTION_KEY must be one or more comma-separated base64 keys, each decoding to exactly 32 bytes, newest first"),
  TELEGRAM_API_BASE_URL: z.string().default("https://api.telegram.org"),
  /**
   * HOW LATE A SCHEDULED POST MAY STILL GO OUT, in hours. Beyond it the
   * delivery is `failed` with `failure_reason = 'schedule_missed'` having sent
   * nothing, and the screen's existing "Publish now" is the way to send it
   * anyway.
   *
   * A WORKER VARIABLE, and only a worker one: the web paints an overdue row
   * from `scheduled_at < now()`, which needs no bound. It is declared here —
   * rather than read at the first publish — so a typo is a refusal to start,
   * the same promise `APP_ENCRYPTION_KEY` above makes.
   *
   * NO OFF SWITCH, deliberately. A fail-open `0` would restore exactly the
   * silence this bound exists to end (a post from yesterday going out today
   * with nothing anywhere saying so), and `Infinity` would reach Postgres's
   * `make_interval` as a runtime surprise that "fails at boot" does not cover.
   * "Effectively unbounded" is spelled `8760` — one year — and is still a
   * number the comparison can hold. The floor is not arbitrary either: fifteen
   * minutes is already under the queue's own worst-case retry chain
   * (`worstCaseSelfInflictedSeconds`), so anything lower would fail posts that
   * were merely retried, and `docs/self-hosting.md` says so where an operator
   * will read it.
   *
   * NOT PER-ORG, yet: no settings table or column exists, so per-org means a
   * table, a repository, a route, a screen and an org-scoped read on the
   * worker's hot path. This is forward-compatible with all of that.
   */
  PUBLISH_MAX_LATENESS_HOURS: z.coerce
    .number()
    .finite()
    .min(0.25)
    .max(8760)
    .default(PUBLISH_MAX_LATENESS_HOURS_DEFAULT),
});
