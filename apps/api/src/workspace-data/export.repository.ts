import {
  ForbiddenException,
  Injectable,
  type OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createDb, schema } from "@pubrick/db";
import { isOrganizationManager } from "@pubrick/shared";
import { getTableColumns, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import QueryStream from "pg-query-stream";
import { env } from "../env";
import { WORKSPACE_EXPORT_TABLES } from "./export-policy";

export type ExportTable = (typeof WORKSPACE_EXPORT_TABLES)[number];
export interface ExportSnapshot {
  signal: AbortSignal;
  organization: { id: string; name: string; slug: string; createdAt: Date };
  members: () => AsyncIterable<Record<string, unknown>>;
  capturedAt: Date;
  rows: (policy: ExportTable) => AsyncIterable<Record<string, unknown>>;
}

@Injectable()
export class WorkspaceExportRepository implements OnModuleDestroy {
  // Exports cannot consume every authentication/domain connection. A stalled
  // connection attempt also has a native pg timeout, before snapshot admission.
  private readonly connection = createDb(env.DATABASE_URL, {
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000,
  });
  constructor() {
    // pg hands checked-out errors to the client and idle errors to its pool.
    // Neither may become an unhandled process error during a server restart.
    this.connection.pool.on("error", () => undefined);
  }
  async onModuleDestroy(): Promise<void> {
    await this.connection.pool.end();
  }
  /** A database snapshot; secrets and global authentication tables have no reader. */
  async withSnapshot<T>(
    orgId: string,
    userId: string,
    inputSignal: AbortSignal,
    consume: (snapshot: ExportSnapshot) => Promise<T>,
  ): Promise<T> {
    const client = await this.connection.pool.connect();
    const storageFailure = new AbortController();
    const storageError = () =>
      storageFailure.abort(new Error("Workspace export storage unavailable."));
    client.on("error", storageError);
    const signal = AbortSignal.any([inputSignal, storageFailure.signal]);
    const dialect = new PgDialect();
    let committed = false;
    let begun = false;
    try {
      signal.throwIfAborted();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      begun = true;
      await client.query("SET LOCAL statement_timeout = '15s'");
      // Local archive assembly can keep the snapshot idle while a media file is
      // compressed. Its AbortSignal ends preparation first, at five minutes.
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '330s'");
      const authorization = dialect.sqlToQuery(sql`
        SELECT m.role, o.id, o.name, o.slug, o.created_at AS "createdAt",
          transaction_timestamp() AS "capturedAt"
        FROM ${schema.organization} o JOIN ${schema.member} m ON m.organization_id = o.id
        WHERE o.id = ${orgId} AND m.user_id = ${userId}`);
      const access = await client.query<{
        role: string;
        id: string;
        name: string;
        slug: string;
        createdAt: Date;
        capturedAt: Date;
      }>(authorization.sql, authorization.params);
      const owner = access.rows[0];
      if (!owner || !isOrganizationManager(owner.role))
        throw new ForbiddenException("Only workspace owners and administrators can export data.");
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [`pubrick:workspace-export:${orgId}`],
      );
      if (!lock.rows[0]?.acquired)
        throw new ServiceUnavailableException("An export for this workspace is already running.");
      const streamRows = async function* (query: { sql: string; params: unknown[] }) {
        signal.throwIfAborted();
        const cursor = client.query(new QueryStream(query.sql, query.params, { batchSize: 100 }));
        const abort = () => cursor.destroy(new Error("Workspace export cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        try {
          for await (const row of cursor) {
            signal.throwIfAborted();
            yield row as Record<string, unknown>;
          }
        } finally {
          signal.removeEventListener("abort", abort);
          cursor.destroy();
        }
      };
      const membersQuery = dialect.sqlToQuery(sql`
        SELECT user_id AS "userId", role, created_at AS "createdAt"
        FROM ${schema.member} WHERE organization_id = ${orgId} ORDER BY id`);
      const result = await consume({
        signal,
        organization: {
          id: owner.id,
          name: owner.name,
          slug: owner.slug,
          createdAt: owner.createdAt,
        },
        members: () => streamRows(membersQuery),
        capturedAt: owner.capturedAt,
        rows: async function* (policy) {
          signal.throwIfAborted();
          const columns = getTableColumns(policy.table);
          const selection = policy.fields.map((field) => {
            const column = columns[field as keyof typeof columns];
            if (!column) throw new Error("Unsupported workspace export column.");
            return sql`${column} AS ${sql.identifier(field)}`;
          });
          const query = dialect.sqlToQuery(sql`
            SELECT ${sql.join(selection, sql`, `)} FROM ${policy.table}
            WHERE ${policy.table.orgId} = ${orgId}`);
          yield* streamRows(query);
        },
      });
      signal.throwIfAborted();
      await client.query("COMMIT");
      committed = true;
      return result;
    } finally {
      if (begun && !committed) await client.query("ROLLBACK").catch(() => undefined);
      client.removeListener("error", storageError);
      client.release(storageFailure.signal.aborted);
    }
  }
}
