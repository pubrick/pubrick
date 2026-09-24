import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { publications } from "./content-items.js";
import { enumCheck } from "./enum-check.js";

export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    endpointEncrypted: text("endpoint_encrypted").notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    onSucceeded: boolean("on_succeeded").notNull().default(true),
    onFailed: boolean("on_failed").notNull().default(true),
    onUnknown: boolean("on_unknown").notNull().default(true),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_subscriptions_org_idx").on(t.orgId),
    check("webhook_subscriptions_name_check", sql`char_length(${t.name}) between 1 and 80`),
    check(
      "webhook_subscriptions_endpoint_check",
      sql`char_length(${t.endpointEncrypted}) between 1 and 4096`,
    ),
  ],
);

/** Immutable publication event and a bounded, durable delivery state. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    publicationId: uuid("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    event: text("event", {
      enum: ["publication.succeeded", "publication.failed", "publication.unknown"],
    }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["pending", "attempting", "sent", "failed", "unknown"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastHttpStatus: integer("last_http_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_event_idx").on(t.subscriptionId, t.publicationId, t.event),
    index("webhook_deliveries_pending_idx").on(t.status, t.nextAttemptAt),
    check(
      "webhook_deliveries_event_check",
      sql`${t.event} in ('publication.succeeded', 'publication.failed', 'publication.unknown')`,
    ),
    enumCheck("webhook_deliveries_status_check", t.status, [
      "pending",
      "attempting",
      "sent",
      "failed",
      "unknown",
    ] as const),
    check("webhook_deliveries_attempts_check", sql`${t.attempts} between 0 and 5`),
  ],
);
