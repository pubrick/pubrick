import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { TELEGRAM_DECISION_LIMITS } from "@pubrick/shared";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";

export const TELEGRAM_RETENTION_ORGS_PER_TICK = 20;
export const TELEGRAM_RETENTION_ROWS_PER_TIER = 100;
const tiers = [
  {
    table: "telegram_binding_challenges",
    clock: "coalesce(terminal_at, expires_at)",
    seconds: TELEGRAM_DECISION_LIMITS.challengeRetentionSeconds,
  },
  {
    table: "telegram_initial_capabilities",
    clock: "coalesce(terminal_at, expires_at)",
    seconds: TELEGRAM_DECISION_LIMITS.capabilityRetentionSeconds,
  },
  {
    table: "telegram_actor_confirmations",
    clock: "coalesce(terminal_at, expires_at)",
    seconds: TELEGRAM_DECISION_LIMITS.capabilityRetentionSeconds,
  },
  {
    table: "telegram_update_receipts",
    clock: "accepted_at",
    seconds: TELEGRAM_DECISION_LIMITS.replayRetentionSeconds,
  },
] as const;
type Tier = (typeof tiers)[number];
function eligible(tier: Tier) {
  return sql`${sql.raw(tier.clock)} < clock_timestamp() - ${tier.seconds} * interval '1 second'`;
}

@Injectable()
export class TelegramRetentionRepository {
  private candidateCursor: string | null = null;
  async candidates(): Promise<string[]> {
    // Lock the organization before applying the bound: locked parents cannot
    // monopolize all twenty slots. EXISTS avoids truncating other tenants behind
    // one tenant's large backlog. Advance a cyclic cursor even if later batches
    // fail, so continuously failing parents cannot starve other organizations.
    // This short transaction locks no child records.
    const overdue = tiers.map(
      (tier) => sql`EXISTS (SELECT 1 FROM ${sql.raw(tier.table)} AS retained
      WHERE retained.org_id = org.id AND ${eligible(tier)})`,
    );
    return db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const result = await tx.execute(sql`SELECT org.id FROM organization AS org
        WHERE ${sql.join(overdue, sql` OR `)}
        ORDER BY CASE WHEN ${this.candidateCursor}::text IS NULL OR org.id > ${this.candidateCursor}::text THEN 0 ELSE 1 END, org.id
        LIMIT ${TELEGRAM_RETENTION_ORGS_PER_TICK} FOR UPDATE OF org SKIP LOCKED`);
      const ids = result.rows.map((row) => row.id as string);
      this.candidateCursor = ids.at(-1) ?? null;
      return ids;
    });
  }

  async sweepOrg(orgId: string): Promise<number> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("update", { skipLocked: true });
      if (!org) return 0;
      // Read candidates without child locks, then acquire every required registry
      // parent first. At most four tiers * 100 rows can contribute registry IDs.
      const plans: { tier: Tier; ids: string[] }[] = [];
      const registryIds = new Set<string>();
      for (const tier of tiers) {
        const candidates =
          await tx.execute(sql`SELECT id, bot_identity_id FROM ${sql.raw(tier.table)}
          WHERE org_id = ${orgId} AND ${eligible(tier)} ORDER BY ${sql.raw(tier.clock)}, id LIMIT ${TELEGRAM_RETENTION_ROWS_PER_TIER}`);
        const ids = candidates.rows.map((row) => row.id as string);
        for (const row of candidates.rows) registryIds.add(row.bot_identity_id as string);
        plans.push({ tier, ids });
      }
      if (registryIds.size)
        await tx
          .select({ id: schema.telegramBotIdentities.id })
          .from(schema.telegramBotIdentities)
          .where(inArray(schema.telegramBotIdentities.id, [...registryIds]))
          .orderBy(
            sql`length(${schema.telegramBotIdentities.botId})`,
            asc(schema.telegramBotIdentities.botId),
          )
          .for("update");
      let deleted = 0;
      // Fixed record order: challenges, (bindings preserved), initial capabilities,
      // actor confirmations, receipts. Audit and all registry/remote claims persist.
      for (const { tier, ids } of plans) {
        if (!ids.length) continue;
        const locked = await tx.execute(sql`SELECT id FROM ${sql.raw(tier.table)}
          WHERE org_id = ${orgId} AND id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          AND ${eligible(tier)} ORDER BY id FOR UPDATE SKIP LOCKED`);
        const lockedIds = locked.rows.map((row) => row.id as string);
        if (!lockedIds.length) continue;
        const removed = await tx.execute(sql`DELETE FROM ${sql.raw(tier.table)}
          WHERE org_id = ${orgId} AND id IN (${sql.join(
            lockedIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) RETURNING id`);
        deleted += removed.rows.length;
      }
      return deleted;
    });
  }
}
