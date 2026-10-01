import { PUBLIC_WRITE_OPERATIONS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { enumCheck } from "./enum-check.js";

/** Lifetime replay audit. Result/key UUIDs are immutable audit values, not nullable foreign keys. */
export const publicApiOperations = pgTable(
  "public_api_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    operation: text("operation", { enum: PUBLIC_WRITE_OPERATIONS }).notNull(),
    keyId: uuid("key_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    hashVersion: text("hash_version").notNull(),
    resultId: uuid("result_id").notNull(),
    consentVersion: text("consent_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("public_api_operations_replay_idx").on(t.orgId, t.operation, t.idempotencyKey),
    index("public_api_operations_org_id_idx").on(t.orgId),
    enumCheck("public_api_operations_operation_check", t.operation, PUBLIC_WRITE_OPERATIONS),
    check(
      "public_api_operations_idempotency_key_check",
      sql`${t.idempotencyKey} ~ '^[A-Za-z0-9._-]{8,128}$'`,
    ),
    check("public_api_operations_request_hash_check", sql`${t.requestHash} ~ '^[a-f0-9]{64}$'`),
    check("public_api_operations_hash_version_check", sql`${t.hashVersion} = 'parsed-dto-v1'`),
    check(
      "public_api_operations_consent_check",
      sql`(${t.operation} = 'content:create' AND ${t.consentVersion} IS NULL) OR (${t.operation} = 'generation:create' AND ${t.consentVersion} IS NOT NULL AND ${t.consentVersion} = 'byok-paid-generation-v1')`,
    ),
  ],
);

/** Pinned RateLimiterPostgres INSERT omits a column list. Never add/reorder columns. */
export const apiRequestLimits = pgTable(
  "api_request_limits",
  {
    key: varchar("key", { length: 255 }).primaryKey(),
    points: integer("points").notNull().default(0),
    expire: bigint("expire", { mode: "number" }),
  },
  (t) => [index("api_request_limits_expire_key_idx").on(t.expire, t.key)],
);
