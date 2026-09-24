import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { type ApiKeyCreate, MAX_ACTIVE_API_KEYS } from "@pubrick/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";

const PUBLIC_COLUMNS = {
  id: schema.organizationApiKeys.id,
  name: schema.organizationApiKeys.name,
  prefix: schema.organizationApiKeys.prefix,
  scope: schema.organizationApiKeys.scope,
  createdAt: schema.organizationApiKeys.createdAt,
  revokedAt: schema.organizationApiKeys.revokedAt,
};

function hashKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/** Only a key's public prefix is indexed. The bearer secret is never stored. */
@Injectable()
export class ApiKeysRepository {
  list(orgId: string) {
    return db
      .select(PUBLIC_COLUMNS)
      .from(schema.organizationApiKeys)
      .where(eq(schema.organizationApiKeys.orgId, orgId))
      .orderBy(
        sql`${schema.organizationApiKeys.createdAt} DESC`,
        sql`${schema.organizationApiKeys.id} DESC`,
      );
  }

  async create(orgId: string, userId: string, input: ApiKeyCreate) {
    // The lock serializes the per-org count even when two admins create keys at
    // once. A single active-key limit bounds both forgotten secrets and table
    // growth; revoked rows remain as an audit trail.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.organizationApiKeys)
        .where(
          and(
            eq(schema.organizationApiKeys.orgId, orgId),
            isNull(schema.organizationApiKeys.revokedAt),
          ),
        );
      if (count >= MAX_ACTIVE_API_KEYS) {
        throw new ConflictException("Active API key limit reached");
      }
      const prefix = randomBytes(12).toString("hex");
      const key = `pbrk_${prefix}_${randomBytes(32).toString("base64url")}`;
      const [created] = await tx
        .insert(schema.organizationApiKeys)
        .values({
          orgId,
          createdBy: userId,
          name: input.name,
          scope: input.scope,
          prefix,
          keyHash: hashKey(key).toString("hex"),
        })
        .returning(PUBLIC_COLUMNS);
      if (!created) throw new Error("API key creation returned no row");
      return { ...created, key };
    });
  }

  async revoke(orgId: string, id: string): Promise<void> {
    const [revoked] = await db
      .update(schema.organizationApiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.organizationApiKeys.orgId, orgId),
          eq(schema.organizationApiKeys.id, id),
          isNull(schema.organizationApiKeys.revokedAt),
        ),
      )
      .returning({ id: schema.organizationApiKeys.id });
    if (!revoked) throw new ConflictException("API key is unavailable");
  }

  /** Authentication has no org id yet; the indexed prefix is the lookup boundary. */
  async authenticate(key: string, scope: string): Promise<string | null> {
    const match = /^pbrk_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/.exec(key);
    if (!match) return null;
    const prefix = match[1];
    if (!prefix) return null;
    const [row] = await db
      .select({
        orgId: schema.organizationApiKeys.orgId,
        keyHash: schema.organizationApiKeys.keyHash,
        scope: schema.organizationApiKeys.scope,
      })
      .from(schema.organizationApiKeys)
      .where(
        and(
          eq(schema.organizationApiKeys.prefix, prefix),
          isNull(schema.organizationApiKeys.revokedAt),
        ),
      )
      .limit(1);
    if (!row || row.scope !== scope || !/^[a-f0-9]{64}$/.test(row.keyHash)) return null;
    if (!timingSafeEqual(hashKey(key), Buffer.from(row.keyHash, "hex"))) return null;
    return row.orgId;
  }
}
