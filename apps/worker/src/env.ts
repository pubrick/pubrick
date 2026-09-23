import {
  PUBLISH_ABANDONED_AFTER_SECONDS,
  PUBLISH_MAX_LATENESS_HOURS_DEFAULT,
  PUBLISH_QUEUE_OPTIONS,
  parseEnv,
  parseKeyRing,
  worstCaseSelfInflictedSeconds,
} from "@pubrick/shared";
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
  VK_API_BASE_URL: z.string().default("https://api.vk.com/method"),
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
   * with nothing anywhere saying so). "Effectively unbounded" is spelled `8760`
   * — one year — and is still a finite number the comparison can hold, which is
   * what `.finite()` below refuses `Infinity` for.
   *
   * THE FLOOR IS DERIVED AND IT IS ENFORCED HERE, not described in a paragraph.
   * `packages/shared/src/jobs.test.ts` pins the queue's worst case against the
   * DEFAULT, so tuning `retryLimit` past the bound is a red test — but that
   * assertion knows nothing about the number a deployment actually sets, and an
   * operator who sets `0.5` gets a bound INSIDE the queue's own retry chain:
   * a post that merely exhausted its retries is then recorded
   * `schedule_missed`, having sent nothing, which is the injury this whole
   * branch exists to prevent. So the refinement below recomputes the same sum
   * from the same exported constants — `worstCaseSelfInflictedSeconds(
   * PUBLISH_QUEUE_OPTIONS) + PUBLISH_ABANDONED_AFTER_SECONDS`, 7 020 s ≈ 1.95 h
   * today — and refuses anything at or under it at BOOT. `.env.example` and
   * `docs/self-hosting.md` quote the derived number rather than a round one, so
   * that the document and the schema cannot drift apart.
   *
   * NOT PER-ORG, yet: no settings table or column exists, so per-org means a
   * table, a repository, a route, a screen and an org-scoped read on the
   * worker's hot path. This is forward-compatible with all of that.
   */
  PUBLISH_MAX_LATENESS_HOURS: z.coerce
    .number()
    .finite()
    .max(8760)
    // The floor, and the only check on this variable that is not a plain range:
    // it is a SUM of two queue constants, so it moves when the queue is tuned
    // and a literal minimum here would be a copy that silently stops matching.
    .superRefine((hours, ctx) => {
      const floorSeconds =
        worstCaseSelfInflictedSeconds(PUBLISH_QUEUE_OPTIONS) + PUBLISH_ABANDONED_AFTER_SECONDS;
      if (hours * 3600 > floorSeconds) return;
      ctx.addIssue({
        code: "custom",
        message:
          `PUBLISH_MAX_LATENESS_HOURS must be above ${(floorSeconds / 3600).toFixed(2)} h — the ` +
          "queue's whole retry chain plus the sweep that ends an abandoned attempt, every " +
          "second of which one post can legitimately spend with nothing wrong. A bound at or " +
          "under that floor fails posts that were merely retried. There is no off switch; " +
          '"effectively never" is 8760',
      });
    })
    .default(PUBLISH_MAX_LATENESS_HOURS_DEFAULT),
});
