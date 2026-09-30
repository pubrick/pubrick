import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "../db";

export type MediaCleanupErrorCode =
  | "asset_exists"
  | "lease_exhausted"
  | "permission"
  | "storage_unavailable"
  | "invalid_path";
export type MediaCleanupClaim = {
  assetId: string;
  orgId: string;
  kind: "image" | "video";
  attempts: number;
  leaseToken: string;
};
const work = schema.mediaCleanupWork;
const columns = {
  assetId: work.assetId,
  orgId: work.orgId,
  kind: work.kind,
  attempts: work.attempts,
};
const MAX_ATTEMPTS = 8;
const LEASE_MS = 60_000;
@Injectable()
export class MediaCleanupRepository {
  /** Row leases commit before the service touches disk; no tenant locks needed. */
  async claim(now = new Date()): Promise<MediaCleanupClaim[]> {
    return db.transaction(async (tx) => {
      const candidates = await tx
        .select(columns)
        .from(work)
        .where(
          and(
            eq(work.state, "pending"),
            lte(work.nextAttemptAt, now),
            or(isNull(work.leaseUntil), lte(work.leaseUntil, now)),
          ),
        )
        .orderBy(asc(work.nextAttemptAt), asc(work.assetId))
        .limit(25)
        .for("update", { skipLocked: true });
      const claims: MediaCleanupClaim[] = [];
      for (const candidate of candidates) {
        const [asset] = await tx
          .select({ id: schema.mediaAssets.id })
          .from(schema.mediaAssets)
          .where(eq(schema.mediaAssets.id, candidate.assetId))
          .limit(1);
        if (asset || candidate.attempts >= MAX_ATTEMPTS) {
          await tx
            .update(work)
            .set({
              state: "operator_action",
              leaseUntil: null,
              leaseToken: null,
              lastError: asset ? "asset_exists" : "lease_exhausted",
            })
            .where(eq(work.assetId, candidate.assetId));
          continue;
        }
        const leaseToken = randomUUID();
        const attempts = candidate.attempts + 1;
        await tx
          .update(work)
          .set({ attempts, leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS) })
          .where(eq(work.assetId, candidate.assetId));
        claims.push({ ...candidate, attempts, leaseToken });
      }
      return claims;
    });
  }
  async complete(claim: MediaCleanupClaim, now = new Date()): Promise<boolean> {
    const rows = await db
      .update(work)
      .set({
        state: "completed",
        completedAt: now,
        leaseUntil: null,
        leaseToken: null,
        lastError: null,
      })
      .where(
        and(
          eq(work.assetId, claim.assetId),
          eq(work.state, "pending"),
          eq(work.leaseToken, claim.leaseToken),
        ),
      )
      .returning({ assetId: work.assetId });
    return rows.length === 1;
  }
  async fail(
    claim: MediaCleanupClaim,
    code: MediaCleanupErrorCode,
    now = new Date(),
  ): Promise<boolean> {
    const terminal = code === "invalid_path" || claim.attempts >= MAX_ATTEMPTS;
    const delay = Math.min(3600_000, 10_000 * 2 ** (claim.attempts - 1));
    const rows = await db
      .update(work)
      .set({
        state: terminal ? "operator_action" : "pending",
        nextAttemptAt: new Date(now.getTime() + delay),
        leaseUntil: null,
        leaseToken: null,
        lastError: code,
      })
      .where(
        and(
          eq(work.assetId, claim.assetId),
          eq(work.state, "pending"),
          eq(work.leaseToken, claim.leaseToken),
        ),
      )
      .returning({ assetId: work.assetId });
    return rows.length === 1;
  }
  async prune(now = new Date()): Promise<number> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ assetId: work.assetId })
        .from(work)
        .where(
          and(
            eq(work.state, "completed"),
            lt(work.completedAt, new Date(now.getTime() - 7 * 86400_000)),
          ),
        )
        .orderBy(asc(work.completedAt), asc(work.assetId))
        .limit(25)
        .for("update", { skipLocked: true });
      for (const row of rows) await tx.delete(work).where(eq(work.assetId, row.assetId));
      return rows.length;
    });
  }
}
