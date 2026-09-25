import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  encryptJson,
  type SearchCredentialPublic,
  type SearchCredentialUpsert,
} from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

const PUBLIC_COLUMNS = {
  folderId: schema.searchCredentials.folderId,
  updatedAt: schema.searchCredentials.updatedAt,
};

@Injectable()
export class SearchCredentialsRepository {
  async get(orgId: string): Promise<SearchCredentialPublic> {
    const [row] = await db
      .select(PUBLIC_COLUMNS)
      .from(schema.searchCredentials)
      .where(eq(schema.searchCredentials.orgId, orgId))
      .limit(1);
    return row
      ? { configured: true, folderId: row.folderId, updatedAt: row.updatedAt.toISOString() }
      : { configured: false, folderId: null, updatedAt: null };
  }

  async upsert(orgId: string, data: SearchCredentialUpsert): Promise<SearchCredentialPublic> {
    const credentialsEncrypted = encryptJson({ apiKey: data.apiKey }, env.APP_ENCRYPTION_KEY);
    const [row] = await db
      .insert(schema.searchCredentials)
      .values({ orgId, folderId: data.folderId, credentialsEncrypted })
      .onConflictDoUpdate({
        target: schema.searchCredentials.orgId,
        set: { folderId: data.folderId, credentialsEncrypted },
      })
      .returning(PUBLIC_COLUMNS);
    if (!row) throw new Error("Search credential upsert returned no row");
    return { configured: true, folderId: row.folderId, updatedAt: row.updatedAt.toISOString() };
  }

  async delete(orgId: string): Promise<{ deleted: boolean }> {
    const deleted = await db
      .delete(schema.searchCredentials)
      .where(eq(schema.searchCredentials.orgId, orgId))
      .returning({ orgId: schema.searchCredentials.orgId });
    return { deleted: deleted.length > 0 };
  }
}
